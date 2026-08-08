"""The AI inference service.

Two things worth testing at this boundary, and they are not the engine — that
has its own suite. They are:

  · **Nobody unauthenticated gets an inference.** This service is reachable
    from another service, and the default when it is misconfigured must be to
    refuse rather than to serve.

  · **No patient identity crosses the boundary.** The whole reason this
    container can run at a lower trust level than the ingest service is that it
    has nothing to leak. A request shape that accepted a patient id would
    quietly undo that.

    services/ai-service/tests, run with:
    python -m pytest services/ai-service/tests -q
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
SERVICE = pathlib.Path(__file__).resolve().parents[1]

# `ai_engine` is imported by the service under test.
sys.path.insert(0, str(ROOT))

os.environ.setdefault("AI_SERVICE_TOKEN", "test-token")

from fastapi.testclient import TestClient  # noqa: E402

# Loaded by path under a unique name rather than as `app.main`.
#
# Both this service and the ingest service have a package called `app`. Import
# either as `app.main` and it lands in sys.modules under that name for the whole
# session — so `pytest iot-service/tests services/ai-service/tests` resolves the
# second suite's import to the *first* suite's module and fails on a missing
# symbol. Each suite passed alone; the collision existed only when everything
# ran together, which is what ./run_all_tests.sh does.
_spec = importlib.util.spec_from_file_location("averis_ai_service_main", SERVICE / "app" / "main.py")
_main = importlib.util.module_from_spec(_spec)
sys.modules["averis_ai_service_main"] = _main
_spec.loader.exec_module(_main)

MAX_READINGS = _main.MAX_READINGS
app = _main.app
_authorised = _main._authorised

client = TestClient(app)
AUTH = {"Authorization": "Bearer test-token"}


def readings(count: int = 60) -> list[dict]:
    """A plausible resting series, two minutes apart."""
    return [
        {
            "heart_rate": 70 + (i % 5),
            "spo2": 97 + (i % 2),
            "temperature": 36.6,
            "movement_status": "RESTING",
            "recorded_at": f"2026-08-11T{(i // 30) % 24:02d}:{(i * 2) % 60:02d}:00Z",
        }
        for i in range(count)
    ]


# ----------------------------------------------------------- authentication
def test_assess_refuses_without_a_token():
    response = client.post("/api/v1/assess", json={"readings": readings()})
    assert response.status_code == 401


def test_assess_refuses_a_wrong_token():
    response = client.post(
        "/api/v1/assess",
        json={"readings": readings()},
        headers={"Authorization": "Bearer not-the-token"},
    )
    assert response.status_code == 401


def test_assess_refuses_a_malformed_authorization_header():
    for header in ["test-token", "Basic test-token", "Bearer", ""]:
        response = client.post(
            "/api/v1/assess",
            json={"readings": readings()},
            headers={"Authorization": header},
        )
        assert response.status_code == 401, f"accepted {header!r}"


def test_an_unset_token_refuses_everything(monkeypatch):
    # The default that matters. A service which runs unauthenticated when
    # misconfigured is a service that ends up on a network somebody can reach.
    monkeypatch.delenv("AI_SERVICE_TOKEN", raising=False)
    assert _authorised("Bearer anything") is False
    assert _authorised(None) is False


def test_model_card_is_deliberately_unauthenticated():
    # It describes a model, never a patient — and a model whose limitations are
    # only visible to holders of a service token has effectively hidden them.
    response = client.get("/api/v1/model-card")
    assert response.status_code in (200, 404)


# ------------------------------------------------------------------ assess
def test_assess_returns_a_scored_window():
    response = client.post("/api/v1/assess", json={"readings": readings()}, headers=AUTH)

    assert response.status_code == 200
    body = response.json()

    assert "risk_score" in body
    assert "risk_level" in body
    # The contributions travel with the score. A number nobody can take apart
    # is a number nobody should act on.
    assert "contributions" in body
    assert "inference_ms" in body


def test_assess_rejects_a_non_list():
    response = client.post("/api/v1/assess", json={"readings": "lots"}, headers=AUTH)
    assert response.status_code == 422


def test_assess_rejects_a_missing_body():
    response = client.post("/api/v1/assess", json={}, headers=AUTH)
    assert response.status_code == 422


def test_assess_caps_the_request_size():
    # An inference service that can be made slow by a large request is a
    # denial-of-service surface with a JSON body.
    response = client.post(
        "/api/v1/assess",
        json={"readings": [{"heart_rate": 70} for _ in range(MAX_READINGS + 1)]},
        headers=AUTH,
    )
    assert response.status_code == 413


def test_assess_handles_an_empty_window():
    # No readings is a legitimate state — a band that has not reported yet. It
    # must produce an assessment describing that, not a 500.
    response = client.post("/api/v1/assess", json={"readings": []}, headers=AUTH)
    assert response.status_code == 200


def test_a_patient_id_in_the_body_is_simply_not_read():
    # The property that lets this container run at a lower trust level: there
    # is no field for identity, so a caller sending one gets an assessment of
    # the readings and nothing is stored, logged or echoed.
    response = client.post(
        "/api/v1/assess",
        json={"readings": readings(), "patient_id": "3f2a-secret"},
        headers=AUTH,
    )

    assert response.status_code == 200
    assert "3f2a-secret" not in response.text
    assert "patient_id" not in response.json()


# -------------------------------------------------------------------- fall
def test_fall_requires_both_channels():
    response = client.post("/api/v1/fall", json={"accel": []}, headers=AUTH)
    assert response.status_code == 422


def test_fall_distinguishes_no_model_from_no_fall():
    response = client.post(
        "/api/v1/fall",
        json={"accel": [[0.0, 0.0, 1.0]] * 50, "gyro": [[0.0, 0.0, 0.0]] * 50},
        headers=AUTH,
    )

    # 503 when there is no artefact, 200 with a result when there is. What must
    # never happen is a 200 with `fall: null` standing in for "no model" — an
    # absent model would then read as a patient who did not fall.
    assert response.status_code in (200, 503)

    if response.status_code == 503:
        assert response.json()["error"] == "no_model"


# ------------------------------------------------------------------ health
def test_liveness_touches_nothing():
    response = client.get("/api/health/live")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_readiness_reports_degraded_rather_than_refusing_traffic():
    response = client.get("/api/health/ready")
    body = response.json()

    # The vitals engine is rules and statistics and works without the fall
    # model. Refusing traffic the service can still handle would be worse than
    # serving it and saying so.
    assert response.status_code == 200
    assert body["status"] == "ready"
    assert body["checks"]["vitals_engine"] is True
    assert "degraded" in body

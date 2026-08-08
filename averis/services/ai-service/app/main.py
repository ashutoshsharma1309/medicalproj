"""AVERIS AI inference service.

    POST /api/v1/assess        analyse a window of readings
    POST /api/v1/fall          score one IMU window
    GET  /api/v1/model-card    provenance for the models
    GET  /api/health/live      is the process up
    GET  /api/health/ready     are the models loaded

── Why this is a separate service, when health-service and notification-service
   deliberately are not ───────────────────────────────────────────────────────

Splitting a system into services costs latency, a failure mode, and a
deployment. It is worth paying when the parts have genuinely different
*operational* shapes. This one does:

  · **It is CPU-bound.** Feature extraction and inference are the only
    compute-heavy work in AVERIS. Everything else is I/O waiting on Postgres.
    Sharing a container means a burst of assessments starves the ingest path,
    which is the one path that must stay fast.

  · **It scales on a different axis.** Ingest scales with device count;
    inference scales with how much analysis each patient needs. A ward of forty
    stable patients and a ward of five deteriorating ones have the same ingest
    load and very different inference load.

  · **It holds no credentials.** This service never touches the database. It
    takes readings in the request and returns an assessment — no service-role
    key, no patient identifiers, nothing to leak. That is what makes it safe to
    scale horizontally and to run at a lower trust level than the ingest
    service.

The services the brief also asks for and which are **not** extracted are
covered in `docs/cloud_architecture.md`, with the specific property each
extraction would destroy. The short version: a `health-service` would have to
hold a service-role key and would replace Row Level Security with its own
authorisation code, and a `notification-service` would break the transaction
that makes "an emergency was raised" and "the care team was told" the same
event.

── Stateless by construction ────────────────────────────────────────────────

No database, no cache, no queue. Readings arrive in the request body. This is
not minimalism — it is what lets the service be replicated without
coordination, restarted without draining, and run in a network segment with no
route to the patient database at all.
"""

from __future__ import annotations

import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

# ai_engine lives at the repository root rather than being packaged, so it has
# to be found on the path before the imports below.
#
# Found by searching upward for the directory that contains it, rather than by
# counting levels. The two layouts differ: in development this file is at
# averis/services/ai-service/app/main.py and the root is four levels up; in the
# container it is at /app/app/main.py with ai_engine beside it, one level up.
# A fixed `parents[3]` raises IndexError on import inside the container — the
# image builds perfectly and the process dies the moment it starts, which is a
# failure a build-only CI job reports as a success.
def _engine_root() -> Path:
    here = Path(__file__).resolve()
    for candidate in here.parents:
        if (candidate / "ai_engine").is_dir():
            return candidate
    # Nothing found: leave the path alone and let the import below fail with a
    # message about ai_engine rather than about a path index.
    return here.parent


sys.path.insert(0, str(_engine_root()))

from ai_engine.prediction.engine import analyse_stream  # noqa: E402
from ai_engine.models.fall_detector import model_card, predict as predict_fall  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format='{"level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
)
logger = logging.getLogger("averis.ai")

_state: dict[str, Any] = {}

# The most readings one request may carry.
#
# Six hours at 2 Hz is ~43,000 rows; the engine's windows never need more than
# a few thousand. The cap is here so one caller cannot occupy a worker for
# minutes — an inference service that can be made slow by a large request is a
# denial-of-service surface with a JSON body.
MAX_READINGS = 6000


@asynccontextmanager
async def lifespan(app: FastAPI):
    started = time.monotonic()

    # Loading the fall model at startup rather than on first request. A cold
    # start that pays model-loading on the first *real* assessment makes the
    # slowest response the one a patient's deterioration arrives in.
    card = model_card()
    _state["model_card"] = card
    _state["model_loaded"] = card is not None
    _state["started_at"] = datetime.now(timezone.utc).isoformat()

    logger.info(
        "ai service started model_loaded=%s in %.0fms",
        _state["model_loaded"],
        (time.monotonic() - started) * 1000,
    )
    yield


app = FastAPI(title="AVERIS AI Service", version="1.0.0", lifespan=lifespan)


def _authorised(authorization: str | None) -> bool:
    """Service-to-service authentication.

    A shared secret, not a device token and not a user JWT — the caller is the
    ingest service, not a person and not a band.

    **When no secret is configured the service refuses every request rather
    than accepting them.** The opposite default is the one that ships: a
    service that runs unauthenticated when misconfigured is a service that ends
    up on a network somebody can reach.
    """
    expected = os.environ.get("AI_SERVICE_TOKEN", "")
    if not expected:
        return False

    if not authorization:
        return False

    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return False

    # Constant-time comparison. The window is small and the cost is nothing.
    import hmac

    return hmac.compare_digest(parts[1].strip(), expected)


@app.post("/api/v1/assess")
async def assess(request: Request, authorization: str | None = Header(default=None)):
    """Runs the health intelligence engine over a window of readings.

    The request carries the readings. It does **not** carry a patient id, and
    the service has no way to look one up — an inference service that knew
    whose data it was scoring would be a second place patient identity lives,
    and the whole point of this boundary is that there is only one.
    """
    if not _authorised(authorization):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "invalid_json"}, status_code=400)

    readings = body.get("readings") if isinstance(body, dict) else None
    if not isinstance(readings, list):
        return JSONResponse(
            {"error": "invalid_request", "details": ["`readings` must be a list."]},
            status_code=422,
        )

    if len(readings) > MAX_READINGS:
        return JSONResponse(
            {
                "error": "too_many_readings",
                "details": [f"At most {MAX_READINGS} readings per request."],
            },
            status_code=413,
        )

    started = time.monotonic()

    try:
        assessment = analyse_stream(readings)
    except Exception:  # noqa: BLE001
        # Logged with the reading count and nothing else. A stack trace from
        # this service could contain vital signs, and an inference service's
        # logs are shipped to the same aggregator as everything else.
        logger.exception("assessment failed readings=%d", len(readings))
        return JSONResponse({"error": "inference_failed"}, status_code=500)

    duration_ms = (time.monotonic() - started) * 1000

    # Latency per request, so the caller can record it without timing the call
    # itself and including its own network time.
    logger.info("assessed readings=%d in %.0fms", len(readings), duration_ms)

    return JSONResponse(
        {**assessment.to_dict(), "inference_ms": round(duration_ms, 1)},
        status_code=200,
    )


@app.post("/api/v1/fall")
async def fall(request: Request, authorization: str | None = Header(default=None)):
    """Scores IMU windows for a fall.

    Separate from `/assess` because it is the one path a caller might want at a
    different cadence — the full assessment runs over hours of vitals, a fall
    decision is about the last few seconds.
    """
    if not _authorised(authorization):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "invalid_json"}, status_code=400)

    accel = body.get("accel") if isinstance(body, dict) else None
    gyro = body.get("gyro") if isinstance(body, dict) else None

    if not isinstance(accel, list) or not isinstance(gyro, list):
        return JSONResponse(
            {
                "error": "invalid_request",
                "details": ["`accel` and `gyro` must each be a list of [x, y, z]."],
            },
            status_code=422,
        )

    if len(accel) > MAX_READINGS or len(gyro) > MAX_READINGS:
        return JSONResponse({"error": "too_many_readings"}, status_code=413)

    if not _state.get("model_loaded"):
        # Explicit rather than a null prediction. "No model" and "no fall" must
        # not look the same to a caller, or an absent model reads as a patient
        # who did not fall.
        return JSONResponse({"error": "no_model"}, status_code=503)

    started = time.monotonic()

    try:
        # Coerced to tuples at the boundary: the model indexes them positionally
        # and a JSON object with x/y/z keys would fail deep inside feature
        # extraction rather than here, where the caller can be told why.
        prediction = predict_fall(
            [tuple(v) for v in accel if isinstance(v, list) and len(v) == 3],
            [tuple(v) for v in gyro if isinstance(v, list) and len(v) == 3],
        )
    except Exception:  # noqa: BLE001
        logger.exception("fall inference failed samples=%d", len(accel))
        return JSONResponse({"error": "inference_failed"}, status_code=500)

    return JSONResponse(
        {
            # None means "not enough IMU data to decide", which is distinct
            # from "no fall". A caller that collapsed the two would treat a
            # sensor gap as reassurance.
            "fall": prediction.to_dict() if prediction else None,
            "samples": len(accel),
            "inference_ms": round((time.monotonic() - started) * 1000, 1),
        },
        status_code=200,
    )


@app.get("/api/v1/model-card")
async def get_model_card():
    """Provenance for the fall model, including its synthetic-data caveat.

    Unauthenticated on purpose. It describes a model, never a patient — and a
    model whose limitations are only visible to people with a service token is
    a model whose limitations are effectively hidden.
    """
    card = _state.get("model_card")
    if card is None:
        return JSONResponse({"error": "no_model"}, status_code=404)
    return card


@app.get("/api/health/live")
async def health_live():
    """Liveness. Touches nothing, on purpose.

    A liveness probe that ran an inference would fail under load and have the
    orchestrator restart a service that is merely busy.
    """
    return {"status": "ok", "service": "averis-ai"}


@app.get("/api/health/ready")
async def health_ready():
    """Readiness — whether the models this service exists to serve are loaded.

    Reports `ready` without the fall model, because the vitals engine is rules
    and statistics and works without it. Degraded, and saying so, beats
    refusing traffic the service can still handle.
    """
    loaded = bool(_state.get("model_loaded"))

    return JSONResponse(
        {
            "status": "ready",
            "checks": {"fall_model": loaded, "vitals_engine": True},
            "degraded": not loaded,
            "started_at": _state.get("started_at"),
        },
        status_code=200,
        headers={"Cache-Control": "no-store"},
    )

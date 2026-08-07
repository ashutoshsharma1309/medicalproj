"""Conformance against the shared wire-contract vectors.

Runs the same payloads as `lib/iot/__tests__/iot.test.ts`, from the same JSON
file. The two validators are a genuine duplication — the ingest service is
Python, the app is TypeScript, and there is no shared runtime to hold one copy.
These vectors are what stops them drifting: a payload accepted by one and
rejected by the other fails here rather than in the field.

    iot-service/.venv/bin/python -m pytest iot-service/tests -q
"""

from __future__ import annotations

import json
import pathlib
import sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from app.alerts import evaluate_reading, should_raise  # noqa: E402
from app.store import hash_token  # noqa: E402
from app.validation import PLAUSIBLE, Reading, validate_reading  # noqa: E402

VECTORS = json.loads(
    (pathlib.Path(__file__).resolve().parents[2] / "lib/iot/__tests__/vectors.json").read_text()
)

NOW = datetime(2026, 8, 6, 12, 0, 0, tzinfo=timezone.utc)


def _reading(**overrides) -> Reading:
    base = {
        "device_key": "AVR001",
        "heart_rate": 70,
        "spo2": 98,
        "temperature": 36.7,
        "movement_status": "RESTING",
        "battery_percentage": 90,
        "recorded_at": NOW,
    }
    base.update(overrides)
    return Reading(**base)


# --------------------------------------------------------------- validation
@pytest.mark.parametrize(
    "vector", VECTORS["validation"], ids=[v["name"] for v in VECTORS["validation"]]
)
def test_validation_vector(vector):
    result = validate_reading(vector["payload"], NOW)
    expected = vector["expect"]

    if expected.get("ok") is False:
        assert not result.ok, "expected rejection"
        needle = expected.get("errorContains")
        if needle:
            joined = " | ".join(result.errors)
            assert needle in joined, f'expected "{needle}" in: {joined}'
        return

    assert result.ok, f"expected acceptance, got {result.errors}"
    reading = result.reading

    field_map = {
        "deviceKey": "device_key",
        "heartRate": "heart_rate",
        "spo2": "spo2",
        "temperature": "temperature",
        "movementStatus": "movement_status",
    }
    for js_field, py_field in field_map.items():
        if js_field in expected:
            assert getattr(reading, py_field) == expected[js_field], f"{py_field} mismatch"

    if "recordedAt" in expected:
        # The TypeScript side emits ISO with milliseconds; compare instants.
        assert reading.recorded_at == datetime.fromisoformat(
            expected["recordedAt"].replace("Z", "+00:00")
        )

    if expected.get("noPatientIdInResult"):
        # The validated shape has no field a patient id could travel in.
        assert not hasattr(reading, "patient_id")
        assert "patient_id" not in reading.__dataclass_fields__


def test_boundary_values_are_accepted():
    for field, (low, high) in PLAUSIBLE.items():
        if field == "battery":
            continue
        for value in (low, high):
            result = validate_reading({"device_id": "AVR001", field: value}, NOW)
            assert result.ok, f"rejected {field}={value} at the boundary"


def test_arrival_time_is_stamped_when_absent():
    result = validate_reading({"device_id": "AVR001", "heart_rate": 70}, NOW)
    assert result.ok
    assert result.reading.recorded_at == NOW


def test_epoch_seconds_are_accepted():
    # What an ESP32 with an RTC will send.
    epoch = int(datetime(2026, 8, 1, tzinfo=timezone.utc).timestamp())
    result = validate_reading({"device_id": "AVR001", "heart_rate": 70, "timestamp": epoch}, NOW)
    assert result.ok
    assert result.reading.recorded_at.year == 2026


# ------------------------------------------------------------------ alerts
@pytest.mark.parametrize("vector", VECTORS["alerts"], ids=[v["name"] for v in VECTORS["alerts"]])
def test_alert_vector(vector):
    r = vector["reading"]
    raised = evaluate_reading(
        _reading(
            heart_rate=r.get("heartRate"),
            spo2=r.get("spo2"),
            temperature=r.get("temperature"),
            movement_status=r.get("movementStatus", "RESTING"),
            battery_percentage=r.get("batteryPercentage"),
        )
    )

    assert len(raised) == len(vector["expect"]), (
        f"expected {len(vector['expect'])}, got {[a.alert_type for a in raised]}"
    )

    for expected in vector["expect"]:
        found = next((a for a in raised if a.alert_type == expected["alertType"]), None)
        assert found is not None, f"no {expected['alertType']} raised"
        assert found.severity == expected["severity"]


def test_alerts_quote_a_number_and_a_threshold():
    raised = evaluate_reading(_reading(spo2=85, heart_rate=160, temperature=39.9))
    assert len(raised) >= 3

    for alert in raised:
        if alert.alert_type == "FALL_SUSPECTED":
            continue
        assert alert.observed_value is not None
        assert alert.threshold_value is not None
        assert any(ch.isdigit() for ch in alert.message)


def test_alerts_never_state_a_diagnosis():
    raised = evaluate_reading(_reading(spo2=85, heart_rate=165, temperature=39.9))
    for alert in raised:
        lowered = alert.message.lower()
        assert "you have" not in lowered
        assert "diagnos" not in lowered
        assert "you should" not in lowered


def test_repeat_alert_is_suppressed():
    open_alerts = [{"alert_type": "SPO2_LOW", "severity": "CRITICAL"}]
    candidate = evaluate_reading(_reading(spo2=87))[0]
    assert should_raise(candidate, open_alerts) is False


def test_escalation_gets_through():
    open_alerts = [{"alert_type": "SPO2_LOW", "severity": "WARNING"}]
    candidate = evaluate_reading(_reading(spo2=87))[0]
    assert candidate.severity == "CRITICAL"
    assert should_raise(candidate, open_alerts) is True


# ------------------------------------------------------------------ tokens
def test_token_hash_matches_the_typescript_implementation():
    # Both sides must agree on the hash, or a device registered by the app
    # cannot authenticate against the service.
    assert hash_token("avd_example") == (
        __import__("hashlib").sha256(b"avd_example").hexdigest()
    )
    assert len(hash_token("anything")) == 64

"""Sensor payload validation.

A deliberate port of `lib/iot/reading-validation.ts`. The duplication is the
point of the shared test vectors in `tests/` — a firmware payload accepted by
one and rejected by the other is a bug in whichever is wrong, and the vectors
make that visible instead of leaving it to be discovered by a device in the
field.

Two separate jobs, as on the TypeScript side:

**Plausibility** rejects values no human body produces. A heart rate of 4000 is
a broken sensor; storing it would poison every average computed afterwards.

**Clinical thresholds** are not validation and live in `alerts.py`. A heart rate
of 190 is alarming and completely real — rejecting it here would discard exactly
the readings the system exists to catch.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

MOVEMENT_VALUES = {"RESTING", "NORMAL", "ACTIVE", "FALL_SUSPECTED", "UNKNOWN"}

# Firmware spellings seen in the wild, mapped rather than rejected.
MOVEMENT_ALIASES = {
    "REST": "RESTING",
    "IDLE": "RESTING",
    "STILL": "RESTING",
    "WALKING": "ACTIVE",
    "RUNNING": "ACTIVE",
    "MOVING": "ACTIVE",
    "FALL": "FALL_SUSPECTED",
    "FALLEN": "FALL_SUSPECTED",
}

# Ranges a living human can produce. Mirrors the CHECK constraints exactly.
PLAUSIBLE = {
    "heart_rate": (20, 250),
    "spo2": (50, 100),
    "temperature": (25.0, 45.0),
    "battery": (0, 100),
}

MAX_CLOCK_SKEW = timedelta(hours=1)


@dataclass(frozen=True)
class Reading:
    device_key: str
    heart_rate: int | None
    spo2: int | None
    temperature: float | None
    movement_status: str
    battery_percentage: int | None
    recorded_at: datetime


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    reading: Reading | None = None
    errors: tuple[str, ...] = ()


def validate_reading(raw: Any, now: datetime | None = None) -> ValidationResult:
    """Validates one payload.

    Note what is absent: `patient_id`. Ownership is read from the authenticated
    device row, so there is no field here that could carry someone else's id.
    """
    now = now or datetime.now(timezone.utc)
    errors: list[str] = []

    if not isinstance(raw, dict):
        return ValidationResult(ok=False, errors=("Body must be a JSON object.",))

    device_key = raw.get("device_id") or raw.get("deviceKey")
    if not isinstance(device_key, str) or not device_key.strip():
        errors.append("device_id is required.")

    heart_rate = _optional_number(raw.get("heart_rate", raw.get("heartRate")), "heart_rate", errors)
    spo2 = _optional_number(raw.get("spo2"), "spo2", errors)
    temperature = _optional_number(raw.get("temperature"), "temperature", errors)
    battery = _optional_number(
        raw.get("battery", raw.get("battery_percentage")), "battery", errors
    )

    if heart_rate is None and spo2 is None and temperature is None:
        errors.append("A reading must carry at least one measurement.")

    movement = _parse_movement(raw.get("movement", raw.get("movement_status")))

    recorded_at = now
    recorded_raw = raw.get("recorded_at", raw.get("timestamp"))
    if recorded_raw is not None:
        parsed = _parse_timestamp(recorded_raw)
        if parsed is None:
            errors.append("recorded_at is not a valid timestamp.")
        elif parsed > now + MAX_CLOCK_SKEW:
            # A future timestamp would sit permanently at the top of every
            # "latest" query, hiding every real reading behind it.
            errors.append("recorded_at is more than an hour in the future.")
        else:
            recorded_at = parsed

    if errors:
        return ValidationResult(ok=False, errors=tuple(errors))

    return ValidationResult(
        ok=True,
        reading=Reading(
            device_key=str(device_key).strip().upper(),
            heart_rate=int(heart_rate) if heart_rate is not None else None,
            spo2=int(spo2) if spo2 is not None else None,
            temperature=round(float(temperature), 1) if temperature is not None else None,
            movement_status=movement,
            battery_percentage=int(battery) if battery is not None else None,
            recorded_at=recorded_at,
        ),
    )


def _optional_number(value: Any, field: str, errors: list[str]) -> float | None:
    if value is None or value == "":
        return None

    # bool is an int subclass in Python, and True would otherwise validate as 1.
    if isinstance(value, bool):
        errors.append(f"{field} must be a number.")
        return None

    try:
        parsed = float(value)
    except (TypeError, ValueError):
        errors.append(f"{field} must be a number.")
        return None

    if parsed != parsed or parsed in (float("inf"), float("-inf")):
        errors.append(f"{field} must be a finite number.")
        return None

    low, high = PLAUSIBLE[field]
    if parsed < low or parsed > high:
        errors.append(
            f"{field} of {parsed:g} is outside the physiologically possible "
            f"range ({low}–{high}) and looks like a sensor fault."
        )
        return None

    return parsed


def _parse_movement(value: Any) -> str:
    """Unknown labels become UNKNOWN rather than failing the reading.

    The vital signs are the payload's reason for existing. Losing a valid heart
    rate because a firmware revision started saying "walking" would discard real
    data over a label.
    """
    if not isinstance(value, str):
        return "UNKNOWN"

    upper = value.strip().upper()
    if upper in MOVEMENT_VALUES:
        return upper
    return MOVEMENT_ALIASES.get(upper, "UNKNOWN")


def _parse_timestamp(value: Any) -> datetime | None:
    if isinstance(value, (int, float)):
        # Epoch seconds — what an ESP32 with an RTC will send.
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None

    if not isinstance(value, str):
        return None

    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None

    # A naive timestamp is assumed UTC rather than rejected: firmware clocks
    # frequently omit the offset, and guessing local time would be worse.
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed

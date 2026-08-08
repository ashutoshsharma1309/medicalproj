"""Device telemetry — everything an uplink says about the band rather than the
patient.

Kept apart from `validation.py` on purpose, and the separation is the design:

**A bad measurement is a rejected reading. Bad telemetry is ignored.** If a
band reports an impossible heart rate the payload fails, because storing it
would poison the record. If the same band reports an impossible RSSI, the
reading is still a reading — the wearer's oxygen saturation does not become
untrustworthy because a signal-strength field was garbled. Letting telemetry
fail a payload would mean a firmware bug in a diagnostic field could stop a
patient being monitored.

So everything here is best-effort, bounded, and never raises.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

# Values the firmware's SensorState enum can produce. Anything else is stored
# as "unknown" rather than rejected — a future revision reporting a new state
# should not make its readings unparseable.
SENSOR_STATES = {"ok", "absent", "no_contact", "faulty"}

TRANSPORTS = {"wifi", "wifi_buffered", "ble", "simulator"}

# Bounds for the diagnostic fields. Not physiology — just the range past which
# a number is a bug rather than a reading about the radio.
RSSI_RANGE = (-120, 0)
MAX_UPTIME_SECONDS = 60 * 60 * 24 * 365  # a year of uptime is a wrapped counter
MAX_BOOT_COUNT = 1_000_000
MAX_BUFFERED = 10_000


@dataclass(frozen=True)
class Telemetry:
    rssi_dbm: int | None = None
    uptime_seconds: int | None = None
    boot_count: int | None = None
    firmware_version: str | None = None
    hardware_revision: str | None = None
    transport: str | None = None
    buffered: int | None = None
    sensors: dict[str, str] = field(default_factory=dict)

    def is_empty(self) -> bool:
        return not any(
            (
                self.rssi_dbm is not None,
                self.uptime_seconds is not None,
                self.boot_count is not None,
                self.firmware_version,
                self.hardware_revision,
                self.transport,
                self.buffered is not None,
                self.sensors,
            )
        )


def parse_telemetry(raw: Any) -> Telemetry:
    """Reads the telemetry block. Never raises, never rejects a reading.

    Accepts it nested under `telemetry` (what the firmware sends) or flat at
    the top level (what a minimal third-party device is likely to send). Both
    shapes cost one lookup and supporting only one would mean a device that
    reports its battery correctly and its signal strength nowhere.
    """
    if not isinstance(raw, dict):
        return Telemetry()

    block = raw.get("telemetry")
    if not isinstance(block, dict):
        block = raw

    return Telemetry(
        rssi_dbm=_bounded_int(block.get("rssi"), *RSSI_RANGE),
        uptime_seconds=_bounded_int(block.get("uptime_s", block.get("uptime")), 0, MAX_UPTIME_SECONDS),
        boot_count=_bounded_int(block.get("boot_count"), 0, MAX_BOOT_COUNT),
        firmware_version=_short_text(block.get("firmware", block.get("firmware_version"))),
        hardware_revision=_short_text(block.get("hardware", block.get("hardware_revision"))),
        transport=_enum(block.get("transport"), TRANSPORTS),
        buffered=_bounded_int(block.get("buffered"), 0, MAX_BUFFERED),
        sensors=_sensors(block.get("sensors")),
    )


def latency_ms(recorded_at: datetime, received_at: datetime | None = None) -> int:
    """How long a reading took to arrive, by the two clocks involved.

    Reported rather than corrected, and shown in the UI as an indicator rather
    than a measurement — because this number contains clock skew as well as
    network delay, and a band whose clock runs 40 seconds fast produces a
    *negative* latency. That is worth seeing: it is the only signal that
    distinguishes a device buffering through an outage from one whose clock is
    simply wrong, and rewriting either would destroy the difference.
    """
    received_at = received_at or datetime.now(timezone.utc)
    if recorded_at.tzinfo is None:
        recorded_at = recorded_at.replace(tzinfo=timezone.utc)

    delta = (received_at - recorded_at).total_seconds() * 1000.0

    # Clamped to a day in either direction so one absurd timestamp cannot
    # write a number nothing downstream can render.
    return int(max(-86_400_000, min(86_400_000, delta)))


def _bounded_int(value: Any, low: int, high: int) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return None
    return parsed if low <= parsed <= high else None


def _short_text(value: Any, limit: int = 40) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()[:limit]
    return trimmed or None


def _enum(value: Any, allowed: set[str]) -> str | None:
    if not isinstance(value, str):
        return None
    lowered = value.strip().lower()
    return lowered if lowered in allowed else None


def _sensors(value: Any) -> dict[str, str]:
    """Per-sensor state, bounded in both key count and value vocabulary.

    A device that sent a thousand sensor keys would otherwise grow the device
    row without limit — jsonb has no schema to stop it, so the limit is here.
    """
    if not isinstance(value, dict):
        return {}

    out: dict[str, str] = {}
    for key, state in list(value.items())[:12]:
        if not isinstance(key, str):
            continue
        name = key.strip().lower()[:24]
        if not name:
            continue
        text = state.strip().lower() if isinstance(state, str) else ""
        out[name] = text if text in SENSOR_STATES else "unknown"

    return out


def sensor_faults(previous: dict[str, str], current: dict[str, str]) -> tuple[list[str], list[str]]:
    """Sensors that just broke, and sensors that just came back.

    Compared rather than reported, because a band sends its sensor states every
    two seconds and a device event per uplink would be a second readings table.
    An event is worth writing when something *changed*.

    `absent` is not a fault: a chest strap has no thermometer, and a band that
    has never had one should not raise a fault every time it says so. What is a
    fault is a sensor that was working and stopped.
    """
    broke: list[str] = []
    recovered: list[str] = []

    for name, state in current.items():
        was = previous.get(name)
        if state == "faulty" and was != "faulty":
            broke.append(name)
        elif state == "ok" and was in ("faulty", "no_contact"):
            recovered.append(name)

    return broke, recovered

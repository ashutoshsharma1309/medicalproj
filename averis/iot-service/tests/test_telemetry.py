"""Telemetry parsing.

The property under test throughout: **telemetry never costs a reading.** Every
malformed, absurd or hostile diagnostic field below must be dropped while the
vital signs beside it survive — because a firmware bug in a signal-strength
field must not be able to stop a patient being monitored.

    iot-service/.venv/bin/python -m pytest iot-service/tests -q
"""

from __future__ import annotations

import pathlib
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.telemetry import (  # noqa: E402
    Telemetry,
    latency_ms,
    parse_telemetry,
    sensor_faults,
)
from app.validation import validate_reading  # noqa: E402

NOW = datetime(2026, 8, 9, 12, 0, 0, tzinfo=timezone.utc)

FIRMWARE_PAYLOAD = {
    "device_id": "AVR001",
    "heart_rate": 82,
    "spo2": 97,
    "temperature": 36.8,
    "movement": "ACTIVE",
    "battery": 85,
    "recorded_at": "2026-08-09T12:00:00Z",
    "telemetry": {
        "rssi": -57,
        "uptime_s": 3600,
        "boot_count": 4,
        "firmware": "1.0.0",
        "transport": "wifi",
        "buffered": 0,
        "sensors": {"pulse": "ok", "thermometer": "ok", "imu": "ok"},
    },
}


def test_parses_the_firmware_payload():
    t = parse_telemetry(FIRMWARE_PAYLOAD)

    assert t.rssi_dbm == -57
    assert t.uptime_seconds == 3600
    assert t.boot_count == 4
    assert t.firmware_version == "1.0.0"
    assert t.transport == "wifi"
    assert t.sensors == {"pulse": "ok", "thermometer": "ok", "imu": "ok"}


def test_accepts_flat_telemetry_too():
    # A minimal third-party device is likely to put these at the top level, and
    # supporting one shape only would mean a device that reports its battery
    # correctly and its signal strength nowhere.
    t = parse_telemetry({"device_id": "AVR001", "rssi": -70, "firmware": "0.9"})

    assert t.rssi_dbm == -70
    assert t.firmware_version == "0.9"


def test_absent_telemetry_is_empty_not_an_error():
    t = parse_telemetry({"device_id": "AVR001", "heart_rate": 70})

    assert t.is_empty()
    assert t.sensors == {}


def test_garbage_telemetry_does_not_fail_the_reading():
    payload = dict(FIRMWARE_PAYLOAD)
    payload["telemetry"] = {
        "rssi": "not a number",
        "uptime_s": -5,
        "boot_count": 10**9,
        "firmware": 42,
        "transport": "carrier pigeon",
        "sensors": "yes",
    }

    t = parse_telemetry(payload)
    assert t.rssi_dbm is None
    assert t.uptime_seconds is None
    assert t.boot_count is None
    assert t.firmware_version is None
    assert t.transport is None
    assert t.sensors == {}

    # The reading itself is untouched. This is the whole point of the split.
    result = validate_reading(payload, now=NOW)
    assert result.ok
    assert result.reading.heart_rate == 82


def test_telemetry_is_not_a_place_to_smuggle_a_patient_id():
    t = parse_telemetry({"telemetry": {"patient_id": "someone-else", "rssi": -50}})

    # There is no field to carry it, so it is simply not read. Ownership comes
    # from the authenticated device row and nothing on the wire can move it.
    assert not hasattr(t, "patient_id")
    assert t.rssi_dbm == -50


def test_implausible_rssi_is_dropped_rather_than_stored():
    assert parse_telemetry({"telemetry": {"rssi": 40}}).rssi_dbm is None
    assert parse_telemetry({"telemetry": {"rssi": -900}}).rssi_dbm is None
    assert parse_telemetry({"telemetry": {"rssi": -90}}).rssi_dbm == -90


def test_booleans_are_not_numbers():
    # True is an int in Python, and would otherwise be stored as a boot count
    # of 1 that nothing downstream could tell from a real one.
    assert parse_telemetry({"telemetry": {"boot_count": True}}).boot_count is None


def test_unknown_sensor_state_is_recorded_as_unknown():
    # A future firmware revision reporting a new state should not make its
    # readings unparseable.
    t = parse_telemetry({"telemetry": {"sensors": {"pulse": "recalibrating"}}})
    assert t.sensors == {"pulse": "unknown"}


def test_sensor_map_is_bounded():
    # jsonb has no schema to stop a device growing the row without limit.
    flood = {f"sensor_{i}": "ok" for i in range(200)}
    t = parse_telemetry({"telemetry": {"sensors": flood}})

    assert len(t.sensors) <= 12


def test_long_firmware_string_is_truncated():
    t = parse_telemetry({"telemetry": {"firmware": "v" * 500}})
    assert t.firmware_version is not None
    assert len(t.firmware_version) <= 40


# --------------------------------------------------------------- latency
def test_latency_is_measured_from_the_device_clock():
    recorded = NOW - timedelta(milliseconds=350)
    assert 300 <= latency_ms(recorded, NOW) <= 400


def test_a_device_clock_running_fast_reports_negative_latency():
    # Reported, not corrected. This is the only signal that separates a device
    # buffering through an outage from one whose clock is simply wrong, and
    # clamping it to zero would erase the difference.
    recorded = NOW + timedelta(seconds=40)
    assert latency_ms(recorded, NOW) < 0


def test_absurd_timestamps_are_clamped_rather_than_stored():
    recorded = NOW - timedelta(days=400)
    assert latency_ms(recorded, NOW) == 86_400_000


def test_naive_timestamps_are_read_as_utc():
    recorded = (NOW - timedelta(seconds=1)).replace(tzinfo=None)
    assert 900 <= latency_ms(recorded, NOW) <= 1100


# ---------------------------------------------------------- sensor faults
def test_a_sensor_that_breaks_is_reported_once():
    broke, recovered = sensor_faults({"pulse": "ok"}, {"pulse": "faulty"})

    assert broke == ["pulse"]
    assert recovered == []

    # Still faulty on the next uplink: nothing changed, so nothing is written.
    # A band uplinks every two seconds and an event per uplink would be a
    # second readings-sized table describing one broken sensor.
    broke, _ = sensor_faults({"pulse": "faulty"}, {"pulse": "faulty"})
    assert broke == []


def test_a_sensor_coming_back_is_reported():
    _, recovered = sensor_faults({"pulse": "faulty"}, {"pulse": "ok"})
    assert recovered == ["pulse"]

    _, recovered = sensor_faults({"pulse": "no_contact"}, {"pulse": "ok"})
    assert recovered == ["pulse"]


def test_an_absent_sensor_is_not_a_fault():
    # A chest strap has no thermometer. Raising a fault every two seconds for
    # a part that was never fitted is how an engineering log becomes unreadable.
    broke, recovered = sensor_faults({}, {"thermometer": "absent"})

    assert broke == []
    assert recovered == []

    broke, _ = sensor_faults({"thermometer": "absent"}, {"thermometer": "absent"})
    assert broke == []


def test_losing_skin_contact_is_not_a_fault_either():
    # A wearer taking the band off is not a hardware failure, and paging an
    # engineer for it would train them to ignore the log.
    broke, _ = sensor_faults({"pulse": "ok"}, {"pulse": "no_contact"})
    assert broke == []


def test_first_ever_report_raises_no_events():
    broke, recovered = sensor_faults({}, {"pulse": "ok", "imu": "ok"})

    assert broke == []
    assert recovered == []


def test_empty_telemetry_object_is_empty():
    assert Telemetry().is_empty()
    assert not Telemetry(rssi_dbm=-50).is_empty()

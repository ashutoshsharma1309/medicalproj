"""Escalation, in the runtime that actually raises them.

Mirrors `lib/care/__tests__/escalation.test.ts` case for case. The two engines
are a genuine duplication — the ingest path is Python and the dashboard reasons
in TypeScript — and these are what stop the *decision to wake a clinician* from
drifting between them.

    iot-service/.venv/bin/python -m pytest iot-service/tests -q
"""

from __future__ import annotations

import pathlib
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.alerts import Alert  # noqa: E402
from app.escalation import (  # noqa: E402
    AI_ESCALATION_SCORE,
    DEVICE_SILENCE_SECONDS,
    Assessment,
    assessment_from_dict,
    escalations_for,
    from_alerts,
    from_assessment,
    from_silence,
    notice_title,
    should_escalate,
)

NOW = datetime(2026, 8, 8, 12, 0, 0, tzinfo=timezone.utc)


def _alert(**overrides) -> Alert:
    base = {
        "alert_type": "SPO2_LOW",
        "severity": "CRITICAL",
        "message": "Blood oxygen measured 86%, below the 90% escalation threshold.",
        "observed_value": 86,
        "threshold_value": 90,
    }
    base.update(overrides)
    return Alert(**base)


def _assessment(**overrides) -> Assessment:
    base = {
        "risk_level": "LOW",
        "risk_score": 0.1,
        "confidence": 0.8,
        "reasons": [],
        "fall_detected": False,
        "fall_confidence": None,
        "deteriorating": False,
    }
    base.update(overrides)
    return Assessment(**base)


# ------------------------------------------------------------- from alerts
def test_critical_spo2_becomes_an_emergency():
    event = from_alerts([_alert()])[0]

    assert event.event_type == "SEVERE_HYPOXIA"
    assert event.detected_by == "RULE_ENGINE"
    # The numbers travel with the event, so a clinician can check it.
    assert event.evidence["observed"] == 86
    assert event.evidence["threshold"] == 90


def test_a_warning_is_not_an_emergency():
    # The point of two levels is that one of them can wait.
    assert from_alerts([_alert(severity="WARNING", observed_value=93)]) == []


def test_fall_flag_escalates():
    assert from_alerts([_alert(alert_type="FALL_SUSPECTED")])[0].event_type == "FALL_DETECTED"


def test_both_heart_rate_extremes_share_one_event_type():
    high = from_alerts([_alert(alert_type="HEART_RATE_HIGH", observed_value=168)])
    low = from_alerts([_alert(alert_type="HEART_RATE_LOW", observed_value=34)])

    assert high[0].event_type == "EXTREME_HEART_RATE"
    assert low[0].event_type == "EXTREME_HEART_RATE"


def test_critical_temperature_does_not_escalate():
    # Still a critical alert on the chart. Diluting the response queue would
    # not improve the fever.
    assert from_alerts([_alert(alert_type="TEMPERATURE_HIGH", observed_value=39.8)]) == []


# --------------------------------------------------------- from assessment
def test_ai_escalates_only_when_critical_and_rising():
    events = from_assessment(
        _assessment(
            risk_level="CRITICAL",
            risk_score=0.91,
            deteriorating=True,
            reasons=["SpO2 declining", "heart rate rising"],
        )
    )

    assert events[0].event_type == "RAPID_DETERIORATION"
    assert events[0].detected_by == "AI_ENGINE"
    assert "91%" in events[0].summary


def test_a_flat_high_score_stays_quiet():
    # A patient who has been at 0.93 for a week is one whose clinician knows.
    assert from_assessment(
        _assessment(risk_level="CRITICAL", risk_score=0.93, deteriorating=False)
    ) == []


def test_below_the_escalation_score_stays_quiet():
    assert from_assessment(
        _assessment(
            risk_level="CRITICAL",
            risk_score=AI_ESCALATION_SCORE - 0.01,
            deteriorating=True,
        )
    ) == []


def test_high_is_not_critical():
    assert from_assessment(
        _assessment(risk_level="HIGH", risk_score=0.95, deteriorating=True)
    ) == []


def test_fall_model_carries_its_synthetic_data_caveat():
    event = from_assessment(_assessment(fall_detected=True, fall_confidence=0.88))[0]

    assert event.event_type == "FALL_DETECTED"
    assert "synthetic" in event.evidence["caveat"]


def test_assessment_adapter_reads_deterioration_from_the_insights():
    payload = {
        "risk_level": "CRITICAL",
        "risk_score": 0.9,
        "confidence": 0.7,
        "explanation": ["SpO2 declining"],
        "fall": {"fall_detected": False, "confidence": 0.2},
        "insights": [
            {"insight_type": "TREND_DECLINE", "severity": "WARNING"},
            {"insight_type": "DATA_GAP", "severity": "INFO"},
        ],
    }

    adapted = assessment_from_dict(payload)

    assert adapted.deteriorating is True
    assert adapted.reasons == ["SpO2 declining"]
    assert adapted.fall_detected is False


def test_assessment_adapter_ignores_informational_insights():
    payload = {
        "risk_level": "CRITICAL",
        "risk_score": 0.9,
        "insights": [{"insight_type": "DATA_GAP", "severity": "INFO"}],
    }

    assert assessment_from_dict(payload).deteriorating is False


def test_assessment_adapter_survives_a_missing_fall_block():
    # The engine reports fall=None when there is no IMU data in the window.
    assert assessment_from_dict({"risk_level": "LOW", "fall": None}).fall_detected is False


# ------------------------------------------------------------ from silence
def test_silence_escalates_after_the_window():
    last = NOW - timedelta(seconds=DEVICE_SILENCE_SECONDS + 60)
    event = from_silence(last.isoformat(), NOW)[0]

    assert event.event_type == "DEVICE_LOST"
    # WARNING: nothing is known to be wrong with the patient, which is a
    # different problem from a measured emergency.
    assert event.severity == "WARNING"
    assert event.evidence["silent_minutes"] == 16


def test_a_short_gap_is_tolerated():
    assert from_silence((NOW - timedelta(minutes=1)).isoformat(), NOW) == []


def test_a_device_that_never_reported_does_not_escalate():
    assert from_silence(None, NOW) == []


def test_an_unparseable_timestamp_does_not_escalate():
    assert from_silence("not-a-date", NOW) == []


def test_naive_timestamps_are_read_as_utc():
    # PostgREST returns timestamps with an offset, but a device or a fixture
    # can produce a naive one, and comparing it to an aware `now` would raise.
    last = (NOW - timedelta(seconds=DEVICE_SILENCE_SECONDS + 60)).replace(tzinfo=None)
    assert from_silence(last.isoformat(), NOW)[0].event_type == "DEVICE_LOST"


# ------------------------------------------------------------- suppression
def test_an_open_event_suppresses_a_repeat():
    candidate = from_alerts([_alert()])[0]

    assert not should_escalate(
        candidate, [{"event_type": "SEVERE_HYPOXIA", "severity": "CRITICAL", "status": "NEW"}]
    )


def test_suppression_holds_while_a_clinician_is_responding():
    candidate = from_alerts([_alert()])[0]

    for status in ("ACKNOWLEDGED", "IN_PROGRESS"):
        assert not should_escalate(
            candidate,
            [{"event_type": "SEVERE_HYPOXIA", "severity": "CRITICAL", "status": status}],
        )


def test_a_resolved_event_stops_suppressing():
    candidate = from_alerts([_alert()])[0]

    assert should_escalate(
        candidate,
        [{"event_type": "SEVERE_HYPOXIA", "severity": "CRITICAL", "status": "RESOLVED"}],
    )


def test_an_escalating_severity_gets_through():
    candidate = from_alerts([_alert()])[0]

    assert should_escalate(
        candidate,
        [{"event_type": "SEVERE_HYPOXIA", "severity": "WARNING", "status": "NEW"}],
    )


# ----------------------------------------------------------------- the lot
def test_one_fall_from_two_detectors_is_one_event():
    events = escalations_for(
        alerts=[_alert(alert_type="FALL_SUSPECTED")],
        assessment=_assessment(fall_detected=True, fall_confidence=0.9),
        now=NOW,
    )

    assert len(events) == 1
    assert events[0].event_type == "FALL_DETECTED"


def test_most_severe_first():
    events = escalations_for(
        alerts=[_alert()],
        last_reading_at=(NOW - timedelta(seconds=DEVICE_SILENCE_SECONDS + 1)).isoformat(),
        now=NOW,
    )

    assert [e.severity for e in events] == ["CRITICAL", "WARNING"]


def test_an_ordinary_reading_escalates_nothing():
    assert escalations_for(alerts=[], assessment=_assessment(), now=NOW) == []


def test_the_notice_leads_with_the_patient():
    candidate = from_alerts([_alert()])[0]

    # A phone notification truncates, and the first question is always *who*.
    assert notice_title(candidate, "Rahul Sharma").startswith("Rahul Sharma — ")

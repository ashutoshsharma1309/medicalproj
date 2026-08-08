"""Escalation — when a finding becomes somebody's problem.

An alert says a measurement crossed a threshold. An emergency event says a
human needs to respond, and it stays in a clinician's queue until one does.

Ported from `lib/care/escalation.ts`, which carries the full reasoning. The
short version:

  · rules, not a model, because an escalation wakes a person up and the person
    woken deserves to know exactly what tripped it
  · the AI engine may still raise one, since a slow decline in which every
    individual reading sits inside the normal band is the one thing thresholds
    structurally cannot see — but only when risk is critical *and* rising
  · a critical temperature does not escalate; diluting the response queue would
    not improve the fever

This is the copy that runs in production. Keeping both is the same arrangement
as `alerts.py` and `lib/iot/alert-rules.ts`: one language owns the ingest path,
the other owns what the dashboard reasons about, and they are tested against
the same expectations.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from .alerts import Alert

SEVERITY_RANK = {"INFO": 1, "WARNING": 2, "CRITICAL": 3}

OPEN_STATUSES = ("NEW", "ACKNOWLEDGED", "IN_PROGRESS")

# 0.85 rather than 0.7, and CRITICAL rather than HIGH: this threshold buys a
# clinician's attention with a model's opinion.
AI_ESCALATION_SCORE = 0.85

# Fifteen minutes. Bands drop off Wi-Fi and phones move out of range; a system
# that escalates on every gap teaches its clinicians to dismiss escalations.
DEVICE_SILENCE_SECONDS = 15 * 60

LABELS = {
    "FALL_DETECTED": "Fall detected",
    "SEVERE_HYPOXIA": "Severe drop in blood oxygen",
    "EXTREME_HEART_RATE": "Extreme heart rate",
    "RAPID_DETERIORATION": "Rapidly rising risk",
    "DEVICE_LOST": "Device stopped reporting",
    "MANUAL_ESCALATION": "Escalated by hand",
}

# Insight kinds that mean "moving in the wrong direction". A rising heart rate
# and a falling SpO2 are both deterioration; the engine has already decided the
# slope was steep enough to be worth reporting.
DETERIORATING_INSIGHTS = ("TREND_RISE", "TREND_DECLINE", "PATTERN_CORRELATION")


@dataclass(frozen=True)
class Emergency:
    event_type: str
    severity: str
    detected_by: str
    summary: str
    evidence: dict = field(default_factory=dict)

    @property
    def title_for(self) -> str:
        return LABELS.get(self.event_type, self.event_type)


@dataclass(frozen=True)
class Assessment:
    """The subset of a HealthAssessment escalation needs."""

    risk_level: str | None
    risk_score: float | None
    confidence: float | None
    reasons: list[str]
    fall_detected: bool
    fall_confidence: float | None
    deteriorating: bool


def assessment_from_dict(payload: dict) -> Assessment:
    """Adapts the engine's output without the engine knowing about escalation.

    `deteriorating` is derived from the insights rather than added to the
    engine, because "is this getting worse" is a question about the trend
    insights it already produces — and a new field on the assessment would be
    a second place for the same judgement to live.
    """
    fall = payload.get("fall") or {}
    insights = payload.get("insights") or []

    return Assessment(
        risk_level=payload.get("risk_level"),
        risk_score=payload.get("risk_score"),
        confidence=payload.get("confidence"),
        reasons=list(payload.get("explanation") or []),
        fall_detected=bool(fall.get("fall_detected")),
        fall_confidence=fall.get("confidence"),
        deteriorating=any(
            i.get("insight_type") in DETERIORATING_INSIGHTS
            and i.get("severity") in ("WARNING", "CRITICAL")
            for i in insights
        ),
    )


def from_alerts(alerts: list[Alert]) -> list[Emergency]:
    """Which threshold alerts are emergencies in their own right.

    A WARNING never appears here. The point of two levels is that one of them
    can be looked at later.
    """
    out: list[Emergency] = []

    for alert in alerts:
        if alert.severity != "CRITICAL":
            continue

        if alert.alert_type == "FALL_SUSPECTED":
            out.append(
                Emergency(
                    "FALL_DETECTED",
                    "CRITICAL",
                    "RULE_ENGINE",
                    "The device reported a movement pattern consistent with a fall.",
                    {"alert_type": alert.alert_type, "source": "movement_status"},
                )
            )
        elif alert.alert_type == "SPO2_LOW":
            out.append(
                Emergency(
                    "SEVERE_HYPOXIA",
                    "CRITICAL",
                    "RULE_ENGINE",
                    alert.message,
                    {
                        "alert_type": alert.alert_type,
                        "observed": alert.observed_value,
                        "threshold": alert.threshold_value,
                    },
                )
            )
        elif alert.alert_type in ("HEART_RATE_HIGH", "HEART_RATE_LOW"):
            out.append(
                Emergency(
                    "EXTREME_HEART_RATE",
                    "CRITICAL",
                    "RULE_ENGINE",
                    alert.message,
                    {
                        "alert_type": alert.alert_type,
                        "observed": alert.observed_value,
                        "threshold": alert.threshold_value,
                    },
                )
            )

        # TEMPERATURE_* is deliberately absent — see the TypeScript original.

    return _dedupe(out)


def from_assessment(assessment: Assessment) -> list[Emergency]:
    """Whether the AI assessment is itself an escalation.

    Two ways in: the fall model fired (a discrete event), or risk is critical
    and rising (a trend). A high score that is flat belongs to a clinician who
    already knows.
    """
    out: list[Emergency] = []

    if assessment.fall_detected:
        out.append(
            Emergency(
                "FALL_DETECTED",
                "CRITICAL",
                "AI_ENGINE",
                "The fall model detected a movement pattern consistent with a fall.",
                {
                    "model": "fall_detector",
                    "confidence": assessment.fall_confidence,
                    # In the evidence because the model is trained on synthetic
                    # motion, and a clinician reading this should not have to
                    # find the model card to learn that.
                    "caveat": "trained on synthetic motion data",
                },
            )
        )

    score = assessment.risk_score or 0.0
    if (
        assessment.risk_level == "CRITICAL"
        and score >= AI_ESCALATION_SCORE
        and assessment.deteriorating
    ):
        percent = round(score * 100)
        reasons = assessment.reasons[:3]
        summary = (
            f"Risk assessment reached {percent}% and is rising: {'; '.join(reasons)}."
            if reasons
            else f"Risk assessment reached {percent}% and is rising."
        )
        out.append(
            Emergency(
                "RAPID_DETERIORATION",
                "CRITICAL",
                "AI_ENGINE",
                summary,
                {
                    "risk_score": score,
                    "risk_level": assessment.risk_level,
                    "confidence": assessment.confidence,
                    "reasons": assessment.reasons[:5],
                },
            )
        )

    return _dedupe(out)


def from_silence(
    last_reading_at: str | datetime | None,
    now: datetime | None = None,
    silence_seconds: int = DEVICE_SILENCE_SECONDS,
) -> list[Emergency]:
    """A device that has stopped reporting.

    WARNING, not CRITICAL. Nothing is known to be wrong with the patient —
    which is exactly the problem, and a different problem from a measured
    emergency. A device that never reported does not escalate: that is a band
    still in its box, not one that went quiet.
    """
    if last_reading_at is None:
        return []

    now = now or datetime.now(timezone.utc)

    if isinstance(last_reading_at, str):
        try:
            last = datetime.fromisoformat(last_reading_at.replace("Z", "+00:00"))
        except ValueError:
            return []
    else:
        last = last_reading_at

    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)

    silent = (now - last).total_seconds()
    if silent < silence_seconds:
        return []

    minutes = int(silent // 60)
    return [
        Emergency(
            "DEVICE_LOST",
            "WARNING",
            "RULE_ENGINE",
            f"No readings for {minutes} minutes. "
            "This patient is not currently being monitored.",
            {"last_reading_at": last.isoformat(), "silent_minutes": minutes},
        )
    ]


def should_escalate(candidate: Emergency, open_events: list[dict]) -> bool:
    """Whether to write it down given what is already open.

    Mirrors the partial unique index on `emergency_events`, so the caller gets
    a decision rather than a constraint violation. An escalating severity still
    gets through: an open WARNING that has become CRITICAL is new information.
    """
    for existing in open_events:
        if existing.get("event_type") != candidate.event_type:
            continue
        if existing.get("status") not in OPEN_STATUSES:
            continue
        return SEVERITY_RANK[candidate.severity] > SEVERITY_RANK.get(
            existing.get("severity", "INFO"), 0
        )
    return True


def escalations_for(
    alerts: list[Alert] | None = None,
    assessment: Assessment | None = None,
    last_reading_at: str | datetime | None = None,
    now: datetime | None = None,
    open_events: list[dict] | None = None,
) -> list[Emergency]:
    """Everything a reading and its assessment justify, already deduped.

    Ordered most severe first, so a partial failure loses the least important
    event rather than the one that mattered.
    """
    candidates = _dedupe(
        [
            *from_alerts(alerts or []),
            *(from_assessment(assessment) if assessment else []),
            *(from_silence(last_reading_at, now) if last_reading_at else []),
        ]
    )

    survivors = [c for c in candidates if should_escalate(c, open_events or [])]
    return sorted(survivors, key=lambda c: SEVERITY_RANK[c.severity], reverse=True)


def notice_title(candidate: Emergency, patient_name: str) -> str:
    """What the care team member's notification says first.

    Name then finding: a phone notification truncates, and the recipient's
    first question is always *who*.
    """
    return f"{patient_name} — {candidate.title_for}"


def _dedupe(candidates: list[Emergency]) -> list[Emergency]:
    """One event per type, keeping the most severe.

    The rule engine and the fall model can both report the same fall. That is
    one fall, and a queue showing it twice makes a clinician check whether the
    patient fell twice.
    """
    best: dict[str, Emergency] = {}

    for candidate in candidates:
        existing = best.get(candidate.event_type)
        if existing is None or SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[existing.severity]:
            best[candidate.event_type] = candidate

    return list(best.values())

"""Health risk scoring with exact attribution.

── Why this is an additive model and not a gradient-boosted one ──────────────

The brief asks for a risk score with a SHAP explanation. SHAP on a tree
ensemble gives *approximate* attributions to a model nobody can inspect. An
additive model over the same features gives attributions that are **exact by
construction** — each contribution is literally the term that was added, and
they sum to the score with no residual.

For a system whose entire job is to tell a clinician why it is worried, an
explanation that is the computation rather than a post-hoc estimate of it is
worth more than whatever accuracy the ensemble would have bought. And there is
no labelled outcome data here to have bought it with: nobody has told AVERIS
which of these patients deteriorated. A learned model would be fitted to
simulator output and would learn the simulator.

So the weights below are published escalation thresholds turned into a score,
not parameters estimated from data — and the module says so rather than
implying a training set that does not exist.

── Coverage discounting ─────────────────────────────────────────────────────

Every contribution is scaled by how much data produced it. A SpO2 decline
measured across four readings contributes less than the same decline across
four hundred. Without this, the quietest stream would produce the loudest
scores, because a feature computed from two points can take any value at all.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ..feature_engineering.features import FeatureSet

MODEL_VERSION = "vital-risk-v1"

# The category boundaries. LOW / MODERATE / HIGH / CRITICAL — MODERATE is this
# schema's spelling of the brief's MEDIUM.
#
# Each band is defined by what it should MEAN, then the number follows:
#
#   LOW       nothing outside its normal range
#   MODERATE  at least one signal past its early-warning threshold
#   HIGH      at least one signal past its *critical* escalation threshold
#   CRITICAL  two or more, or one plus a fall
#
# With severity 0.7 at the critical threshold, a lone SpO2 of 90% — the
# escalation trigger — scores 0.30 × 0.7 = 0.21, so HIGH starts just below it.
#
# Two earlier calibrations were wrong in ways worth recording. At
# 0.75/0.50/0.25, SpO2 88% with a heart rate of 150 read MODERATE. At
# 0.62/0.34/0.15, SpO2 92% showed "Warning" on its card while the overall risk
# said LOW — a contradiction a reader would rightly not trust.
BANDS = [(0.40, "CRITICAL"), (0.20, "HIGH"), (0.08, "MODERATE"), (0.0, "LOW")]


def _severity(value: float, warn: float, critical: float, saturate: float) -> float:
    """Severity anchored on both published thresholds, not one linear ramp.

    A single ramp from the warning threshold to an arbitrary endpoint treats
    the critical threshold as unremarkable — SpO2 90% and 93% end up a few
    percent apart on the scale even though one is an escalation trigger and the
    other is not. Two segments put a known clinical boundary at a known point
    on the scale: 0 at `warn`, 0.7 at `critical`, 1.0 at `saturate`.
    """
    if warn > saturate:  # descending signal, e.g. SpO2
        if value >= warn:
            return 0.0
        if value >= critical:
            return 0.7 * (warn - value) / (warn - critical)
        return min(1.0, 0.7 + 0.3 * (critical - value) / max(1e-6, critical - saturate))

    if value <= warn:  # ascending signal, e.g. heart rate
        return 0.0
    if value <= critical:
        return 0.7 * (value - warn) / (critical - warn)
    return min(1.0, 0.7 + 0.3 * (value - critical) / max(1e-6, saturate - critical))


@dataclass(frozen=True)
class Contribution:
    feature: str
    label: str
    # Points added to the raw score. Always >= 0: this model measures concern,
    # and a normal vital contributes nothing rather than subtracting.
    points: float
    observed: float | None
    threshold: float | None
    coverage: float
    detail: str

    @property
    def percentage_of(self) -> Callable[[float], float]:
        return lambda total: (self.points / total * 100.0) if total > 0 else 0.0


@dataclass(frozen=True)
class RiskAssessment:
    risk_score: float          # 0..1
    risk_level: str            # LOW / MODERATE / HIGH / CRITICAL
    confidence: float          # 0..1 — how much measured data backed it
    contributions: list[Contribution]
    model_version: str
    explanation: list[str]

    def to_dict(self) -> dict:
        total = sum(c.points for c in self.contributions) or 1.0
        return {
            "risk_score": round(self.risk_score, 4),
            "risk_level": self.risk_level,
            "confidence": round(self.confidence, 3),
            "model_version": self.model_version,
            "explanation": self.explanation,
            "contributions": [
                {
                    "feature": c.feature,
                    "label": c.label,
                    "points": round(c.points, 4),
                    "share_percent": round(c.points / total * 100.0, 1),
                    "observed": c.observed,
                    "threshold": c.threshold,
                    "coverage": round(c.coverage, 3),
                    "detail": c.detail,
                }
                for c in sorted(self.contributions, key=lambda c: -c.points)
            ],
        }


# Maximum points each signal can add. Ratios encode clinical urgency: oxygen
# desaturation outranks everything because it moves fastest and tolerates the
# least delay.
WEIGHTS = {
    "spo2_level": 0.30,
    "spo2_decline": 0.20,
    "hr_level": 0.20,
    "hr_trend": 0.10,
    "temp_level": 0.15,
    "fall": 0.25,
}


def assess(fs: FeatureSet) -> RiskAssessment:
    contributions: list[Contribution] = []

    _spo2_level(fs, contributions)
    _spo2_decline(fs, contributions)
    _heart_rate_level(fs, contributions)
    _heart_rate_trend(fs, contributions)
    _temperature_level(fs, contributions)
    _fall(fs, contributions)

    raw = sum(c.points for c in contributions)

    # Capped rather than normalised by the weight total. Normalising would mean
    # a patient with one critical signal and no other data scoring the same as
    # one with every signal critical, because the divisor would shrink with the
    # evidence.
    risk_score = min(1.0, raw)

    return RiskAssessment(
        risk_score=risk_score,
        risk_level=categorise(risk_score),
        confidence=_confidence(fs),
        contributions=contributions,
        model_version=MODEL_VERSION,
        explanation=_narrate(contributions),
    )


def categorise(score: float) -> str:
    for threshold, level in BANDS:
        if score >= threshold:
            return level
    return "LOW"


# ------------------------------------------------------------- contributions
def _spo2_level(fs: FeatureSet, out: list[Contribution]) -> None:
    feature = fs.get("spo2_current") or fs.get("spo2_median")
    if not feature or not feature.usable:
        return

    value = feature.value
    assert value is not None

    if value >= 94:
        return

    # 94 is the early-warning threshold, 90 the escalation point, 85 where the
    # difference between values stops being what matters.
    severity = _severity(value, warn=94.0, critical=90.0, saturate=85.0)
    points = WEIGHTS["spo2_level"] * severity * feature.coverage

    out.append(
        Contribution(
            feature="spo2_level",
            label="Low blood oxygen",
            points=points,
            observed=value,
            threshold=94.0,
            coverage=feature.coverage,
            detail=f"Blood oxygen at {value:.0f}%, below the 94% early-warning threshold.",
        )
    )


def _spo2_decline(fs: FeatureSet, out: list[Contribution]) -> None:
    feature = fs.get("spo2_decline_rate")
    if not feature or not feature.usable or feature.value is None or feature.value <= 0.05:
        return

    # A fall of 1%/min sustained is severe; the scale saturates there.
    severity = min(1.0, feature.value / 1.0)
    points = WEIGHTS["spo2_decline"] * severity * feature.coverage

    out.append(
        Contribution(
            feature="spo2_decline",
            label="Falling blood oxygen",
            points=points,
            observed=round(feature.value, 2),
            threshold=0.05,
            coverage=feature.coverage,
            detail=(
                f"Blood oxygen falling at about {feature.value:.2f}% per minute "
                f"across the last 15 minutes."
            ),
        )
    )


def _heart_rate_level(fs: FeatureSet, out: list[Contribution]) -> None:
    feature = fs.get("hr_current") or fs.get("hr_median")
    if not feature or not feature.usable:
        return

    value = feature.value
    assert value is not None

    activity = fs.value("activity_level", 0.0) or 0.0

    if value > 120:
        severity = _severity(value, warn=120.0, critical=150.0, saturate=170.0)
        # Exertion is a legitimate reason for a fast heart rate. Not
        # discounting for it produces a system that alarms every time its
        # wearer climbs stairs, and a system that alarms on stairs gets muted.
        exertion_discount = 1.0 - 0.5 * activity
        points = WEIGHTS["hr_level"] * severity * exertion_discount * feature.coverage
        detail = f"Heart rate {value:.0f} BPM, above the 120 BPM threshold."
        if activity > 0.5:
            detail += " Partly discounted: the device also reports activity."
    elif value < 50:
        severity = _severity(value, warn=50.0, critical=40.0, saturate=32.0)
        points = WEIGHTS["hr_level"] * severity * feature.coverage
        detail = f"Heart rate {value:.0f} BPM, below the 50 BPM threshold."
    else:
        return

    out.append(
        Contribution(
            feature="hr_level",
            label="Heart rate outside range",
            points=points,
            observed=value,
            threshold=120.0 if value > 120 else 50.0,
            coverage=feature.coverage,
            detail=detail,
        )
    )


def _heart_rate_trend(fs: FeatureSet, out: list[Contribution]) -> None:
    feature = fs.get("hr_slope")
    if not feature or not feature.usable or feature.value is None:
        return

    slope = feature.value
    if slope <= 1.0:  # BPM per minute
        return

    severity = min(1.0, (slope - 1.0) / 4.0)
    points = WEIGHTS["hr_trend"] * severity * feature.coverage

    out.append(
        Contribution(
            feature="hr_trend",
            label="Rising heart rate",
            points=points,
            observed=round(slope, 2),
            threshold=1.0,
            coverage=feature.coverage,
            detail=f"Heart rate rising at about {slope:.1f} BPM per minute.",
        )
    )


def _temperature_level(fs: FeatureSet, out: list[Contribution]) -> None:
    feature = fs.get("temp_current") or fs.get("temp_median")
    if not feature or not feature.usable:
        return

    value = feature.value
    assert value is not None

    if value > 38.0:
        severity = _severity(value, warn=38.0, critical=39.5, saturate=41.0)
        threshold = 38.0
        detail = f"Temperature {value:.1f}°C, above the 38.0°C threshold."
    elif value < 35.5:
        severity = _severity(value, warn=35.5, critical=35.0, saturate=33.5)
        threshold = 35.5
        detail = f"Temperature {value:.1f}°C, below the 35.5°C threshold."
    else:
        return

    out.append(
        Contribution(
            feature="temp_level",
            label="Temperature outside range",
            points=WEIGHTS["temp_level"] * severity * feature.coverage,
            observed=value,
            threshold=threshold,
            coverage=feature.coverage,
            detail=detail,
        )
    )


def _fall(fs: FeatureSet, out: list[Contribution]) -> None:
    feature = fs.get("fall_flagged")
    if not feature or not feature.usable or not feature.value:
        return

    out.append(
        Contribution(
            feature="fall",
            label="Possible fall",
            # Not scaled by coverage: a fall is a single event, and a window
            # containing few readings does not make the one that flagged it
            # less real.
            points=WEIGHTS["fall"],
            observed=1.0,
            threshold=None,
            coverage=feature.coverage,
            detail="The device reported a movement pattern consistent with a fall.",
        )
    )


# ------------------------------------------------------------------ support
def _confidence(fs: FeatureSet) -> float:
    """How much measured data the score rested on.

    Explicitly not the model's accuracy — there is no held-out set here to have
    measured accuracy against. Reporting one would be inventing a number about
    a number.
    """
    coverages = [f.coverage for f in fs.features.values() if f.sample_count > 0]
    if not coverages:
        return 0.0
    return round(min(1.0, sum(coverages) / len(coverages)), 3)


def _narrate(contributions: list[Contribution]) -> list[str]:
    """Plain sentences, strongest first. Every one names a number."""
    if not contributions:
        return ["All monitored vital signs are within their usual ranges."]
    return [c.detail for c in sorted(contributions, key=lambda c: -c.points)]

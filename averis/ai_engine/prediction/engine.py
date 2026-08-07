"""The health intelligence engine — one entry point over the whole pipeline.

    raw rows → clean → features → risk + anomalies + trends + fall → assessment

Everything below is pure with respect to the database: it takes rows and
returns a result. Persistence and transport live in the service that calls it,
so the analysis can be exercised end to end from a list of dicts.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from ..feature_engineering.features import FeatureSet, extract
from ..models.anomaly import AnomalyResult, detect_all
from ..models.fall_detector import FallPrediction, predict as predict_fall
from ..preprocessing.clean import CleaningReport, Sample, clean, in_window
from .risk_engine import RiskAssessment, assess
from .trends import Insight, analyse

ENGINE_VERSION = "averis-health-intelligence-v1"

# The disclaimer every output carries. Not optional and not configurable: an
# output that reached a patient without it would be indistinguishable from a
# clinical finding.
DISCLAIMER = (
    "AVERIS detects patterns in sensor data. It does not diagnose, and it is not a "
    "medical device. Discuss anything here with a healthcare professional, and contact "
    "emergency services if you feel unwell."
)


@dataclass(frozen=True)
class HealthAssessment:
    risk: RiskAssessment
    anomalies: list[AnomalyResult]
    insights: list[Insight]
    fall: FallPrediction | None
    features: FeatureSet
    cleaning: CleaningReport
    engine_version: str
    disclaimer: str

    def to_dict(self) -> dict:
        return {
            **self.risk.to_dict(),
            "engine_version": self.engine_version,
            "anomalies": [a.to_dict() for a in self.anomalies],
            "insights": [i.to_dict() for i in self.insights],
            "fall": self.fall.to_dict() if self.fall else None,
            "features": self.features.to_dict(),
            "data_quality": {
                "received": self.cleaning.received,
                "kept": self.cleaning.kept,
                "retained_fraction": round(self.cleaning.retained_fraction, 3),
                "dropped_implausible": self.cleaning.dropped_implausible,
                "dropped_duplicate": self.cleaning.dropped_duplicate,
            },
            "disclaimer": self.disclaimer,
        }


def analyse_stream(rows: list[dict], now: datetime | None = None) -> HealthAssessment:
    """Runs the full pipeline over a patient's recent readings."""
    now = now or datetime.now(timezone.utc)

    samples, cleaning = clean(rows)
    features = extract(samples, now)

    risk = assess(features)
    anomalies = detect_all(samples, now)
    insights = analyse(samples, features, now)
    fall = _fall_from_samples(samples, now)

    # A model-detected fall outranks whatever the vital signs said. The score
    # is not recomputed — that would make the contributions stop summing to it
    # — the *level* is escalated, and the reason is recorded in the insights.
    if fall and fall.detected and risk.risk_level in ("LOW", "MODERATE"):
        risk = RiskAssessment(
            risk_score=risk.risk_score,
            risk_level="HIGH",
            confidence=risk.confidence,
            contributions=risk.contributions,
            model_version=risk.model_version,
            explanation=[fall.detail, *risk.explanation],
        )

    return HealthAssessment(
        risk=risk,
        anomalies=anomalies,
        insights=insights,
        fall=fall,
        features=features,
        cleaning=cleaning,
        engine_version=ENGINE_VERSION,
        disclaimer=DISCLAIMER,
    )


def _fall_from_samples(samples: list[Sample], now: datetime) -> FallPrediction | None:
    """Runs the fall model over the most recent IMU window.

    Most devices have no accelerometer, so this returns None far more often
    than not — and that is a legitimate result, not a failure. A monitor that
    invented a fall verdict for a pulse oximeter would be worse than one that
    says nothing.
    """
    from datetime import timedelta

    recent = in_window(samples, timedelta(seconds=90), now)
    accel = [s.accel for s in recent if s.accel is not None]
    gyro = [s.gyro for s in recent if s.gyro is not None]

    if len(accel) < 8 or len(gyro) < 8:
        return None

    return predict_fall(accel[-24:], gyro[-24:])

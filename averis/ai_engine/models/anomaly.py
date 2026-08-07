"""Anomaly detection against a patient's own baseline.

── Why not a globally trained Isolation Forest ──────────────────────────────

The brief suggests Isolation Forest or an autoencoder. Both need a training
corpus, and AVERIS has none: there is no archive of real patient telemetry
here. Fitting either on simulator output would produce a model that has learned
the simulator's random walk and nothing about physiology — it would flag
whatever the simulator does rarely, which is an artefact of the `VitalSign.step`
constants rather than a fact about people.

There is also a clinical objection that survives even with real data. A model
trained across a population answers "is this unusual for people?" — but a
resting heart rate of 48 is unremarkable for a trained athlete and a finding in
someone whose baseline is 85. The question worth asking is **"is this unusual
for *this* patient?"**, and that one needs no corpus at all, because the
patient's own history is the training set.

So: robust per-patient baselines, updated from the same stream being scored.
Median and MAD rather than mean and standard deviation — one 200 BPM artefact
shifts a mean by several beats and inflates an SD enormously, while barely
moving a median. On a stream where bad readings are routine, the non-robust
version spends most of its time reacting to noise.

This is a real anomaly detector, just not a learned one, and the difference is
stated rather than papered over.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from ..preprocessing.clean import Sample, in_window, values

MODEL_VERSION = "personal-baseline-v1"

# Below this many readings a baseline is a guess. Reporting "unusual" from four
# samples would mean the first hour of every device flagging constantly.
MIN_BASELINE_SAMPLES = 30

# How far back a baseline is drawn from.
BASELINE_WINDOW = timedelta(hours=6)

# Robust z beyond which a value is called unusual. 3.5 is the conventional
# threshold for modified z-scores and is deliberately not tuned to make the
# demo look responsive.
ANOMALY_Z = 3.5


@dataclass(frozen=True)
class Baseline:
    channel: str
    median: float
    mad: float
    samples: int

    @property
    def usable(self) -> bool:
        # A MAD of zero means every reading was identical — a stuck sensor, not
        # a stable patient. Dividing by it would make the next different value
        # infinitely anomalous.
        return self.samples >= MIN_BASELINE_SAMPLES and self.mad > 1e-6


@dataclass(frozen=True)
class AnomalyResult:
    channel: str
    status: str            # "normal" | "abnormal" | "insufficient_baseline"
    observed: float | None
    baseline_median: float | None
    robust_z: float | None
    confidence: float      # 0..1
    detail: str

    def to_dict(self) -> dict:
        return {
            "channel": self.channel,
            "status": self.status,
            "observed": self.observed,
            "baseline_median": self.baseline_median,
            "robust_z": round(self.robust_z, 2) if self.robust_z is not None else None,
            "confidence": round(self.confidence, 3),
            "detail": self.detail,
        }


def build_baseline(samples: list[Sample], channel: str, now: datetime) -> Baseline | None:
    window = values(in_window(samples, BASELINE_WINDOW, now), channel)
    if len(window) < MIN_BASELINE_SAMPLES:
        return Baseline(channel, 0.0, 0.0, len(window))

    med = _median(window)
    assert med is not None
    mad = 1.4826 * (_median([abs(v - med) for v in window]) or 0.0)

    return Baseline(channel, med, mad, len(window))


def detect(samples: list[Sample], channel: str, now: datetime) -> AnomalyResult:
    baseline = build_baseline(samples, channel, now)
    current = values(in_window(samples, timedelta(minutes=2), now), channel)
    observed = current[-1] if current else None

    label = {"heart_rate": "Heart rate", "spo2": "Blood oxygen", "temperature": "Temperature"}[
        channel
    ]

    if observed is None:
        return AnomalyResult(
            channel, "insufficient_baseline", None, None, None, 0.0,
            f"No recent {label.lower()} reading to compare.",
        )

    if baseline is None or not baseline.usable:
        got = baseline.samples if baseline else 0
        return AnomalyResult(
            channel,
            "insufficient_baseline",
            observed,
            baseline.median if baseline and baseline.samples else None,
            None,
            0.0,
            (
                f"Not enough history yet to say what is usual for you — "
                f"{got} of {MIN_BASELINE_SAMPLES} readings needed."
            ),
        )

    robust_z = (observed - baseline.median) / baseline.mad
    abnormal = abs(robust_z) >= ANOMALY_Z

    # Confidence grows with the baseline's size and saturates. It describes how
    # well established the baseline is, not how likely the patient is unwell.
    confidence = min(1.0, 0.5 + 0.5 * min(1.0, baseline.samples / (MIN_BASELINE_SAMPLES * 4)))

    direction = "above" if robust_z > 0 else "below"
    detail = (
        f"{label} is {observed:g}, {abs(robust_z):.1f} robust deviations {direction} "
        f"your usual {baseline.median:g} over the last 6 hours."
        if abnormal
        else f"{label} is close to your usual {baseline.median:g}."
    )

    return AnomalyResult(
        channel=channel,
        status="abnormal" if abnormal else "normal",
        observed=observed,
        baseline_median=baseline.median,
        robust_z=robust_z,
        confidence=confidence,
        detail=detail,
    )


def detect_all(samples: list[Sample], now: datetime) -> list[AnomalyResult]:
    return [detect(samples, channel, now) for channel in ("heart_rate", "spo2", "temperature")]


def _median(xs: list[float]) -> float | None:
    if not xs:
        return None
    ordered = sorted(xs)
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2

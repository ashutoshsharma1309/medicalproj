"""Trend observations over the sensor stream.

The distinction this module exists for: an **alert** says a threshold was
crossed now; an **insight** says something about a shape over time. "SpO2 is
88%" and "SpO2 has fallen steadily for fifteen minutes" are different findings,
and the second can be true while every individual reading is still in range —
which is precisely the case worth catching early.

Every insight states the window, both endpoints, and the rate. A trend claim
without its numbers is unfalsifiable, and an unfalsifiable claim about someone's
health is worse than no claim.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from ..feature_engineering.features import FeatureSet
from ..preprocessing.clean import Sample, in_window, values

# A trend needs enough points that it is a shape rather than two readings and a
# line drawn between them.
MIN_POINTS = 6

# Rates below these are drift, not trends. Set so an ordinary resting series
# does not generate an insight every fifteen minutes — a feed that always has
# something to say is a feed nobody reads.
MATERIAL = {
    "spo2": 0.10,          # % per minute
    "heart_rate": 1.0,     # BPM per minute
    "temperature": 0.02,   # °C per minute
}


@dataclass(frozen=True)
class Insight:
    insight_type: str      # matches public.insight_kind
    message: str
    severity: str          # INFO | WARNING | CRITICAL
    evidence: dict
    confidence: float
    window_start: datetime
    window_end: datetime

    def to_dict(self) -> dict:
        return {
            "insight_type": self.insight_type,
            "message": self.message,
            "severity": self.severity,
            "evidence": self.evidence,
            "confidence": round(self.confidence, 3),
            "window_start": self.window_start.isoformat(),
            "window_end": self.window_end.isoformat(),
        }


WINDOW = timedelta(minutes=15)


def analyse(samples: list[Sample], fs: FeatureSet, now: datetime) -> list[Insight]:
    insights: list[Insight] = []
    window = in_window(samples, WINDOW, now)
    start = now - WINDOW

    _channel_trend(insights, fs, window, "spo2", "spo2_slope", "Blood oxygen", "%", start, now)
    _channel_trend(insights, fs, window, "heart_rate", "hr_slope", "Heart rate", " BPM", start, now)
    _channel_trend(
        insights, fs, window, "temperature", "temp_slope", "Temperature", "°C", start, now
    )

    _correlated_decline(insights, fs, start, now)
    _data_gap(insights, fs, window, start, now)

    return insights


def _channel_trend(
    out: list[Insight],
    fs: FeatureSet,
    window: list[Sample],
    channel: str,
    slope_feature: str,
    label: str,
    unit: str,
    start: datetime,
    now: datetime,
) -> None:
    feature = fs.get(slope_feature)
    series = values(window, channel)

    if not feature or feature.value is None or len(series) < MIN_POINTS:
        return

    slope = feature.value
    if abs(slope) < MATERIAL[channel]:
        return

    first, last = series[0], series[-1]
    change = last - first
    rising = slope > 0

    # A falling SpO2 is a finding; a rising one is not. Heart rate and
    # temperature are treated symmetrically because both directions matter.
    if channel == "spo2" and rising:
        return

    severity = "INFO"
    if channel == "spo2" and abs(slope) >= 0.3:
        severity = "WARNING"
    elif channel == "heart_rate" and abs(slope) >= 3.0:
        severity = "WARNING"
    elif channel == "temperature" and abs(slope) >= 0.05:
        severity = "WARNING"

    direction = "increased" if rising else "decreased"
    minutes = max(1, int((now - start).total_seconds() // 60))

    out.append(
        Insight(
            insight_type="TREND_RISE" if rising else "TREND_DECLINE",
            message=(
                f"{label} has {direction} from {first:g}{unit} to {last:g}{unit} "
                f"over the last {minutes} minutes."
            ),
            severity=severity,
            evidence={
                "channel": channel,
                "first": first,
                "last": last,
                "change": round(change, 2),
                "slope_per_minute": round(slope, 3),
                "samples": len(series),
                "coverage": round(feature.coverage, 3),
            },
            confidence=feature.coverage,
            window_start=start,
            window_end=now,
        )
    )


def _correlated_decline(out: list[Insight], fs: FeatureSet, start: datetime, now: datetime) -> None:
    """Falling oxygen alongside a rising heart rate.

    This is the observation the brief's example asks for, and it is worth
    calling out separately because neither signal alone need have crossed a
    threshold. A body compensating for falling oxygen by pushing the heart
    faster is a pattern; two independent alerts would not say so.

    It is still a pattern and not a diagnosis, and the wording keeps it that
    way — it describes what the numbers did, and leaves what it means to a
    clinician.
    """
    spo2_slope = fs.value("spo2_slope")
    hr_slope = fs.value("hr_slope")

    if spo2_slope is None or hr_slope is None:
        return
    if spo2_slope >= -MATERIAL["spo2"] or hr_slope <= MATERIAL["heart_rate"]:
        return

    spo2_coverage = fs.get("spo2_slope").coverage if fs.get("spo2_slope") else 0.0
    hr_coverage = fs.get("hr_slope").coverage if fs.get("hr_slope") else 0.0

    out.append(
        Insight(
            insight_type="PATTERN_CORRELATION",
            message=(
                f"Blood oxygen is falling ({spo2_slope:.2f}% per minute) while heart rate is "
                f"rising ({hr_slope:.1f} BPM per minute). These moving together is worth "
                f"raising with a healthcare professional."
            ),
            severity="WARNING",
            evidence={
                "spo2_slope_per_minute": round(spo2_slope, 3),
                "hr_slope_per_minute": round(hr_slope, 3),
                "spo2_coverage": round(spo2_coverage, 3),
                "hr_coverage": round(hr_coverage, 3),
            },
            confidence=min(spo2_coverage, hr_coverage),
            window_start=start,
            window_end=now,
        )
    )


def _data_gap(
    out: list[Insight],
    fs: FeatureSet,
    window: list[Sample],
    start: datetime,
    now: datetime,
) -> None:
    """Says so when the window is mostly empty.

    Without this, thin coverage is invisible: the cards show a number, the
    charts show a line, and nothing distinguishes a monitored patient from one
    whose device has been asleep. A monitoring system that cannot say "I am not
    seeing much" is misleading by omission.
    """
    coverages = [f.coverage for f in fs.features.values() if f.sample_count > 0]
    if not coverages:
        return

    average = sum(coverages) / len(coverages)
    if average >= 0.4:
        return

    out.append(
        Insight(
            insight_type="DATA_GAP",
            message=(
                f"Only about {average * 100:.0f}% of the last 15 minutes carried readings, "
                f"so any trend shown is based on limited data."
            ),
            severity="INFO",
            evidence={"coverage": round(average, 3), "samples": len(window)},
            confidence=1.0,
            window_start=start,
            window_end=now,
        )
    )

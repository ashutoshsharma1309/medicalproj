"""Features over the sensor stream.

Every feature carries its own coverage. That is the design decision the rest of
the engine rests on: a feature is never just a number, it is a number plus how
much data produced it, and the risk engine weights accordingly. Without it, a
heart-rate trend computed from two readings and one computed from six hundred
would enter the score identically.

Robust statistics throughout — median and MAD rather than mean and standard
deviation. A single 200 BPM artefact moves a mean by several beats and a
standard deviation enormously; it moves a median by almost nothing. On a stream
where a bad reading is routine, the non-robust version would spend most of its
time reacting to sensor noise.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from ..preprocessing.clean import Sample, coverage, in_window, values


@dataclass(frozen=True)
class Feature:
    """A value and the evidence behind it."""

    name: str
    value: float | None
    # 0..1 — how much of the window carried data. Not model confidence.
    coverage: float
    sample_count: int
    unit: str = ""

    @property
    def usable(self) -> bool:
        return self.value is not None and self.sample_count > 0


@dataclass
class FeatureSet:
    features: dict[str, Feature] = field(default_factory=dict)
    window_start: datetime | None = None
    window_end: datetime | None = None

    def add(self, feature: Feature) -> None:
        self.features[feature.name] = feature

    def get(self, name: str) -> Feature | None:
        return self.features.get(name)

    def value(self, name: str, default: float | None = None) -> float | None:
        feature = self.features.get(name)
        return feature.value if feature and feature.usable else default

    def to_dict(self) -> dict:
        return {
            name: {
                "value": f.value,
                "coverage": round(f.coverage, 3),
                "samples": f.sample_count,
                "unit": f.unit,
            }
            for name, f in self.features.items()
        }


# The window every trend is measured over. Long enough that a change is a
# change and not a breath; short enough to be actionable.
TREND_WINDOW = timedelta(minutes=15)
SHORT_WINDOW = timedelta(minutes=2)


def extract(samples: list[Sample], now: datetime) -> FeatureSet:
    fs = FeatureSet(window_start=now - TREND_WINDOW, window_end=now)

    recent = in_window(samples, TREND_WINDOW, now)
    immediate = in_window(samples, SHORT_WINDOW, now)

    _heart_rate(fs, samples, recent, immediate, now)
    _spo2(fs, samples, recent, immediate, now)
    _temperature(fs, samples, recent, now)
    _movement(fs, recent)

    return fs


# ----------------------------------------------------------------- heart rate
def _heart_rate(
    fs: FeatureSet,
    samples: list[Sample],
    recent: list[Sample],
    immediate: list[Sample],
    now: datetime,
) -> None:
    cov = coverage(samples, "heart_rate", TREND_WINDOW, now)
    window = values(recent, "heart_rate")
    latest = values(immediate, "heart_rate")

    fs.add(Feature("hr_current", latest[-1] if latest else None, cov, len(latest), "BPM"))
    fs.add(Feature("hr_median", _median(window), cov, len(window), "BPM"))
    fs.add(Feature("hr_max", max(window) if window else None, cov, len(window), "BPM"))
    fs.add(Feature("hr_min", min(window) if window else None, cov, len(window), "BPM"))

    # Variability as MAD, not standard deviation. On a stream where one bad
    # reading per minute is normal, SD mostly measures the artefacts.
    fs.add(Feature("hr_variation", _mad(window), cov, len(window), "BPM"))

    fs.add(
        Feature(
            "hr_slope",
            _slope([(s.t, s.heart_rate) for s in recent]),
            cov,
            len(window),
            "BPM/min",
        )
    )


# ---------------------------------------------------------------------- SpO2
def _spo2(
    fs: FeatureSet,
    samples: list[Sample],
    recent: list[Sample],
    immediate: list[Sample],
    now: datetime,
) -> None:
    cov = coverage(samples, "spo2", TREND_WINDOW, now)
    window = values(recent, "spo2")
    latest = values(immediate, "spo2")

    fs.add(Feature("spo2_current", latest[-1] if latest else None, cov, len(latest), "%"))
    fs.add(Feature("spo2_median", _median(window), cov, len(window), "%"))
    fs.add(Feature("spo2_min", min(window) if window else None, cov, len(window), "%"))

    slope = _slope([(s.t, s.spo2) for s in recent])
    fs.add(Feature("spo2_slope", slope, cov, len(window), "%/min"))

    # Decline is broken out as its own positive-valued feature so the risk
    # engine can weight a fall without also rewarding a rise. Oxygen going up
    # is not the opposite of oxygen going down in risk terms — it is simply not
    # a finding.
    fs.add(
        Feature(
            "spo2_decline_rate",
            max(0.0, -slope) if slope is not None else None,
            cov,
            len(window),
            "%/min",
        )
    )


# --------------------------------------------------------------- temperature
def _temperature(fs: FeatureSet, samples: list[Sample], recent: list[Sample], now: datetime) -> None:
    cov = coverage(samples, "temperature", TREND_WINDOW, now)
    window = values(recent, "temperature")

    fs.add(Feature("temp_current", window[-1] if window else None, cov, len(window), "°C"))
    fs.add(Feature("temp_median", _median(window), cov, len(window), "°C"))
    fs.add(Feature("temp_max", max(window) if window else None, cov, len(window), "°C"))
    fs.add(
        Feature(
            "temp_slope",
            _slope([(s.t, s.temperature) for s in recent]),
            cov,
            len(window),
            "°C/min",
        )
    )


# ------------------------------------------------------------------ movement
def _movement(fs: FeatureSet, recent: list[Sample]) -> None:
    if not recent:
        for name in ("activity_level", "fall_flagged", "movement_changes"):
            fs.add(Feature(name, None, 0.0, 0))
        return

    weights = {"RESTING": 0.0, "NORMAL": 0.35, "ACTIVE": 1.0, "FALL_SUSPECTED": 0.5, "UNKNOWN": 0.35}
    scores = [weights.get(s.movement, 0.35) for s in recent]

    fs.add(Feature("activity_level", sum(scores) / len(scores), 1.0, len(recent)))
    fs.add(
        Feature(
            "fall_flagged",
            1.0 if any(s.movement == "FALL_SUSPECTED" for s in recent) else 0.0,
            1.0,
            len(recent),
        )
    )

    # Transitions, not states. Someone alternating rest and activity every few
    # seconds is a different picture from someone walking steadily, and the
    # mean activity level cannot tell them apart.
    changes = sum(1 for a, b in zip(recent, recent[1:]) if a.movement != b.movement)
    fs.add(Feature("movement_changes", float(changes), 1.0, len(recent)))


# ------------------------------------------------------------------- helpers
def _median(xs: list[float]) -> float | None:
    if not xs:
        return None
    ordered = sorted(xs)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def _mad(xs: list[float]) -> float | None:
    """Median absolute deviation, scaled to be comparable with a standard
    deviation on normally distributed data."""
    if len(xs) < 2:
        return None
    med = _median(xs)
    assert med is not None
    return 1.4826 * (_median([abs(x - med) for x in xs]) or 0.0)


def _slope(series: list[tuple[datetime, float | None]]) -> float | None:
    """Least-squares slope per minute, over present values only.

    Gaps are skipped rather than interpolated. Fitting through an invented
    midpoint would produce a trend partly supported by data that was never
    measured, and the slope is the input the strongest insights are built on.
    """
    points = [(t, v) for t, v in series if v is not None]
    if len(points) < 3:
        # Two points define a line through any noise at all. Three is the
        # minimum at which "trend" means more than "these two differ".
        return None

    t0 = points[0][0]
    xs = [(t - t0).total_seconds() / 60.0 for t, _ in points]
    ys = [v for _, v in points]

    n = len(xs)
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n

    denominator = sum((x - mean_x) ** 2 for x in xs)
    if denominator < 1e-9:
        # Every sample at the same instant: no time base, so no slope.
        return None

    numerator = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    slope = numerator / denominator

    return slope if math.isfinite(slope) else None

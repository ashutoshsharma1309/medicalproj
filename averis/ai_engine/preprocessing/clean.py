"""Cleaning and imputation for the sensor stream.

Pure and dependency-free, so the same code runs in the ingest service (which
carries no ML stack) and in the offline trainer.

Three rules shape everything here.

**A gap is not a value.** The obvious way to handle a missing SpO2 is to carry
the last one forward. That is wrong for vitals in a specific way: a device that
stopped transmitting for ten minutes produces a flat line at the last good
reading, which is exactly the picture of a stable patient. The absence of data
and the presence of stability are opposite findings, and forward-fill makes them
identical. So gaps stay gaps, and every downstream feature reports how much of
its window was actually measured.

**Outliers are dropped, not clipped.** Clipping a 4000 BPM sensor fault to 250
turns a broken device into a tachycardic patient. The reading is discarded and
counted.

**Nothing is invented.** There is no imputation from population means anywhere
in this module. A feature computed from too little data reports low coverage and
the risk engine discounts it; it never gets filled in with what an average
person would have.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

# Ranges a living human produces. Mirrors the database CHECK constraints and
# the wire validator — three copies exist because they run in three places, and
# the conformance vectors assert they agree.
PLAUSIBLE = {
    "heart_rate": (20.0, 250.0),
    "spo2": (50.0, 100.0),
    "temperature": (25.0, 45.0),
}


@dataclass(frozen=True)
class Sample:
    """One cleaned reading. Any channel may be absent."""

    t: datetime
    heart_rate: float | None = None
    spo2: float | None = None
    temperature: float | None = None
    movement: str = "UNKNOWN"
    accel: tuple[float, float, float] | None = None
    gyro: tuple[float, float, float] | None = None


@dataclass
class CleaningReport:
    """What cleaning did, so the caller can tell a quiet stream from a clean one."""

    received: int = 0
    kept: int = 0
    dropped_implausible: dict[str, int] = field(default_factory=dict)
    dropped_duplicate: int = 0
    out_of_order: int = 0

    @property
    def retained_fraction(self) -> float:
        return self.kept / self.received if self.received else 0.0


def clean(raw: list[dict]) -> tuple[list[Sample], CleaningReport]:
    """Turns stored rows into ordered, plausible samples."""
    report = CleaningReport(received=len(raw))
    samples: list[Sample] = []
    seen: set[datetime] = set()
    previous_t: datetime | None = None

    for row in raw:
        t = _parse_time(row.get("recorded_at"))
        if t is None:
            continue

        # A device that resends after a reconnect produces exact duplicates.
        # Keeping them would weight that instant twice in every average.
        if t in seen:
            report.dropped_duplicate += 1
            continue
        seen.add(t)

        if previous_t is not None and t < previous_t:
            # Buffered readings arrive late and out of order. Counted, not
            # dropped — they are real measurements, just delayed.
            report.out_of_order += 1
        previous_t = t

        heart_rate = _plausible(row.get("heart_rate"), "heart_rate", report)
        spo2 = _plausible(row.get("spo2"), "spo2", report)
        temperature = _plausible(row.get("temperature"), "temperature", report)

        samples.append(
            Sample(
                t=t,
                heart_rate=heart_rate,
                spo2=spo2,
                temperature=temperature,
                movement=str(row.get("movement_status") or "UNKNOWN").upper(),
                accel=_triple(row, "accel_x", "accel_y", "accel_z"),
                gyro=_triple(row, "gyro_x", "gyro_y", "gyro_z"),
            )
        )

    samples.sort(key=lambda s: s.t)
    report.kept = len(samples)
    return samples, report


def coverage(
    samples: list[Sample],
    channel: str,
    window: timedelta,
    now: datetime,
    expected_interval: timedelta = timedelta(seconds=2),
) -> float:
    """How much of a window carried data for one channel, in 0..1.

    This is what lets the risk engine distinguish "stable" from "silent". A
    trend across three readings in fifteen minutes and one across four hundred
    are different claims, and only this number separates them.
    """
    expected = max(1.0, window / expected_interval)
    present = sum(
        1
        for s in samples
        if now - window <= s.t <= now and getattr(s, channel) is not None
    )
    return min(1.0, present / expected)


def in_window(samples: list[Sample], window: timedelta, now: datetime) -> list[Sample]:
    start = now - window
    return [s for s in samples if start <= s.t <= now]


def values(samples: list[Sample], channel: str) -> list[float]:
    """Present values for one channel. Gaps are omitted, never filled."""
    return [v for v in (getattr(s, channel) for s in samples) if v is not None]


def _plausible(value: object, channel: str, report: CleaningReport) -> float | None:
    if value is None:
        return None

    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None

    if parsed != parsed:  # NaN
        return None

    low, high = PLAUSIBLE[channel]
    if parsed < low or parsed > high:
        # Dropped, not clipped: clipping 4000 BPM to 250 converts a broken
        # sensor into a tachycardic patient.
        report.dropped_implausible[channel] = report.dropped_implausible.get(channel, 0) + 1
        return None

    return parsed


def _triple(row: dict, *keys: str) -> tuple[float, float, float] | None:
    out: list[float] = []
    for key in keys:
        value = row.get(key)
        if value is None:
            return None
        try:
            out.append(float(value))
        except (TypeError, ValueError):
            return None
    return (out[0], out[1], out[2])


def _parse_time(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None

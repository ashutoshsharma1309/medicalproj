"""IMU features for fall detection.

Pure and dependency-free: the trainer and the serving path compute features
with this same module, so a feature that means one thing at fit time cannot
mean another at inference time. That skew is the classic way a model that
scored well offline behaves strangely in production, and sharing the code is
the only reliable cure.

── What a fall looks like to an accelerometer ──────────────────────────────

The features below are not arbitrary statistics; each corresponds to a phase of
the event, which is why they generalise beyond whatever data fitted them:

  1. **Free-fall.** Magnitude drops toward 0g as the body accelerates downward.
     Nothing in ordinary activity produces a sustained sub-0.5g reading.
  2. **Impact.** A sharp spike, typically well above 2g.
  3. **Reorientation.** The gravity vector ends up pointing along a different
     body axis than it started, because the person is now horizontal.
  4. **Stillness after.** Post-impact variance collapses.

Sitting down heavily produces (2) and part of (3) but no free-fall and no
stillness. That is the discrimination that matters, and it is why the window
covers time either side of the peak rather than the peak alone.
"""

from __future__ import annotations

import math

# Feature order is part of the artifact contract. The trainer writes it into
# the artifact and the server asserts against it, so a reordering here cannot
# silently feed the model a permuted vector.
FEATURE_NAMES = [
    "accel_min",
    "accel_max",
    "accel_range",
    "accel_std",
    "gyro_max",
    "gyro_std",
    "orientation_change",
    "post_impact_stillness",
    "free_fall_samples",
]


def magnitude(vector: tuple[float, float, float]) -> float:
    x, y, z = vector
    return math.sqrt(x * x + y * y + z * z)


def extract_window(
    accel: list[tuple[float, float, float]],
    gyro: list[tuple[float, float, float]],
) -> list[float] | None:
    """Features for one window of IMU samples.

    Returns None when the window is too short to describe a phase sequence —
    better no prediction than one from three samples.
    """
    if len(accel) < 8 or len(gyro) < 8:
        return None

    accel_mags = [magnitude(a) for a in accel]
    gyro_mags = [magnitude(g) for g in gyro]

    peak_index = accel_mags.index(max(accel_mags))

    # Orientation before and after, from the gravity direction. A person who
    # was upright and is now horizontal shows a large angle here; someone who
    # sat down does not.
    lead = accel[: max(1, peak_index)]
    tail = accel[min(len(accel) - 1, peak_index + 1) :]
    orientation_change = _angle_between(_mean_vector(lead), _mean_vector(tail)) if tail else 0.0

    # Stillness after impact. A fall ends with the person on the floor; a
    # stumble that was caught does not.
    post = accel_mags[peak_index + 1 :]
    post_stillness = 1.0 / (1.0 + _std(post)) if len(post) >= 3 else 0.0

    return [
        min(accel_mags),
        max(accel_mags),
        max(accel_mags) - min(accel_mags),
        _std(accel_mags),
        max(gyro_mags),
        _std(gyro_mags),
        orientation_change,
        post_stillness,
        float(sum(1 for m in accel_mags if m < 0.5)),
    ]


def _mean_vector(vectors: list[tuple[float, float, float]]) -> tuple[float, float, float]:
    if not vectors:
        return (0.0, 0.0, 1.0)
    n = len(vectors)
    return (
        sum(v[0] for v in vectors) / n,
        sum(v[1] for v in vectors) / n,
        sum(v[2] for v in vectors) / n,
    )


def _angle_between(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    """Degrees between two vectors."""
    na, nb = magnitude(a), magnitude(b)
    if na < 1e-6 or nb < 1e-6:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b)) / (na * nb)
    return math.degrees(math.acos(max(-1.0, min(1.0, dot))))


def _std(xs: list[float]) -> float:
    if len(xs) < 2:
        return 0.0
    mean = sum(xs) / len(xs)
    return math.sqrt(sum((x - mean) ** 2 for x in xs) / len(xs))

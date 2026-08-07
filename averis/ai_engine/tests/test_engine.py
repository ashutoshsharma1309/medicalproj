"""Tests for the health intelligence engine.

    ml/.venv/bin/python -m pytest ai_engine/tests -q
"""

from __future__ import annotations

import math
import pathlib
import random
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

import pytest  # noqa: E402

from ai_engine.feature_engineering.features import extract  # noqa: E402
from ai_engine.models.anomaly import MIN_BASELINE_SAMPLES, detect  # noqa: E402
from ai_engine.models.fall_detector import predict as predict_fall  # noqa: E402
from ai_engine.models.fall_features import extract_window  # noqa: E402
from ai_engine.preprocessing.clean import clean  # noqa: E402
from ai_engine.prediction.engine import DISCLAIMER, analyse_stream  # noqa: E402
from ai_engine.prediction.risk_engine import assess, categorise  # noqa: E402

NOW = datetime(2026, 8, 7, 12, 0, 0, tzinfo=timezone.utc)


def run(rows):
    """analyse_stream against the fixture clock.

    A wrapper rather than a default argument: forgetting `now=NOW` silently
    empties every window, and every assertion then passes or fails for the
    wrong reason.
    """
    return analyse_stream(rows, now=NOW)


def stream(n=450, hr=72, spo2=98, temp=36.7, step=2, movement="RESTING", **kw):
    """A steady stream ending at NOW. Values may be callables of the index."""
    rows = []
    for i in range(n):
        t = NOW - timedelta(seconds=step * (n - 1 - i))
        rows.append(
            {
                "recorded_at": t.isoformat(),
                "heart_rate": hr(i) if callable(hr) else hr,
                "spo2": spo2(i) if callable(spo2) else spo2,
                "temperature": temp(i) if callable(temp) else temp,
                "movement_status": movement,
                **kw,
            }
        )
    return rows


# ------------------------------------------------------------- preprocessing
def test_implausible_values_are_dropped_not_clipped():
    # Clipping 4000 BPM to 250 turns a broken sensor into a tachycardic patient.
    rows = stream(n=10) + [
        {
            # A distinct timestamp: sharing one with the last stream row would
            # drop this as a duplicate before plausibility was ever checked.
            "recorded_at": (NOW + timedelta(seconds=1)).isoformat(),
            "heart_rate": 4000,
            "spo2": 98,
            "temperature": 36.7,
        }
    ]
    samples, report = clean(rows)

    assert report.dropped_implausible.get("heart_rate") == 1
    assert all(s.heart_rate is None or s.heart_rate <= 250 for s in samples)


def test_duplicates_are_removed():
    row = {"recorded_at": NOW.isoformat(), "heart_rate": 72, "spo2": 98, "temperature": 36.7}
    _, report = clean([row, dict(row), dict(row)])
    assert report.dropped_duplicate == 2


def test_gaps_are_not_filled():
    # Forward-fill would make a silent device look like a stable patient.
    rows = stream(n=20, spo2=None)
    samples, _ = clean(rows)
    assert all(s.spo2 is None for s in samples)


# ------------------------------------------------------------------ features
def test_coverage_distinguishes_quiet_from_stable():
    dense = extract(clean(stream(n=450))[0], NOW)
    sparse = extract(clean(stream(n=6))[0], NOW)

    assert dense.get("hr_median").coverage > 0.9
    assert sparse.get("hr_median").coverage < 0.1


def test_slope_needs_three_points():
    two = extract(clean(stream(n=2))[0], NOW)
    assert two.value("hr_slope") is None


def test_rising_heart_rate_produces_a_positive_slope():
    fs = extract(clean(stream(n=100, hr=lambda i: 70 + i * 0.5))[0], NOW)
    assert fs.value("hr_slope") > 0


def test_median_resists_a_single_artefact():
    # One bad reading must not move the baseline the whole engine reads from.
    clean_fs = extract(clean(stream(n=200, hr=72))[0], NOW)
    with_artefact = extract(
        clean(stream(n=200, hr=lambda i: 240 if i == 100 else 72))[0], NOW
    )
    assert abs(clean_fs.value("hr_median") - with_artefact.value("hr_median")) < 1.0


# ---------------------------------------------------------------- risk engine
def test_normal_data_scores_low():
    assessment = run(stream())
    assert assessment.risk.risk_level == "LOW"
    assert assessment.risk.risk_score < 0.25


def test_abnormal_data_scores_high():
    assessment = run(stream(hr=158, spo2=86, temp=39.7))
    assert assessment.risk.risk_level in ("HIGH", "CRITICAL")
    assert assessment.risk.risk_score >= 0.5


def test_contributions_sum_to_the_score():
    # The reason this is an additive model: the explanation IS the computation,
    # so attributions are exact rather than estimated.
    assessment = run(stream(hr=140, spo2=89, temp=38.6))
    total = sum(c.points for c in assessment.risk.contributions)
    assert math.isclose(min(1.0, total), assessment.risk.risk_score, rel_tol=1e-9)


def test_every_contribution_names_a_number():
    assessment = run(stream(hr=155, spo2=87, temp=39.6))
    assert assessment.risk.contributions

    for c in assessment.risk.contributions:
        assert c.detail
        assert any(ch.isdigit() for ch in c.detail), c.detail
        if c.feature != "fall":
            assert c.observed is not None


def test_no_output_states_a_diagnosis():
    assessment = run(stream(hr=158, spo2=85, temp=39.8))
    text = " ".join(
        assessment.risk.explanation
        + [i.message for i in assessment.insights]
        + [a.detail for a in assessment.anomalies]
    ).lower()

    for phrase in ("you have", "diagnos", "you should take", "prescrib"):
        assert phrase not in text, f"output contains '{phrase}'"


def test_exertion_discounts_a_high_heart_rate():
    # A monitor that alarms every time its wearer climbs stairs gets muted.
    resting = run(stream(hr=135, movement="RESTING"))
    active = run(stream(hr=135, movement="ACTIVE"))

    resting_hr = next(c for c in resting.risk.contributions if c.feature == "hr_level")
    active_hr = next(c for c in active.risk.contributions if c.feature == "hr_level")
    assert active_hr.points < resting_hr.points


def test_thin_data_scores_lower_than_dense_data():
    # Otherwise the quietest stream produces the loudest score.
    dense = run(stream(n=450, spo2=88))
    thin = run(stream(n=5, spo2=88))
    assert thin.risk.risk_score < dense.risk.risk_score


def test_confidence_is_not_claimed_as_accuracy():
    assessment = run(stream(n=6))
    assert 0.0 <= assessment.risk.confidence <= 1.0
    assert assessment.risk.confidence < 0.5


def test_categorise_covers_every_band():
    assert categorise(0.02) == "LOW"
    assert categorise(0.12) == "MODERATE"
    assert categorise(0.25) == "HIGH"
    assert categorise(0.55) == "CRITICAL"


def test_bands_mean_what_they_claim():
    """The calibration, asserted rather than left to a comment.

    A lone signal past its critical escalation threshold must reach HIGH, and a
    card reading "Warning" must never sit beside an overall risk of LOW.
    """
    # SpO2 90% is the escalation trigger — HIGH on its own.
    assert run(stream(spo2=90)).risk.risk_level == "HIGH"
    # SpO2 92% is a warning, so not LOW.
    assert run(stream(spo2=92)).risk.risk_level != "LOW"
    # Nothing abnormal is LOW.
    assert run(stream()).risk.risk_level == "LOW"


def test_empty_stream_does_not_crash():
    assessment = run([])
    assert assessment.risk.risk_level == "LOW"
    assert assessment.risk.confidence == 0.0


# ------------------------------------------------------------------ anomalies
def test_anomaly_needs_a_baseline_first():
    samples, _ = clean(stream(n=MIN_BASELINE_SAMPLES - 5))
    result = detect(samples, "heart_rate", NOW)
    assert result.status == "insufficient_baseline"


def test_value_far_from_personal_baseline_is_abnormal():
    rows = stream(n=400, hr=lambda i: 150 if i >= 399 else 72 + (i % 5))
    samples, _ = clean(rows)
    result = detect(samples, "heart_rate", NOW)

    assert result.status == "abnormal"
    assert result.robust_z > 3.5


def test_value_normal_for_this_patient_is_not_flagged():
    # 48 BPM is unusual for a population and ordinary for this person. Asking
    # "unusual for them" rather than "unusual for people" is the whole point.
    samples, _ = clean(stream(n=400, hr=lambda i: 48 + (i % 3)))
    assert detect(samples, "heart_rate", NOW).status == "normal"


def test_a_stuck_sensor_is_not_infinitely_anomalous():
    # Identical readings give MAD 0; dividing by it would flag the next
    # different value with an infinite z-score.
    samples, _ = clean(stream(n=400, hr=72))
    result = detect(samples, "heart_rate", NOW)
    assert result.status == "insufficient_baseline"


# --------------------------------------------------------------------- trends
def test_declining_spo2_produces_a_trend_insight():
    rows = stream(n=450, spo2=lambda i: 99 - (i / 450) * 8)
    assessment = run(rows)

    declines = [i for i in assessment.insights if i.insight_type == "TREND_DECLINE"]
    assert declines
    assert any("decreased" in i.message for i in declines)
    assert all(any(ch.isdigit() for ch in i.message) for i in declines)


def test_steady_values_produce_no_trend_insight():
    # A feed that always has something to say is a feed nobody reads.
    assessment = run(stream(n=450))
    assert not [i for i in assessment.insights if i.insight_type.startswith("TREND")]


def test_falling_oxygen_with_rising_heart_rate_is_correlated():
    rows = stream(
        n=450,
        spo2=lambda i: 99 - (i / 450) * 7,
        hr=lambda i: 70 + (i / 450) * 45,
    )
    assessment = run(rows)
    assert any(i.insight_type == "PATTERN_CORRELATION" for i in assessment.insights)


def test_thin_coverage_is_announced():
    assessment = run(stream(n=4))
    assert any(i.insight_type == "DATA_GAP" for i in assessment.insights)


# ----------------------------------------------------------------------- fall
def _fall_window(rng):
    from ai_engine.models.train_fall import _generate

    return _generate(rng, 1)


def _normal_window(rng):
    from ai_engine.models.train_fall import _generate

    return _generate(rng, 0)


def test_fall_model_detects_simulated_falls():
    rng = random.Random(7)
    hits = 0
    for _ in range(40):
        accel, gyro = _fall_window(rng)
        prediction = predict_fall(accel, gyro)
        assert prediction is not None
        hits += prediction.detected
    # Recall is weighted high on purpose: a missed fall costs more than a
    # dismissed alarm.
    assert hits >= 36, f"only {hits}/40 falls detected"


def test_fall_model_mostly_ignores_ordinary_activity():
    rng = random.Random(11)
    false_alarms = sum(
        1
        for _ in range(60)
        if (lambda p: p is not None and p.detected)(predict_fall(*_normal_window(rng)))
    )
    assert false_alarms <= 12, f"{false_alarms}/60 false alarms"


def test_short_imu_window_yields_no_prediction():
    # Better no verdict than one from three samples.
    assert extract_window([(0, 0, 1)] * 3, [(0, 0, 0)] * 3) is None
    assert predict_fall([(0, 0, 1)] * 3, [(0, 0, 0)] * 3) is None


def test_devices_without_an_imu_get_no_fall_verdict():
    # Most devices have no accelerometer, and inventing a verdict would be
    # worse than saying nothing.
    assert run(stream()).fall is None


# ------------------------------------------------------------------- envelope
def test_every_assessment_carries_a_disclaimer():
    for rows in ([], stream(), stream(hr=160, spo2=84)):
        assessment = run(rows)
        assert assessment.disclaimer == DISCLAIMER
        assert "does not diagnose" in assessment.to_dict()["disclaimer"]


def test_output_shape_is_serialisable():
    import json

    payload = run(stream(hr=140, spo2=89)).to_dict()
    json.dumps(payload)  # must not raise

    for key in ("risk_score", "risk_level", "confidence", "explanation", "contributions"):
        assert key in payload


@pytest.mark.parametrize("level", ["LOW", "MODERATE", "HIGH", "CRITICAL"])
def test_all_levels_are_reachable(level):
    cases = {
        "LOW": stream(),
        "MODERATE": stream(spo2=92),
        "HIGH": stream(hr=145, spo2=89),
        "CRITICAL": stream(hr=160, spo2=84, temp=39.9, movement="FALL_SUSPECTED"),
    }
    assert run(cases[level]).risk.risk_level == level

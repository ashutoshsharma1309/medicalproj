#!/usr/bin/env python3
"""Trains the fall detector and exports a portable artifact.

    ml/.venv/bin/python ai_engine/models/train_fall.py

── On the training data ─────────────────────────────────────────────────────

**It is synthetic, and the artifact says so on its face.** There is no public
MPU6050 fall corpus vendored here and none collected from real people, so every
window below is generated from a physical model of the event.

That is a real limitation and it is stated rather than implied away: a model
fitted to simulated motion has learned the simulator's idea of a fall. What
makes it worth shipping anyway is that the generator encodes *mechanics* rather
than an arbitrary distribution — free-fall then impact then reorientation then
stillness is what a fall is — and that the negatives include the activities
that genuinely confuse real detectors.

**The first version of this file scored 1.00 on everything**, which was a bug
in the benchmark rather than a good model: the positives were trivially
separable, so the forest learned a threshold on one feature and stopped. Adding
lie-down, flop-onto-sofa and dropped-device windows brought it to ~0.90
precision at ~0.99 recall, which is a believable shape for this problem. A
perfect score on synthetic data means the generator is too easy, never that the
model is good.

The recall/precision asymmetry is deliberate and set by class_weight: a missed
fall costs far more than a false alarm someone dismisses.

The honest statement of scope: this is a working detector for the simulator and
a correct pipeline for real data, not a validated clinical device. Replacing
`_generate` with recorded windows is the only change needed, and the artifact
records which corpus produced it.

A Random Forest, as the brief asks. Exported as plain JSON — thresholds and
leaf values — so the serving path needs no scikit-learn, matching the pattern
used by the document-ML phase.
"""

from __future__ import annotations

import json
import math
import pathlib
import random
import sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from ai_engine.models.fall_features import FEATURE_NAMES, extract_window  # noqa: E402

ARTIFACT = pathlib.Path(__file__).resolve().parents[1] / "artifacts" / "fall_detector.json"

RANDOM_STATE = 20260807
WINDOW = 24  # samples, ~1.2s at 20Hz


def _gravity(pitch_deg: float, roll_deg: float) -> tuple[float, float, float]:
    pitch, roll = math.radians(pitch_deg), math.radians(roll_deg)
    return (
        math.sin(pitch),
        -math.cos(pitch) * math.sin(roll),
        math.cos(pitch) * math.cos(roll),
    )


def _noisy(v: tuple[float, float, float], rng: random.Random, sigma: float):
    return tuple(c + rng.gauss(0, sigma) for c in v)  # type: ignore[return-value]


def _generate(rng: random.Random, label: int) -> tuple[list, list]:
    """One synthetic IMU window. label 1 = fall."""
    accel: list[tuple[float, float, float]] = []
    gyro: list[tuple[float, float, float]] = []

    if label == 1:
        # Upright → free-fall → impact → horizontal → still.
        upright = _gravity(rng.uniform(-12, 12), rng.uniform(-12, 12))
        settle_pitch = rng.choice([rng.uniform(65, 95), rng.uniform(-95, -65)])
        horizontal = _gravity(settle_pitch, rng.uniform(-25, 25))

        pre = rng.randint(3, 6)
        free_fall = rng.randint(3, 6)
        impact = rng.randint(1, 2)

        for _ in range(pre):
            accel.append(_noisy(upright, rng, 0.04))
            gyro.append(_noisy((0, 0, 0), rng, 6))

        for _ in range(free_fall):
            # Magnitude collapses toward 0g. Nothing in ordinary activity does
            # this for several consecutive samples.
            scale = rng.uniform(0.05, 0.35)
            accel.append(_noisy(tuple(c * scale for c in upright), rng, 0.05))  # type: ignore[arg-type]
            gyro.append(_noisy((rng.uniform(-90, 90), rng.uniform(-90, 90), 0), rng, 25))

        for _ in range(impact):
            spike = rng.uniform(2.6, 7.0)
            accel.append(_noisy(tuple(c * spike for c in horizontal), rng, 0.5))  # type: ignore[arg-type]
            gyro.append(_noisy((rng.uniform(-450, 450), rng.uniform(-450, 450), 0), rng, 70))

        while len(accel) < WINDOW:
            accel.append(_noisy(horizontal, rng, 0.03))
            gyro.append(_noisy((0, 0, 0), rng, 4))

        return accel[:WINDOW], gyro[:WINDOW]

    # ── negatives: the activities that look like falls but are not ──────────
    # The hard negatives matter more than the easy ones. A generator whose
    # positives are trivially separable produces a model that scores 1.00 and
    # has learned nothing — the first version of this file did exactly that.
    # These three share most of a fall's signature:
    #
    #   lie_down      orientation change + stillness, no free-fall, no impact
    #   flop_on_sofa  impact + orientation change + stillness, no free-fall
    #   device_drop   ALL FOUR phases — the device fell, the person did not
    #
    # device_drop is genuinely ambiguous from the IMU alone and is the reason
    # real systems ask for confirmation before escalating.
    kind = rng.choice(
        [
            "still", "walk", "run", "sit_heavy", "jump", "stumble",
            "lie_down", "flop_on_sofa", "device_drop",
        ]
    )
    base = _gravity(rng.uniform(-15, 15), rng.uniform(-15, 15))

    for i in range(WINDOW):
        if kind == "still":
            accel.append(_noisy(base, rng, 0.03))
            gyro.append(_noisy((0, 0, 0), rng, 3))
        elif kind in ("walk", "run"):
            amp = 0.25 if kind == "walk" else 0.75
            swing = math.sin(i * (0.7 if kind == "walk" else 1.3)) * amp
            accel.append(_noisy(tuple(c * (1 + swing) for c in base), rng, 0.09))  # type: ignore[arg-type]
            gyro.append(_noisy((swing * 90, swing * 55, 0), rng, 18))
        elif kind == "sit_heavy":
            # An impact and a partial orientation change, but no free-fall and
            # no post-impact stillness — the discrimination that matters.
            if i == WINDOW // 2:
                accel.append(_noisy(tuple(c * 2.4 for c in base), rng, 0.3))  # type: ignore[arg-type]
                gyro.append(_noisy((190, 130, 0), rng, 45))
            else:
                accel.append(_noisy(base, rng, 0.07))
                gyro.append(_noisy((0, 0, 0), rng, 9))
        elif kind == "jump":
            # Brief free-fall AND an impact, but the subject stays upright.
            if WINDOW // 3 <= i < WINDOW // 3 + 3:
                accel.append(_noisy(tuple(c * 0.25 for c in base), rng, 0.06))  # type: ignore[arg-type]
                gyro.append(_noisy((0, 0, 0), rng, 14))
            elif i == WINDOW // 3 + 3:
                accel.append(_noisy(tuple(c * 3.1 for c in base), rng, 0.35))  # type: ignore[arg-type]
                gyro.append(_noisy((150, 110, 0), rng, 40))
            else:
                accel.append(_noisy(base, rng, 0.09))
                gyro.append(_noisy((0, 0, 0), rng, 11))
        elif kind == "lie_down":
            # Deliberate: rotates to horizontal over ~1s and stays there.
            progress = min(1.0, i / (WINDOW * 0.6))
            tilt = _gravity(progress * 85, rng.uniform(-15, 15))
            accel.append(_noisy(tilt, rng, 0.05))
            gyro.append(_noisy((110 * (1 - progress), 40 * (1 - progress), 0), rng, 12))
        elif kind == "flop_on_sofa":
            # Impact, orientation change and stillness — everything a fall has
            # except the free-fall phase.
            if i == WINDOW // 3:
                accel.append(_noisy(tuple(c * 3.4 for c in base), rng, 0.4))  # type: ignore[arg-type]
                gyro.append(_noisy((330, 240, 0), rng, 60))
            elif i > WINDOW // 3:
                reclined = _gravity(58, rng.uniform(-20, 20))
                accel.append(_noisy(reclined, rng, 0.04))
                gyro.append(_noisy((0, 0, 0), rng, 5))
            else:
                accel.append(_noisy(base, rng, 0.08))
                gyro.append(_noisy((0, 0, 0), rng, 10))
        elif kind == "device_drop":
            # Free-fall, impact, reorientation, stillness — the full sequence,
            # from a device falling off a table. Ambiguous by construction.
            if WINDOW // 4 <= i < WINDOW // 4 + 4:
                accel.append(_noisy((0.0, 0.0, 0.0), rng, 0.12))
                gyro.append(_noisy((rng.uniform(-160, 160),) * 3, rng, 40))  # type: ignore[arg-type]
            elif i == WINDOW // 4 + 4:
                accel.append(_noisy(tuple(c * rng.uniform(3.5, 8.0) for c in base), rng, 0.7))  # type: ignore[arg-type]
                gyro.append(_noisy((rng.uniform(-600, 600),) * 3, rng, 90))  # type: ignore[arg-type]
            elif i > WINDOW // 4 + 4:
                landed = _gravity(rng.uniform(-100, 100), rng.uniform(-100, 100))
                accel.append(_noisy(landed, rng, 0.03))
                gyro.append(_noisy((0, 0, 0), rng, 3))
            else:
                accel.append(_noisy(base, rng, 0.05))
                gyro.append(_noisy((0, 0, 0), rng, 6))
        else:  # stumble and recover
            if WINDOW // 2 <= i < WINDOW // 2 + 3:
                accel.append(_noisy(tuple(c * rng.uniform(0.4, 2.2) for c in base), rng, 0.25))  # type: ignore[arg-type]
                gyro.append(_noisy((rng.uniform(-260, 260), rng.uniform(-200, 200), 0), rng, 55))
            else:
                accel.append(_noisy(base, rng, 0.1))
                gyro.append(_noisy((0, 0, 0), rng, 14))

    return accel, gyro


def build_dataset(n: int, rng: random.Random):
    X, y = [], []
    for _ in range(n):
        # Falls are rare in life; 30% here so the model sees enough of them.
        # The evaluation reports precision and recall rather than accuracy,
        # because accuracy on an imbalanced problem is close to meaningless.
        label = 1 if rng.random() < 0.22 else 0
        accel, gyro = _generate(rng, label)
        features = extract_window(accel, gyro)
        if features is None:
            continue
        X.append(features)
        y.append(label)
    return X, y


def export_forest(model, feature_names: list[str]) -> list[dict]:
    """Serialises a scikit-learn forest to plain nested dicts."""

    def walk(tree, node: int) -> dict:
        if tree.children_left[node] == -1:
            counts = tree.value[node][0]
            total = counts.sum()
            return {"leaf": float(counts[1] / total) if total else 0.0}
        return {
            "f": int(tree.feature[node]),
            "t": float(tree.threshold[node]),
            "l": walk(tree, int(tree.children_left[node])),
            "r": walk(tree, int(tree.children_right[node])),
        }

    return [walk(estimator.tree_, 0) for estimator in model.estimators_]


def main() -> int:
    try:
        from sklearn.ensemble import RandomForestClassifier
        from sklearn.metrics import (
            classification_report,
            precision_recall_fscore_support,
            roc_auc_score,
        )
        from sklearn.model_selection import train_test_split
    except ImportError:
        print("scikit-learn is required. Run with ml/.venv/bin/python.", file=sys.stderr)
        return 1

    rng = random.Random(RANDOM_STATE)
    X, y = build_dataset(6000, rng)
    print(f"generated {len(X)} windows, {sum(y)} falls")

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.25, random_state=RANDOM_STATE, stratify=y
    )

    model = RandomForestClassifier(
        n_estimators=60,
        max_depth=8,
        min_samples_leaf=6,
        # A missed fall costs far more than a false alarm someone dismisses, so
        # the classes are weighted rather than left to the 70/30 split.
        class_weight={0: 1.0, 1: 3.0},
        random_state=RANDOM_STATE,
        n_jobs=-1,
    )
    model.fit(X_train, y_train)

    probabilities = model.predict_proba(X_test)[:, 1]
    predictions = (probabilities >= 0.5).astype(int)

    precision, recall, f1, _ = precision_recall_fscore_support(
        y_test, predictions, average="binary", zero_division=0
    )
    auc = roc_auc_score(y_test, probabilities)

    print(classification_report(y_test, predictions, target_names=["not fall", "fall"]))

    importances = sorted(
        zip(FEATURE_NAMES, model.feature_importances_), key=lambda kv: -kv[1]
    )
    print("feature importance:")
    for name, importance in importances:
        print(f"  {name:<22} {importance:.3f}")

    artifact = {
        "model": "fall_detector",
        "version": "v1",
        "algorithm": "random_forest",
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "window_samples": WINDOW,
        "features": FEATURE_NAMES,
        "dataset": {
            "name": "Synthetic MPU6050 fall windows",
            "source": "ai_engine/models/train_fall.py — physically parameterised generator",
            "rows": len(X),
            "positive_rate": round(sum(y) / len(y), 3),
            "caveat": (
                "SYNTHETIC. No real fall recordings were used. The generator encodes the "
                "mechanics of a fall (free-fall, impact, reorientation, stillness) and the "
                "activities that resemble one (sitting heavily, jumping, stumbling), but a "
                "model fitted to it has learned simulated motion. Treat as a working "
                "detector for the simulator and a correct pipeline for real data — not as a "
                "validated clinical device."
            ),
        },
        "metrics": {
            "precision": round(float(precision), 4),
            "recall": round(float(recall), 4),
            "f1": round(float(f1), 4),
            "roc_auc": round(float(auc), 4),
            "note": "Measured on held-out SYNTHETIC data. Not evidence of real-world accuracy.",
        },
        "feature_importance": {name: round(float(v), 4) for name, v in importances},
        "threshold": 0.5,
        "trees": export_forest(model, FEATURE_NAMES),
    }

    ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
    ARTIFACT.write_text(json.dumps(artifact, indent=2))
    size_kb = ARTIFACT.stat().st_size / 1024
    print(f"\n→ {ARTIFACT.relative_to(pathlib.Path.cwd())} ({size_kb:.0f} KB)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

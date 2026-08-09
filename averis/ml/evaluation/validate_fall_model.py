#!/usr/bin/env python3
"""Validation of the fall detector — the parts that decide whether it gets muted.

    python3 ml/evaluation/validate_fall_model.py
    python3 ml/evaluation/validate_fall_model.py --json

── Why this exists when the model card already has metrics ──────────────────

`ai_engine/artifacts/fall_detector.json` reports precision 0.90, recall 0.99,
F1 0.94, ROC-AUC 0.998 on a held-out synthetic split. Those numbers are real
and they are also close to useless on their own, for three reasons this tool
addresses:

  1. **They come from one split with one seed.** A single train/test partition
     can be lucky. Repeated stratified cross-validation reports the spread, and
     the spread is what tells you whether 0.90 is the model's precision or that
     split's precision.

  2. **They describe one operating point.** A fall detector's threshold is a
     clinical trade-off, not a hyperparameter: moving it trades missed falls
     against false alarms. Reporting a single F1 hides the choice, and the
     choice is the whole design decision.

  3. **They are not in units anyone can act on.** "Precision 0.90" does not tell
     a clinician anything. **"One false alarm every N days per patient"** does,
     because that is the number that decides whether the alerts get muted — and
     a muted detector misses the real fall, which is the failure that matters.

── The claim this tool does NOT make ────────────────────────────────────────

Every number below is measured on **synthetic** data from
`ai_engine/models/train_fall.py`. That generator encodes the mechanics of a
fall and of the activities that resemble one, and a model fitted to it has
learned simulated motion.

So these metrics answer: *did the model learn the generator, and at which
operating point should it run if the generator resembles reality?* They do not
answer whether it detects a real fall from a real wrist. A high score here means
the generator is learnable, never that the device works. `docs/hardware_validation.md`
§3.2 is the protocol that would answer the real question, and it has not been run.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import random
import statistics
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ai_engine.models.train_fall import RANDOM_STATE, build_dataset  # noqa: E402

# How many IMU windows reach the classifier per patient per day.
#
# Two regimes, because AVERIS has two layers and conflating them produces a
# projection that is wrong by orders of magnitude in one direction or the other.
#
#   UNGATED  — every window during movement is scored. ~1,200/day is a
#              conservative figure for periods of real motion across sixteen
#              waking hours.
#
#   GATED    — only windows the device's own state machine has already flagged
#              (free-fall → impact → stillness) are sent for scoring. That
#              sequence is rare; a handful of candidates a day is realistic, and
#              the classifier's job is then to reject the stumbles and heavy
#              sit-downs that reached it.
#
# The gated regime is how the system is designed to run: `signal_core.h` holds
# the state machine, and the classifier is the second opinion rather than the
# first. Both are reported because the ungated figure is what the model would do
# if that gate were ever removed or bypassed — which is a change somebody could
# make without realising what it costs.
WINDOWS_UNGATED_PER_DAY = 1200
WINDOWS_GATED_PER_DAY = 8

# Realistic prevalence, for converting a confusion matrix into a rate.
#
# A community-dwelling older adult falls perhaps a few times a year. Against
# ~1200 scored windows a day that is a base rate around 1e-5 — five orders of
# magnitude below the 22% in the training set, and the reason precision on a
# balanced test set tells you almost nothing about precision in the field.
FALLS_PER_PERSON_PER_YEAR = 2.0


def confusion(y_true, y_score, threshold):
    tp = fp = tn = fn = 0
    for actual, score in zip(y_true, y_score):
        predicted = 1 if score >= threshold else 0
        if actual == 1 and predicted == 1:
            tp += 1
        elif actual == 0 and predicted == 1:
            fp += 1
        elif actual == 0 and predicted == 0:
            tn += 1
        else:
            fn += 1
    return tp, fp, tn, fn


def metrics_at(y_true, y_score, threshold):
    tp, fp, tn, fn = confusion(y_true, y_score, threshold)

    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    # False positive rate is the one that converts into a real-world alarm rate.
    fpr = fp / (fp + tn) if (fp + tn) else 0.0

    return {
        "threshold": round(threshold, 2),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "false_positive_rate": round(fpr, 5),
        "tp": tp, "fp": fp, "tn": tn, "fn": fn,
    }


def field_projection(fpr: float, recall: float) -> dict:
    """Translates a confusion matrix into units somebody can act on.

    The most useful output of this tool, and the one most easily misread — so
    the assumptions travel inside the returned object rather than living only in
    this docstring.

    **The direction of the error is stated because it is not symmetric.** The
    false-positive rate here is measured against synthetic negatives that were
    *deliberately generated to resemble falls* — heavy sit-downs, jumps,
    stumbles. Ordinary motion is far easier to reject. So this FPR is an upper
    bound on the classifier's behaviour, and the projection is pessimistic by an
    unknown factor. It is reported anyway, because a pessimistic bound somebody
    can act on beats an optimistic figure nobody can check.
    """
    ungated = fpr * WINDOWS_UNGATED_PER_DAY
    gated = fpr * WINDOWS_GATED_PER_DAY

    caught_per_year = recall * FALLS_PER_PERSON_PER_YEAR

    return {
        "false_alarms_per_day_gated": round(gated, 3),
        "false_alarms_per_day_ungated": round(ungated, 2),
        "days_between_false_alarms_gated": round(1 / gated, 1) if gated > 0 else None,
        "falls_caught_per_year_of": {
            "assumed_falls_per_year": FALLS_PER_PERSON_PER_YEAR,
            "caught": round(caught_per_year, 2),
            "missed": round(FALLS_PER_PERSON_PER_YEAR - caught_per_year, 2),
        },
        "assumptions": (
            f"GATED: {WINDOWS_GATED_PER_DAY} windows/day reach the classifier because the "
            f"device state machine flagged them first — this is how the system is designed to "
            f"run. UNGATED: {WINDOWS_UNGATED_PER_DAY} windows/day, which is what it would do "
            f"if that gate were removed. Assumed {FALLS_PER_PERSON_PER_YEAR} real falls per "
            f"person per year. All three are estimates, not measurements.\n"
            f"The false-positive rate is measured against synthetic negatives generated to "
            f"RESEMBLE falls (heavy sit-downs, jumps, stumbles), so it is an upper bound and "
            f"these projections are pessimistic by an unknown factor."
        ),
    }


def run(folds: int, dataset_size: int, seeds: list[int]) -> dict:
    try:
        from sklearn.ensemble import RandomForestClassifier
        from sklearn.model_selection import StratifiedKFold
        from sklearn.metrics import roc_auc_score
    except ImportError:
        print("scikit-learn is required.", file=sys.stderr)
        raise SystemExit(1)

    per_seed = []
    pooled_true: list[int] = []
    pooled_score: list[float] = []

    for seed in seeds:
        rng = random.Random(seed)
        X, y = build_dataset(dataset_size, rng)

        splitter = StratifiedKFold(n_splits=folds, shuffle=True, random_state=seed)
        fold_scores = []

        for train_idx, test_idx in splitter.split(X, y):
            X_train = [X[i] for i in train_idx]
            y_train = [y[i] for i in train_idx]
            X_test = [X[i] for i in test_idx]
            y_test = [y[i] for i in test_idx]

            model = RandomForestClassifier(
                n_estimators=60,
                max_depth=8,
                min_samples_leaf=6,
                class_weight={0: 1.0, 1: 3.0},
                random_state=RANDOM_STATE,
                n_jobs=-1,
            )
            model.fit(X_train, y_train)

            proba = [p[1] for p in model.predict_proba(X_test)]

            # Pooled across every fold and seed, so the threshold sweep below is
            # computed on all held-out predictions rather than on one fold that
            # happened to look good.
            pooled_true.extend(y_test)
            pooled_score.extend(proba)

            at_default = metrics_at(y_test, proba, 0.5)
            at_default["roc_auc"] = round(roc_auc_score(y_test, proba), 4)
            fold_scores.append(at_default)

        per_seed.append({
            "seed": seed,
            "folds": fold_scores,
            "mean_f1": round(statistics.fmean(f["f1"] for f in fold_scores), 4),
        })

    # The spread across every fold of every seed. This is the number the model
    # card should carry rather than a single split's score.
    all_folds = [f for s in per_seed for f in s["folds"]]

    def spread(key: str) -> dict:
        values = [f[key] for f in all_folds]
        return {
            "mean": round(statistics.fmean(values), 4),
            "min": round(min(values), 4),
            "max": round(max(values), 4),
            "stdev": round(statistics.stdev(values), 4) if len(values) > 1 else 0.0,
        }

    sweep = [
        metrics_at(pooled_true, pooled_score, t)
        for t in [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
    ]

    for point in sweep:
        point["field"] = field_projection(point["false_positive_rate"], point["recall"])

    return {
        "dataset": {
            "source": "ai_engine/models/train_fall.py — synthetic generator",
            "windows_per_seed": dataset_size,
            "seeds": seeds,
            "folds": folds,
            "total_held_out_predictions": len(pooled_true),
            "positive_rate": round(sum(pooled_true) / len(pooled_true), 4),
        },
        "cross_validated": {
            "precision": spread("precision"),
            "recall": spread("recall"),
            "f1": spread("f1"),
            "roc_auc": spread("roc_auc"),
        },
        "threshold_sweep": sweep,
        "scope": (
            "Measured on SYNTHETIC data. These answer whether the model learned the "
            "generator and at which operating point it should run if the generator "
            "resembles reality. They do not answer whether it detects a real fall from a "
            "real wrist. See docs/hardware_validation.md §3.2."
        ),
    }


def render(report: dict) -> None:
    cv = report["cross_validated"]
    ds = report["dataset"]

    print("\nAVERIS — fall detector validation")
    print("=" * 70)
    print(f"\n{ds['total_held_out_predictions']} held-out predictions "
          f"({ds['folds']}-fold × {len(ds['seeds'])} seeds), "
          f"{ds['positive_rate']:.1%} positive\n")

    print("Cross-validated at the default 0.5 threshold")
    print("-" * 70)
    for name in ("precision", "recall", "f1", "roc_auc"):
        s = cv[name]
        print(f"  {name:<12} {s['mean']:.4f}   "
              f"(min {s['min']:.4f}, max {s['max']:.4f}, sd {s['stdev']:.4f})")

    print("\nThreshold sweep — the clinical trade-off")
    print("-" * 70)
    print(f"  {'thr':>4}  {'prec':>6}  {'recall':>6}  {'F1':>6}  {'FPR':>8}   "
          f"{'FA/day gated':>13}  {'FA/day ungated':>15}  {'missed/yr':>10}")
    for point in report["threshold_sweep"]:
        field = point["field"]
        print(f"  {point['threshold']:>4}  {point['precision']:>6.3f}  "
              f"{point['recall']:>6.3f}  {point['f1']:>6.3f}  "
              f"{point['false_positive_rate']:>8.5f}   "
              f"{field['false_alarms_per_day_gated']:>13.3f}  "
              f"{field['false_alarms_per_day_ungated']:>15.2f}  "
              f"{field['falls_caught_per_year_of']['missed']:>10.2f}")

    print("\n" + report["threshold_sweep"][0]["field"]["assumptions"])
    print("\nSCOPE")
    print("-" * 70)
    print(report["scope"])
    print()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--size", type=int, default=4000, help="windows per seed")
    parser.add_argument("--seeds", type=int, nargs="+", default=[11, 23, 37])
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    report = run(args.folds, args.size, args.seeds)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        render(report)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

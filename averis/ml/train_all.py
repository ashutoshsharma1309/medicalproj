"""Train both AVERIS risk models and export their artifacts.

    .venv/bin/python train_all.py

Prints the family comparison so the trade-off behind the serving choice is
visible at the point it is made, rather than only in the committed metrics.
"""

from __future__ import annotations

import sys

from datasets.loader import load_cleveland, load_pima
from preprocessing.clean import clean_cleveland, clean_pima
from models.train import train
from prediction.export import build_artifact, write_artifact

DATASETS = {
    "diabetes": {
        "name": "Pima Indians Diabetes",
        "source": "UCI Machine Learning Repository / NIDDK",
        "rows": 768,
        "cohort": "Women of Pima heritage, aged 21 and over",
        "caveat": (
            "Fitted on a single population. Does not transfer cleanly to men, "
            "to other ancestries, or to patients under 21."
        ),
    },
    "cardiovascular": {
        "name": "Cleveland Heart Disease",
        "source": "UCI Machine Learning Repository",
        "rows": 303,
        "cohort": "Cleveland Clinic Foundation cardiac referrals, predominantly male",
        "caveat": (
            "A small referral cohort, so the base rate of disease is far higher "
            "than in the general population. Records neither BMI nor smoking."
        ),
    },
}


def run_one(model: str, loader, cleaner) -> dict:
    print(f"\n{'=' * 68}\n{model.upper()}\n{'=' * 68}")

    frame = loader()
    x, y, cleaning = cleaner(frame)
    print(f"  rows={len(x)}  features={len(x.columns)}  positive_rate={y.mean():.3f}")
    if cleaning:
        print(f"  cleaning: {cleaning}")

    run = train(model, x, y)

    print(f"\n  {'family':<28} {'ROC-AUC':>8} {'recall':>8} {'prec':>8} {'F1':>8} {'acc':>8}")
    print(f"  {'-' * 28} {'-' * 8} {'-' * 8} {'-' * 8} {'-' * 8} {'-' * 8}")
    for family in run.families:
        m = family.metrics
        served = "  ← serves" if family is run.served else ""
        print(
            f"  {family.name:<28} {m.roc_auc:>8.3f} {m.recall:>8.3f} "
            f"{m.precision:>8.3f} {m.f1_score:>8.3f} {m.accuracy:>8.3f}{served}"
        )

    artifact = build_artifact(run, DATASETS[model], cleaning)
    path = write_artifact(artifact)

    best = max(run.families, key=lambda f: f.metrics.roc_auc)
    if best is not run.served:
        gap = best.metrics.roc_auc - run.served.metrics.roc_auc
        print(
            f"\n  note: {best.name} leads on ROC-AUC by {gap:.3f}. "
            f"Logistic regression still serves — see ml/README.md."
        )

    if artifact["direction_disagreements"]:
        print(
            "  note: fitted sign contradicts clinical expectation for "
            f"{', '.join(artifact['direction_disagreements'])}"
        )

    print(f"\n  → {path.relative_to(path.parents[3])}")
    return artifact


def main() -> int:
    run_one("diabetes", load_pima, clean_pima)
    run_one("cardiovascular", load_cleveland, clean_cleveland)
    print("\nDone. Artifacts written to lib/ml/artifacts/.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

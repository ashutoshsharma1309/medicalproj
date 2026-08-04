"""Export a trained model to a portable JSON artifact.

This file is the contract between the two runtimes. Everything the TypeScript
scorer needs is written here; nothing is inferred on the other side.

A logistic regression inside a StandardScaler pipeline reduces to arithmetic:

    z_i    = (x_i - scaler_mean_i) / scaler_scale_i
    logit  = intercept + Σ coef_i · z_i
    risk   = 1 / (1 + e^-logit)

and the Shapley value of each feature has a closed form in log-odds space:

    φ_i    = coef_i · (z_i - z̄_i)
    base   = intercept + Σ coef_i · z̄_i

where z̄ is the mean of the scaled training data. The two satisfy
`logit = base + Σ φ_i` exactly, which the TypeScript tests assert on every
fixture. That identity is what makes the explanation trustworthy: the
contributions shown to a patient necessarily sum to the score they were shown.

Reference SHAP values are computed here with the real `shap` library and
exported as fixtures, so the TypeScript implementation is verified against
the reference rather than against itself.
"""

from __future__ import annotations

import datetime as dt
import json
import pathlib

import numpy as np
import shap

from models.train import TrainingRun
from preprocessing.schema import SCHEMAS

#: Bumped by hand when the feature set or training procedure changes, so a
#: stored prediction can always be traced to the model that produced it.
MODEL_VERSION = "v1"

ARTIFACT_DIR = pathlib.Path(__file__).parents[2] / "lib" / "ml" / "artifacts"

#: How many held-out rows to export as parity fixtures.
FIXTURE_ROWS = 12


def _direction_disagreements(feature_names, coefficients, model: str) -> list[str]:
    """Features whose fitted sign contradicts clinical expectation.

    Not an error. On a 303-row cohort a weak feature can easily fit backwards,
    and knowing which ones did is more useful than pretending the model is
    physiologically coherent everywhere.
    """
    disagreements = []
    for feature, coefficient in zip(SCHEMAS[model], coefficients):
        if feature.higher_is_riskier is None:
            continue
        fitted_higher_is_riskier = coefficient > 0
        if fitted_higher_is_riskier != feature.higher_is_riskier:
            disagreements.append(feature.name)
    return disagreements


def build_artifact(run: TrainingRun, dataset: dict, cleaning: dict) -> dict:
    features = SCHEMAS[run.model]
    names = [f.name for f in features]

    pipeline = run.served.estimator
    scaler = pipeline.named_steps["scaler"]
    classifier = pipeline.named_steps["classifier"]

    coefficients = classifier.coef_[0].astype(float)
    intercept = float(classifier.intercept_[0])

    scaled_train = scaler.transform(run.x_train)
    scaled_means = scaled_train.mean(axis=0).astype(float)
    base_value = float(intercept + float(np.dot(coefficients, scaled_means)))

    explainer = shap.LinearExplainer(classifier, scaled_train)
    fixture_rows = run.x_test.iloc[:FIXTURE_ROWS]
    fixture_shap = explainer.shap_values(scaler.transform(fixture_rows))
    fixture_logits = pipeline.decision_function(fixture_rows)
    fixture_proba = pipeline.predict_proba(fixture_rows)[:, 1]

    return {
        "model": run.model,
        "version": MODEL_VERSION,
        "trained_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "algorithm": "logistic_regression",
        "dataset": dataset,
        "cleaning": cleaning,
        "positive_rate": round(run.positive_rate, 4),
        "features": [f.to_dict() for f in features],
        "scaler": {
            "mean": [round(float(v), 8) for v in scaler.mean_],
            "scale": [round(float(v), 8) for v in scaler.scale_],
        },
        "coefficients": [round(float(v), 8) for v in coefficients],
        "intercept": round(intercept, 8),
        # Mean of the *scaled* training data — the SHAP baseline. Near zero by
        # construction, but exported rather than assumed so the identity holds
        # exactly rather than approximately.
        "scaled_means": [round(float(v), 8) for v in scaled_means],
        "base_value": round(base_value, 8),
        # Raw training means, used to substitute for a feature AVERIS cannot
        # derive from the patient's own records.
        "training_means": [round(float(v), 6) for v in run.x_train.mean().values],
        "direction_disagreements": _direction_disagreements(names, coefficients, run.model),
        "metrics": {
            family.name: {
                **family.metrics.to_dict(),
                "cv_roc_auc_mean": round(family.cv_roc_auc_mean, 4),
                "cv_roc_auc_std": round(family.cv_roc_auc_std, 4),
            }
            for family in run.families
        },
        "served_algorithm": run.served.name,
        "fixtures": [
            {
                "input": {name: float(value) for name, value in zip(names, row)},
                "shap": [round(float(v), 8) for v in shap_row],
                "logit": round(float(logit), 8),
                "probability": round(float(proba), 8),
            }
            for row, shap_row, logit, proba in zip(
                fixture_rows.values, fixture_shap, fixture_logits, fixture_proba
            )
        ],
    }


def write_artifact(artifact: dict) -> pathlib.Path:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    path = ARTIFACT_DIR / f"{artifact['model']}.json"
    path.write_text(json.dumps(artifact, indent=2) + "\n")
    return path

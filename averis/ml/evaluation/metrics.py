"""Model evaluation.

Accuracy is reported because the brief asks for it, but it is close to
useless on both of these datasets: Pima is roughly 65% negative, so a model
that predicts "no diabetes" for everyone scores 65% and detects nothing.

ROC-AUC and recall are what matter for a screening tool. A missed high-risk
patient costs more than a false alarm that resolves into "discuss this with
your doctor", so recall is the metric to watch when comparing families.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np
from sklearn.metrics import (
    accuracy_score,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)


@dataclass(frozen=True)
class Metrics:
    accuracy: float
    precision: float
    recall: float
    f1_score: float
    roc_auc: float

    def to_dict(self) -> dict:
        return {k: round(float(v), 4) for k, v in asdict(self).items()}


def evaluate(y_true: np.ndarray, y_proba: np.ndarray, threshold: float = 0.5) -> Metrics:
    y_pred = (y_proba >= threshold).astype(int)
    return Metrics(
        accuracy=accuracy_score(y_true, y_pred),
        # zero_division=0: a model that predicts no positives at all has
        # undefined precision, and crashing the training run over it is worse
        # than recording a zero and letting the comparison table show it.
        precision=precision_score(y_true, y_pred, zero_division=0),
        recall=recall_score(y_true, y_pred, zero_division=0),
        f1_score=f1_score(y_true, y_pred, zero_division=0),
        roc_auc=roc_auc_score(y_true, y_proba),
    )

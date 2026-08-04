"""Model training and family comparison.

Three families per dataset: logistic regression (baseline), random forest, and
gradient boosting (XGBoost where the platform provides OpenMP, scikit-learn's
implementation otherwise). Every family is scored on the same held-out split,
and every score is exported — the comparison is visible in the product, not
buried in a notebook.

Logistic regression is what ships. See ../README.md for why.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_score, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from evaluation.metrics import Metrics, evaluate

#: Fixed so a retrain reproduces the committed artifact byte for byte.
RANDOM_STATE = 20260804


@dataclass
class TrainedFamily:
    name: str
    estimator: object
    metrics: Metrics
    cv_roc_auc_mean: float
    cv_roc_auc_std: float


@dataclass
class TrainingRun:
    model: str
    families: list[TrainedFamily]
    served: TrainedFamily
    x_train: pd.DataFrame
    x_test: pd.DataFrame
    y_test: np.ndarray
    positive_rate: float


def _gradient_boosting():
    """XGBoost when it loads, scikit-learn's implementation when it does not.

    XGBoost needs OpenMP at runtime, which is not present on every machine.
    Failing the whole training run over an optional comparison model would be
    the wrong trade, so we substitute and record which one actually ran.
    """
    try:
        from xgboost import XGBClassifier

        return "xgboost", XGBClassifier(
            n_estimators=200,
            max_depth=3,
            learning_rate=0.1,
            subsample=0.9,
            eval_metric="logloss",
            random_state=RANDOM_STATE,
        )
    except Exception:
        return "gradient_boosting_sklearn", GradientBoostingClassifier(
            n_estimators=200,
            max_depth=3,
            learning_rate=0.1,
            random_state=RANDOM_STATE,
        )


def train(model: str, x: pd.DataFrame, y: pd.Series) -> TrainingRun:
    y = np.asarray(y)

    # Stratified so the small Cleveland test split cannot end up with a
    # wildly different positive rate than the training data.
    x_train, x_test, y_train, y_test = train_test_split(
        x, y, test_size=0.2, random_state=RANDOM_STATE, stratify=y
    )

    logistic = Pipeline(
        [
            ("scaler", StandardScaler()),
            (
                "classifier",
                LogisticRegression(
                    max_iter=2000,
                    # Balanced because both datasets are skewed negative and an
                    # unbalanced fit quietly optimises for saying "low risk".
                    class_weight="balanced",
                    random_state=RANDOM_STATE,
                ),
            ),
        ]
    )

    forest = RandomForestClassifier(
        n_estimators=300,
        max_depth=6,
        min_samples_leaf=3,
        class_weight="balanced",
        random_state=RANDOM_STATE,
    )

    boosting_name, boosting = _gradient_boosting()

    candidates = [
        ("logistic_regression", logistic),
        ("random_forest", forest),
        (boosting_name, boosting),
    ]

    folds = StratifiedKFold(n_splits=5, shuffle=True, random_state=RANDOM_STATE)
    families: list[TrainedFamily] = []

    for name, estimator in candidates:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            cv = cross_val_score(estimator, x_train, y_train, cv=folds, scoring="roc_auc")
            estimator.fit(x_train, y_train)

        proba = estimator.predict_proba(x_test)[:, 1]
        families.append(
            TrainedFamily(
                name=name,
                estimator=estimator,
                metrics=evaluate(y_test, proba),
                cv_roc_auc_mean=float(cv.mean()),
                cv_roc_auc_std=float(cv.std()),
            )
        )

    served = next(f for f in families if f.name == "logistic_regression")

    return TrainingRun(
        model=model,
        families=families,
        served=served,
        x_train=x_train,
        x_test=x_test,
        y_test=y_test,
        positive_rate=float(y.mean()),
    )

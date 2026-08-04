"""Dataset cleaning.

The single most consequential step in this pipeline. Both datasets encode
missing values in ways that look like data:

  * Pima writes a literal 0 for glucose, blood pressure, skinfold thickness,
    insulin and BMI when the measurement is absent. A BMI of zero is not a
    thin patient. Left alone, the model learns that "BMI near zero" is a
    strong signal — an artefact of the encoding, not of physiology.

  * Cleveland marks missing with '?' (already converted to NaN by the loader)
    and encodes its target as 0–4 severity, where anything above 0 means
    disease is present.

We impute with the *median of the observed values*, not the mean, because
these columns are skewed and a handful of extreme insulin readings would drag
a mean somewhere no patient sits.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from preprocessing.schema import CARDIO_FEATURES, DIABETES_FEATURES

#: Columns where Pima uses 0 to mean "not measured".
PIMA_ZERO_IS_MISSING = [
    "glucose",
    "blood_pressure",
    "skin_thickness",
    "insulin",
    "bmi",
]


def clean_pima(frame: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, dict]:
    """Returns (features, target, cleaning report)."""
    frame = frame.copy()

    report: dict[str, int] = {}
    for column in PIMA_ZERO_IS_MISSING:
        missing = int((frame[column] == 0).sum())
        if missing:
            report[column] = missing
        frame[column] = frame[column].replace(0, np.nan)

    frame = _impute_median(frame)

    names = [f.name for f in DIABETES_FEATURES]
    return frame[names], frame["outcome"].astype(int), {"zeros_treated_as_missing": report}


def clean_cleveland(frame: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, dict]:
    """Returns (features, target, cleaning report)."""
    frame = frame.copy()

    report = {
        "rows_with_missing": int(frame.isna().any(axis=1).sum()),
        "null_counts": {k: int(v) for k, v in frame.isna().sum().items() if v},
    }

    frame = _impute_median(frame)

    # Severity 1–4 all mean "disease present". The task is presence, not grade:
    # 303 rows cannot support a five-class model, and the product only ever
    # asks "is there elevated risk", never "how advanced is it".
    target = (frame["diagnosis"] > 0).astype(int)

    names = [f.name for f in CARDIO_FEATURES]
    return frame[names], target, report


def _impute_median(frame: pd.DataFrame) -> pd.DataFrame:
    numeric = frame.select_dtypes(include=[np.number]).columns
    for column in numeric:
        if frame[column].isna().any():
            frame[column] = frame[column].fillna(frame[column].median())
    return frame

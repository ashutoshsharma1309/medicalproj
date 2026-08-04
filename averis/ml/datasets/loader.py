"""Dataset download and caching.

Both datasets are small, public and stable. They are fetched once and cached
under `datasets/raw/`, which is gitignored — vendoring a copy into the repo
would mean the committed data could silently drift from the cited source.

Column names are normalised here and nowhere else, so the rest of the pipeline
never has to know that the Cleveland file ships without a header row.
"""

from __future__ import annotations

import io
import pathlib
import urllib.request

import pandas as pd

RAW = pathlib.Path(__file__).parent / "raw"

PIMA_URL = (
    "https://raw.githubusercontent.com/jbrownlee/Datasets/master/"
    "pima-indians-diabetes.data.csv"
)
PIMA_COLUMNS = [
    "pregnancies",
    "glucose",
    "blood_pressure",
    "skin_thickness",
    "insulin",
    "bmi",
    "diabetes_pedigree",
    "age",
    "outcome",
]

CLEVELAND_URL = (
    "https://archive.ics.uci.edu/ml/machine-learning-databases/"
    "heart-disease/processed.cleveland.data"
)
CLEVELAND_COLUMNS = [
    "age",
    "sex",
    "chest_pain_type",
    "resting_bp",
    "cholesterol",
    "fasting_blood_sugar",
    "resting_ecg",
    "max_heart_rate",
    "exercise_angina",
    "st_depression",
    "slope",
    "major_vessels",
    "thalassemia",
    "diagnosis",
]


def _fetch(url: str, cache_name: str) -> bytes:
    RAW.mkdir(parents=True, exist_ok=True)
    cached = RAW / cache_name

    if cached.exists():
        return cached.read_bytes()

    request = urllib.request.Request(url, headers={"User-Agent": "averis-ml/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = response.read()

    cached.write_bytes(payload)
    return payload


def load_pima() -> pd.DataFrame:
    """Pima Indians Diabetes — 768 rows, all women of Pima heritage aged 21+."""
    payload = _fetch(PIMA_URL, "pima-indians-diabetes.csv")
    return pd.read_csv(io.BytesIO(payload), header=None, names=PIMA_COLUMNS)


def load_cleveland() -> pd.DataFrame:
    """Cleveland Heart Disease — 303 rows. Ships headerless, missing marked '?'."""
    payload = _fetch(CLEVELAND_URL, "processed.cleveland.data")
    return pd.read_csv(
        io.BytesIO(payload),
        header=None,
        names=CLEVELAND_COLUMNS,
        na_values="?",
    )

"""Fall detection inference.

Walks the exported forest in plain Python — no scikit-learn at serving time, so
the ingest container stays light and the model cannot drift with a library
upgrade. Same pattern as the document-ML phase.

Feature extraction is imported from `fall_features`, the identical module the
trainer used. Recomputing features in a second place is the classic source of
training/serving skew, where a model that scored well offline behaves strangely
in production because a feature quietly means something different.
"""

from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass
from functools import lru_cache

from .fall_features import FEATURE_NAMES, extract_window

ARTIFACT_PATH = pathlib.Path(__file__).resolve().parents[1] / "artifacts" / "fall_detector.json"


@dataclass(frozen=True)
class FallPrediction:
    detected: bool
    probability: float
    confidence: float
    # Which features pushed the decision, for the explanation panel.
    top_features: list[tuple[str, float]]
    detail: str
    model_version: str

    def to_dict(self) -> dict:
        return {
            "fall_detected": self.detected,
            "probability": round(self.probability, 4),
            "confidence": round(self.confidence, 3),
            "top_features": [{"feature": n, "importance": round(v, 4)} for n, v in self.top_features],
            "detail": self.detail,
            "model_version": self.model_version,
        }


@lru_cache(maxsize=1)
def _artifact() -> dict | None:
    """Loaded once. A missing artifact degrades to "no prediction" rather than
    raising — the vital-sign path must keep working when the fall model is
    absent."""
    try:
        return json.loads(ARTIFACT_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _score_tree(node: dict, features: list[float]) -> float:
    while "leaf" not in node:
        node = node["l"] if features[node["f"]] <= node["t"] else node["r"]
    return node["leaf"]


def predict(
    accel: list[tuple[float, float, float]],
    gyro: list[tuple[float, float, float]],
) -> FallPrediction | None:
    """Returns None when there is no artifact or too little IMU data."""
    artifact = _artifact()
    if artifact is None:
        return None

    features = extract_window(accel, gyro)
    if features is None:
        return None

    # The artifact records the feature order it was fitted with. A mismatch
    # means the code and the artifact disagree, and scoring anyway would feed
    # the model a permuted vector and produce confident nonsense.
    if artifact.get("features") != FEATURE_NAMES:
        raise ValueError(
            "Fall model artifact was trained on a different feature set. "
            "Retrain with ai_engine/models/train_fall.py."
        )

    trees = artifact["trees"]
    probability = sum(_score_tree(tree, features) for tree in trees) / len(trees)
    threshold = artifact.get("threshold", 0.5)
    detected = probability >= threshold

    importance = artifact.get("feature_importance", {})
    top = sorted(importance.items(), key=lambda kv: -kv[1])[:3]

    # Distance from the threshold, not the probability itself. A forest voting
    # 0.51 is nearly undecided even though 0.51 sounds like a positive.
    confidence = min(1.0, abs(probability - threshold) * 2)

    if detected:
        detail = (
            f"Movement pattern consistent with a fall ({probability * 100:.0f}% of trees agreed). "
            f"A dropped device can look the same from motion alone — please confirm."
        )
    else:
        detail = f"No fall pattern detected ({probability * 100:.0f}% of trees indicated one)."

    return FallPrediction(
        detected=detected,
        probability=probability,
        confidence=confidence,
        top_features=top,
        detail=detail,
        model_version=f"{artifact['model']}-{artifact['version']}",
    )


def model_card() -> dict | None:
    """The artifact's provenance, for display. Includes the synthetic-data
    caveat so it reaches a reader rather than living only in a docstring."""
    artifact = _artifact()
    if artifact is None:
        return None

    return {
        "model": artifact["model"],
        "version": artifact["version"],
        "algorithm": artifact["algorithm"],
        "trained_at": artifact["trained_at"],
        "dataset": artifact["dataset"],
        "metrics": artifact["metrics"],
    }

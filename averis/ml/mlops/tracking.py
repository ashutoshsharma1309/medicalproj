"""MLflow experiment tracking.

Answers one question that the committed artifacts cannot: *how did this model
come to be?* The artifact records what the model is. This records the run that
produced it — the data it saw, the parameters it was given, every family that
was compared, and which one shipped.

That matters the first time a model behaves differently in production than the
metrics suggest. Without a run history the only available move is to retrain
and hope the difference reproduces.

Tracking is **optional and never fatal**. `mlflow-skinny` is a training-time
dependency, and a machine that lacks it must still be able to produce
artifacts — otherwise the pipeline that generates the application's inputs is
gated on an observability tool.

Runs go to a local SQLite store at `ml/mlruns/mlflow.db` by default. Point
`MLFLOW_TRACKING_URI` at a server to send them somewhere shared instead:

    MLFLOW_TRACKING_URI=http://mlflow:5000 .venv/bin/python train_all.py
    .venv/bin/mlflow ui --backend-store-uri sqlite:///ml/mlruns/mlflow.db
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import pathlib
import platform
from typing import Any, Iterator

DEFAULT_STORE = pathlib.Path(__file__).parents[1] / "mlruns"

EXPERIMENT = "averis-risk-models"


def tracking_uri() -> str:
    """Where runs are written.

    SQLite rather than the bare-directory file store: MLflow 3.x put the file
    backend into maintenance mode and now raises on it unless you opt out.
    SQLite is a single file, needs no server, and is what the migration guide
    points at — so it keeps the "no infrastructure required" property that
    made the file store attractive in the first place.
    """
    configured = os.environ.get("MLFLOW_TRACKING_URI")
    if configured:
        return configured
    DEFAULT_STORE.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{(DEFAULT_STORE / 'mlflow.db').resolve()}"


def artifact_location() -> str:
    DEFAULT_STORE.mkdir(parents=True, exist_ok=True)
    return (DEFAULT_STORE / "artifacts").resolve().as_uri()


def dataset_fingerprint(frame) -> str:
    """A content hash of the training data.

    The single most useful thing to record. "Accuracy dropped" and "accuracy
    dropped *and the data changed*" are different investigations, and without
    a fingerprint there is no way to tell them apart after the fact — the
    dataset is downloaded at train time and the cached copy is gitignored.
    """
    digest = hashlib.sha256()
    digest.update(",".join(map(str, frame.columns)).encode())
    digest.update(str(frame.shape).encode())
    # Hash the values rather than the object: pandas repr is not stable across
    # versions, and a fingerprint that changes on upgrade is worse than none.
    digest.update(frame.to_csv(index=False).encode())
    return digest.hexdigest()[:16]


@contextlib.contextmanager
def track_run(model: str, tags: dict[str, str] | None = None) -> Iterator[Any]:
    """Yields a logger, or a no-op when MLflow is unavailable.

    The caller does not branch on whether tracking is enabled — it logs
    unconditionally and the no-op absorbs it. Branching at every call site is
    how half the metrics end up inside an `if` and half outside.
    """
    try:
        import mlflow
    except ImportError:
        yield _NullRun()
        return

    try:
        mlflow.set_tracking_uri(tracking_uri())

        # Created explicitly so the artifact root is a real path rather than
        # one relative to whatever directory the trainer happened to run from.
        if mlflow.get_experiment_by_name(EXPERIMENT) is None:
            mlflow.create_experiment(EXPERIMENT, artifact_location=artifact_location())
        mlflow.set_experiment(EXPERIMENT)

        with mlflow.start_run(run_name=model):
            mlflow.set_tags(
                {
                    "model": model,
                    "python": platform.python_version(),
                    "platform": platform.platform(),
                    **(tags or {}),
                }
            )
            yield _MlflowRun(mlflow)
    except Exception as error:  # noqa: BLE001 - tracking must never fail a run
        print(f"  note: MLflow tracking unavailable ({error}); continuing untracked")
        yield _NullRun()


class _MlflowRun:
    def __init__(self, mlflow: Any) -> None:
        self._mlflow = mlflow

    def params(self, values: dict[str, Any]) -> None:
        self._mlflow.log_params(values)

    def metrics(self, values: dict[str, float], prefix: str = "") -> None:
        self._mlflow.log_metrics(
            {f"{prefix}{k}": float(v) for k, v in values.items() if _numeric(v)}
        )

    def artifact_json(self, name: str, payload: dict) -> None:
        # Written through a temp file because log_dict is not in every
        # mlflow-skinny build, and a missing helper should not lose the run.
        path = pathlib.Path(f"/tmp/averis-{name}")
        path.write_text(json.dumps(payload, indent=2))
        self._mlflow.log_artifact(str(path))
        path.unlink(missing_ok=True)


class _NullRun:
    def params(self, values: dict[str, Any]) -> None:  # noqa: ARG002
        pass

    def metrics(self, values: dict[str, float], prefix: str = "") -> None:  # noqa: ARG002
        pass

    def artifact_json(self, name: str, payload: dict) -> None:  # noqa: ARG002
        pass


def _numeric(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)

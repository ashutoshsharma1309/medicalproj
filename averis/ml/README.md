# AVERIS — ML Health Risk Intelligence

Training pipeline for the two risk models AVERIS serves: **diabetes risk** and
**cardiovascular risk**.

This directory is a *training* pipeline. Nothing here runs in production. It
emits a portable JSON artifact that the Next.js application loads and scores
against directly.

```
datasets/ → preprocessing/ → models/ → evaluation/ → prediction/export.py
                                                          ↓
                                            ../lib/ml/artifacts/*.json
                                                          ↓
                                              inference in TypeScript
```

## Why inference does not run in Python

The obvious design is a FastAPI sidecar that holds the pickled models. We
deliberately did not do that.

A sidecar means a second runtime to deploy and keep alive, a network hop
carrying patient health data, and an authentication boundary between the app
and the model server that has to be designed, secured and audited. For a
logistic regression over eight features, the actual inference is a dot product.
The complexity is entirely in the operational surface, not the mathematics.

So the pipeline exports coefficients, the scaler's mean and scale, and the
training-set feature means, and `lib/ml/` scores them in TypeScript. There is
no second service, no PHI crossing a process boundary, and no model file
reachable over the network.

## Why logistic regression serves

`train_all.py` trains and scores three families on every dataset — logistic
regression, random forest, and gradient boosting (XGBoost where the platform
supports it, scikit-learn's implementation otherwise). Every model's metrics
are exported and shown in the app, so the comparison is real and visible.

Logistic regression is what actually serves, for two reasons:

1. **SHAP is exact.** For a linear model in log-odds space the Shapley value of
   a feature has a closed form — `coefficient × (value − training mean)`. There
   is no sampling, no background-set approximation, and no variance between
   runs. When AVERIS tells a patient "your glucose contributed +35%", that
   number is a computation, not an estimate.
2. **It is what clinical risk scoring actually uses.** Framingham, QRISK and
   FINDRISC are logistic or Cox models. The reason is auditability: a
   clinician can read the coefficients and see what the model rewards.

If a tree ensemble wins by a wide margin on ROC-AUC, that is worth knowing and
the metrics table will show it. It is not automatically worth trading an exact
explanation for.

## Running it

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python train_all.py
```

Datasets are downloaded on first run and cached under `datasets/raw/`, which is
gitignored. The exported artifacts under `../lib/ml/artifacts/` **are**
committed — they are small, and the application cannot start without them.

## Datasets

| Model | Dataset | Rows | Source |
|---|---|---|---|
| Diabetes risk | Pima Indians Diabetes | 768 | UCI / NIDDK |
| Cardiovascular risk | Cleveland Heart Disease | 303 | UCI |

Both are small on purpose. They train in seconds, they are public, and they are
the standard reference datasets for these two problems.

### A caveat that belongs in the product, not just the README

The Pima dataset is drawn entirely from women of Pima heritage aged 21 and
over. A model fitted to it does not transfer cleanly to men, to other
populations, or to younger patients. The Cleveland cohort is small and
predominantly male. Neither supports a claim about an individual patient's
future.

This is why AVERIS presents these as awareness signals with a visible
disclaimer, and never as a diagnosis or a prediction of what will happen.

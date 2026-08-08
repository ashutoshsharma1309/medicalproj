# AVERIS — the AI pipeline

Five places in AVERIS use a model. They follow one rule, and the rule is the
architecture:

> **Numbers are computed. Models only phrase them.**

A language model asked whether oxygen saturation fell over 24 hours will
produce a confident direction from nothing. Handed a decline it did not
compute, it cannot invent one. Every generative feature below is built so the
worst a model failure can produce is clumsy prose about true facts — never a
trend that did not happen.

---

## The five

| # | Feature | What computes | What a model does |
|---|---|---|---|
| 1 | Risk scoring (ML) | Logistic regression + SHAP, in-process | Nothing |
| 2 | Vital-stream intelligence | `ai_engine/` — rules, anomaly detection, trends | Nothing |
| 3 | Fall detection | A trained classifier over IMU windows | Nothing |
| 4 | Patient summaries | `lib/care/report.ts` — arithmetic over stored readings | Phrases the assembled facts |
| 5 | Health assistant | Intent classification + the same assembly | Phrases the answer |

Three of the five involve no language model at all.

---

## 1. Risk scoring

`lib/ml/` — logistic regression scored in TypeScript, in-process, no network.

Trained in Python (`ml/`), exported as coefficients to
`lib/ml/artifacts/*.json`, and evaluated at request time. **SHAP values are
exact**, not approximated: for a linear model the contribution of each feature
is a multiplication, so the explanation is arithmetic rather than an estimate
of what the model might have been doing.

```
patient profile ──▶ feature mapping ──▶ logistic model ──▶ score
                                              │
                                              └──▶ exact per-feature contributions
```

**The cohort travels with the number.** The diabetes model is fitted on the
Pima dataset (768 women of Pima heritage, 21+); the cardiovascular model on the
Cleveland cohort (303 cardiac referrals, predominantly male, no BMI or smoking
recorded). Neither transfers cleanly to an arbitrary patient, and the UI shows
the cohort on the same screen as the percentage — because a risk figure without
its provenance is a claim the model cannot support.

## 2. Vital-stream intelligence

`ai_engine/`, Python, called by the ingest service after a reading lands.

```
readings ──▶ clean ──▶ features ──▶ ┌── risk engine ──▶ score + contributions
                                    ├── anomaly detection
                                    ├── trend analysis ──▶ insights
                                    └── fall model ──▶ prediction
```

Deliberately kept off the ingest path's critical section: a reading that
reached the database is a measurement, and losing it to a modelling error would
trade the record for an opinion about the record.

**A model-detected fall escalates the risk *level*, never the score.**
Recomputing the score would make the contributions stop summing to it, and the
explanation panel would silently stop adding up.

## 3. Fall detection

Two independent detectors, and they are not the same thing:

- **On the band** — a rule-based state machine: free fall → impact → stillness,
  in that order, inside a window. No training data, no model.
- **On the server** — a classifier over IMU windows, trained on **synthetic
  motion**. That caveat is carried in the model card, in the evidence of every
  emergency it raises, and in the UI.

Either can raise a fall; the escalation layer collapses both into one event,
because one fall reported twice makes a clinician check whether the patient
fell twice.

## 4. Patient summaries

`lib/care/report.ts` (assembly, pure) → `lib/care/report-service.ts` (narration).

```
stored readings ──▶ assembleReport() ──▶ ReportSections   (all arithmetic)
                                              │
                                              ├──▶ describeReport() ──▶ model ──▶ guardrail
                                              └──▶ deterministicNarrative()  (fallback)
```

**Drift is measured first-fifth to last-fifth**, not first-to-last: two
readings taken during a cough and during sleep would otherwise become a trend.
Under ten readings, no direction is reported at all.

**Three fallbacks land in the same place** — no key configured, the call
failed, or the guardrail rejected the output. Each falls through to the
deterministic narration of the same sections, so a clinician who asks for a
summary always receives one and always receives a true one. The stored report
records which produced it.

**The guardrail is aimed at the reader.** The patient-facing one appends "talk
to your healthcare provider"; the clinical one must not, because the reader *is*
the provider. What it rejects is AVERIS reaching a conclusion or proposing a
course of action — a monitoring platform that recommends treatment has quietly
become a medical device. Rejected output is replaced with the deterministic
narration rather than an apology: a clinician who asked for a summary and got a
refusal has nothing.

## 5. The health assistant

`lib/care/assistant.ts` — and the reason it is not a chatbot with a record
attached is structural, not a matter of prompt wording:

1. The question is **classified** into the small set of things monitoring data
   can answer.
2. The context is the **same assembled arithmetic** the summary uses, so the
   assistant cannot contradict a summary of the same window.
3. Every intent has a **deterministic answer**, so it works with no model
   configured.
4. Diagnosis, prescription and prognosis requests are **refused before a model
   is called**.

Point 4 is the one that matters. A refusal that depends on the model honouring
its system prompt can be argued out of, and "should I stop my beta blocker" is
exactly the question someone keeps rephrasing until something answers.

A bare time phrase does not make a question about trends: *"what did the
cardiologist say last week?"* is about a consultation, and matching on "last
week" would have sent it to a model with a fact sheet of heart rates and got a
fluent non-answer.

---

## Retrieval (RAG), for documents

Separate from all of the above and older than the IoT track. `lib/rag/` answers
questions about **uploaded documents**, with embeddings from `all-MiniLM-L6-v2`
running in-process via transformers.js and retrieval over pgvector.

Kept separate from the monitoring assistant on purpose: one answers from
documents, the other from the last 24 hours of measurements. Merging them would
mean one box whose answer depends on which retriever happened to match, and a
patient could not tell which they got.

---

## The provider

`lib/ai/provider.ts`. Groq or xAI, inferred from the key prefix — both expose
an OpenAI-compatible shape, so one client serves either.

`server-only`, so importing it from a Client Component is a build error rather
than a leaked key.

**Every generative path degrades to deterministic.** No key configured is a
supported state, exercised by the test suite, and the UI says which produced
what it is showing. A summary whose provenance is hidden is one a clinician has
to trust rather than assess.

---

## What is deliberately absent

- **No diagnosis, anywhere.** Enforced by guardrails in code, asserted in
  tests, and stated in every disclaimer.
- **No treatment recommendation**, for the same reason.
- **No model trained on patient data from this platform.** Nothing here learns
  from the people it monitors.
- **No fine-tuning, no embeddings of clinical text sent to a third party** — the
  embedding model runs in-process.
- **No drift detection.** The prerequisites exist (model registry, inference
  logging); the detector does not.

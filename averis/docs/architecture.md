# AVERIS — architecture

## What it is

A personal health record that reads a patient's own medical documents, assembles
them into one picture, estimates statistical risk from public research models,
and answers questions grounded in what it actually holds.

What it deliberately is not: a diagnostic tool, a doctor replacement, or a
medical chatbot. Every one of those distinctions shows up as a constraint in the
code rather than a line in the marketing.

## System shape

```
                        ┌──────────────────────────────┐
   Browser ─── HTTPS ──▶│  Next.js (Cloud Run)         │
                        │  · App Router, RSC           │
                        │  · Server Actions            │
                        │  · ML inference (in-process) │
                        │  · Embeddings (in-process)   │
                        └───────┬──────────────┬───────┘
                                │              │
                     ┌──────────▼───┐   ┌──────▼────────┐
                     │  Supabase    │   │  Redis        │
                     │  · Postgres  │   │  · cache      │
                     │  · pgvector  │   │  · rate limit │
                     │  · Auth      │   └───────────────┘
                     │  · Storage   │
                     └──────────▲───┘
                                │  claim jobs (service role)
                        ┌───────┴──────────────────────┐
                        │  Worker (Cloud Run)          │
                        │  · OCR                       │
                        │  · AI extraction             │
                        │  · indexing                  │
                        └──────────────┬───────────────┘
                                       │
                              ┌────────▼─────────┐
                              │  Groq / xAI      │
                              │  (phrasing only) │
                              └──────────────────┘
```

Two runtime services from one image, plus managed Postgres and Redis. That is
the whole topology.

## The decision this architecture keeps making

Every phase presented the same fork, and it was answered the same way each time:
**keep the compute in one process unless there is a reason not to.**

- **Phase 4** could have put a FastAPI sidecar in front of the pickled models.
  It scores a logistic regression over eight features — a dot product. The
  sidecar's cost is a second runtime to deploy, a network hop carrying patient
  health data, and a service-to-service auth boundary to design and audit.
- **Phase 5** could have run sentence-transformers in Python. It is a 23 MB
  ONNX model; transformers.js runs it in the same process.

The one place the answer flipped is the **worker**, and the reason is
instructive: it is not about compute, it is about *time*. OCR plus extraction
takes tens of seconds, which in the request container competes with every page
a patient loads and holds a Cloud Run request slot. It also scales on a
different signal — queue depth, not concurrent readers.

**When to split further.** When ML inference becomes GPU-bound, when embedding
throughput needs batching across requests, or when the AI provider integration
needs to fail independently of page rendering. None of those is true yet, and
building for them now would mean securing three service boundaries to serve
zero users.

## Data flow

### Document → record

```
upload ──▶ validate (magic bytes, size, MIME)
       ──▶ Supabase Storage (private bucket, RLS)
       ──▶ processing_jobs row  ─────────┐
       ──▶ inline processing            │
                                        ▼
                              worker claims (SKIP LOCKED)
                                        │
        OCR / PDF text ──▶ AI extraction ──▶ confidence scoring
                                        │
                              PENDING_REVIEW ──▶ patient confirms
                                        │
                    patient_medical_records ──▶ twin refresh
                                        │
                              knowledge_embeddings (RAG index)
```

Nothing reaches the health record without the patient confirming it. The AI
proposes; the patient decides. That is why `document_extractions` and
`patient_medical_records` are separate tables rather than one.

### Question → answer

```
question ──▶ embed (MiniLM, 384d)
         ──▶ match_knowledge()      ← RLS applies INSIDE the ranking
         ──▶ balanced retrieval (patient chunks + reference chunks)
         ──▶ context builder (relevance floor, patient-first ordering)
         ──▶ LLM phrases it, using only that context
         ──▶ anti-diagnosis guardrail
         ──▶ answer + sources + disclaimer
```

### Record → risk

```
Digital Twin ──▶ feature extraction (only exact matches)
             ──▶ scale ──▶ logistic regression ──▶ probability
             ──▶ closed-form SHAP ──▶ contributions
             ──▶ LLM phrases the numbers (never computes them)
```

## Security model

Authorization lives in **Row Level Security**, not in application code, and the
reason is a design principle rather than a preference: an application-layer
check is a rule that has to be remembered at every call site, and the call site
that forgets is indistinguishable from one that did not need it.

| Table | Read | Write | Notable |
|---|---|---|---|
| `patient_profiles` | owner | owner | — |
| `medical_documents` | owner | owner | private storage bucket |
| `patient_medical_records` | owner | owner | patient-confirmed only |
| `patient_health_timeline` | owner | owner | `derived` flag protects manual entries |
| `health_predictions` | owner | insert only | **immutable** — no UPDATE policy |
| `model_metrics` | any signed-in | none | public research data |
| `knowledge_embeddings` | own + shared | own only | RLS applies inside the ANN scan |
| `ai_conversations` | owner | owner | — |
| `audit_logs` | own | append only | **not deletable by its subject** |
| `notifications` | owner | none | system-written, unforgeable |
| `subscriptions` | owner | none | a writable plan is not a plan |

Three of those need the emphasis:

**Retrieval isolation is structural.** `match_knowledge` is `SECURITY INVOKER`,
so the caller's policies apply *inside* the `ORDER BY`. A similarity search
cannot rank another patient's chunk, because it cannot see it. The Phase 5
assertions prove this by giving two patients' chunks identical vectors — on
pure distance they tie, and only the policy separates them.

**Audit logs are append-only including to their subject.** A trail the audited
party can delete is not evidence of anything.

**The worker is the only service-role holder.** Claiming jobs necessarily
crosses patients, which is exactly what RLS prevents for user-facing code. The
claim function has `EXECUTE` revoked from every client role, so no session can
reach it.

## The AI boundary

One rule, applied everywhere:

> **Deterministic code decides. The language model phrases.**

| Decision | Who makes it |
|---|---|
| Risk probability | logistic regression |
| Feature contributions | closed-form SHAP |
| Lab trends | arithmetic over confirmed values |
| Record completeness | rule-based scoring |
| Which sources are relevant | cosine similarity + threshold |
| **How any of it reads** | **the LLM** |

The failure this prevents is specific. A model asked "how likely is this
patient to develop diabetes" will answer — fluently, confidently, and with no
basis. Handing it pre-computed numbers and asking only for sentences removes
the opportunity.

Every generated string then passes `enforceNoDiagnosis`, and a trip replaces
the output with deterministic text rather than showing it. That guard has
caught real drift twice: gpt-oss producing "these findings indicate your
diabetes may need attention", and two of my own knowledge-base articles.

## Observability

Structured JSON, one line per event, with redaction that fails closed —
an allowlist for audit metadata, a forbidden-key pattern for logs.

A log line is the easiest way for health information to escape a system that is
otherwise careful with it: shipped to a third-party aggregator, retained for
months, indexed, and read by engineers with no clinical relationship to anyone
in it. The rule for call sites is *log identifiers and outcomes, never content*.

Liveness touches no dependency; readiness reports unready only for hard ones.
A liveness probe that checks the database fails during a database outage, and
restarting a healthy container only loses its warm model cache while adding
load to the thing already struggling.

## MLOps

```
Pima / Cleveland ──▶ clean ──▶ train 3 families ──▶ evaluate
                                      │
                        ┌─────────────┴──────────────┐
                        ▼                            ▼
              artifacts/*.json               MLflow run
              (coefficients, SHAP            (params, metrics,
               baseline, fixtures)            dataset fingerprint)
```

The **dataset fingerprint** is the field that earns its place. "Accuracy
dropped" and "accuracy dropped *and the data changed*" are different
investigations, and the datasets are downloaded at train time with the cached
copy gitignored — without a content hash there is no way to tell them apart
afterwards.

Exported SHAP reference values are checked against the TypeScript
implementation on every test run, so the scorer is verified against Python's
`shap` library rather than against itself.

## What is deliberately absent

- **Payments.** `subscriptions` exists and limits are enforced, so adding a
  provider means writing to a row rather than retrofitting entitlement checks.
- **Email and push notifications.** Named as future work and not stubbed: a
  channel that silently does nothing is worse than an absent one, because the
  code reads as though patients are being told.
- **Data drift detection.** The model registry and inference logging are the
  prerequisites and they exist; the detector does not.
- **Multi-tenancy beyond the patient.** No clinic or provider accounts. Adding
  them means a second axis in every policy, which is a schema change and not a
  feature flag.

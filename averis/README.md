# AVERIS

**Your intelligent healthcare journey starts here.**

AVERIS is a personal health record that reads a patient's own medical documents,
assembles them into one picture, estimates statistical risk from public research
models, and answers questions grounded in what it actually holds.

It does not diagnose, and it does not replace a clinician. Both are enforced in
code rather than asserted in copy — see [Safety](#safety).

---

## What it does

| Phase | Capability |
|---|---|
| **1** | Email/password and Google authentication, patient profile, RLS-backed Supabase schema |
| **2** | Document upload → OCR → AI extraction → **patient review** → structured records |
| **3** | Digital Twin: medical timeline, condition and medication history, health insights |
| **4** | ML risk prediction (diabetes, cardiovascular) with exact SHAP explanations |
| **5** | Retrieval-augmented Q&A over the patient's own records, with source attribution |
| **6** | Audit trail, plan limits, rate limiting, caching, background worker, CI/CD, MLOps |

Then the IoT track, which turns the record into a monitoring platform:

| Phase | Capability |
|---|---|
| **IoT 1** | Device registry, token-authenticated FastAPI ingest, sensor time-series, threshold alerts |
| **IoT 2** | Live streaming over websockets, real-time vitals and charts, sensor simulator |
| **IoT 3** | Health intelligence: anomaly detection, risk scoring, fall detection, explainable insights |
| **IoT 4** | Doctors, caregivers and emergency response |
| **IoT 5** | Real ESP32 wearable: sensors, OLED, buzzer, BLE, offline buffering |

A patient uploads a blood report, confirms what AVERIS read from it, and then
has a timeline, a risk estimate showing exactly which values drove it, and the
ability to ask "what does my HbA1c mean?" — answered from that report plus a
cited reference range.

## Architecture

Two runtime services from one image, plus managed Postgres and Redis.

```
Browser ──▶ Next.js (Cloud Run) ──▶ Supabase (Postgres + pgvector + Auth + Storage)
                 │                        ▲
                 └──▶ Redis               │ service role
                                    Worker (Cloud Run) ──▶ Groq / xAI
```

ML inference and embeddings run **in-process**, not in sidecars. The reasoning —
and the one case where it flipped — is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Tech stack

- **Next.js 16** (App Router, Server Components, Server Actions) · TypeScript · Tailwind v4
- **Supabase** — Postgres, Row Level Security, Auth, Storage, pgvector
- **scikit-learn / XGBoost / SHAP** for training; logistic regression scored in TypeScript
- **transformers.js** — `all-MiniLM-L6-v2` embeddings, 384 dimensions
- **Groq** (or xAI) for phrasing only, never for computation
- **MLflow** for experiment tracking · **Redis** for cache and rate limits
- **Docker** · **GitHub Actions** · **GCP Cloud Run**

## Getting started

```bash
git clone <repo> && cd medicalproj/averis
npm install
cp .env.example .env.local     # fill in the Supabase values
npm run dev
```

### Database

Paste these into the Supabase SQL editor, in order:

1. `supabase/apply-all.sql` — the complete schema (19 tables, 58 RLS policies)
2. `supabase/seed/model_metrics.sql` — ML model comparison data
3. `supabase/seed/knowledge_base.sql` — medical reference corpus, embeddings included

Both seeds are generated and idempotent: re-running updates rather than duplicates.

> **pgvector** is required from Phase 5 onward. The migration enables it; on
> Supabase the extension is available by default.

After deploying, add `https://<your-domain>/auth/callback` to the Supabase
redirect allowlist.

### Optional

```bash
# Retrain the risk models (regenerates artifacts and the metrics seed)
cd ml && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python train_all.py

# Regenerate the knowledge corpus
npx tsx scripts/seed-knowledge.mjs

# Full local stack: web + worker + redis
docker compose up
```

> XGBoost needs OpenMP (`brew install libomp` on macOS). Without it the pipeline
> substitutes scikit-learn's gradient boosting and records which one ran.

## Verification

```bash
npm test                     # 423 tests — no database, no network, no API key
npx tsc --noEmit             # type check
npm run build                # production build

# 125 Python tests: wire-contract conformance, the AI engine, escalation
iot-service/.venv/bin/python -m pytest iot-service/tests ai_engine/tests -q

# 67 firmware checks — filters, fall detection, payload encoding. No ESP32.
firmware/averis-wearable/test/run.sh

# 254 RLS assertions against the unmodified production migrations
PG_CONTAINER=<pg-container> PG_USER=postgres ./supabase/tests/run.sh
```

Everything under `lib/` that decides something is pure or injectable, which is
why the suite runs offline. The RLS suite applies the real migrations to a
throwaway database and asserts one patient cannot reach another's data —
including through a vector similarity search.

## Safety

The product rules are structural, not conventional.

**Deterministic code decides; the language model phrases.** Risk probabilities
come from a logistic regression, contributions from closed-form SHAP, lab
trends from arithmetic over confirmed values. The LLM receives those numbers
and is asked only to turn them into sentences — a model asked to *compute* a
trend will invent one.

**Every generated string passes an anti-diagnosis guard.** A trip replaces the
output with deterministic text rather than showing it. This has caught real
drift twice, including in this repository's own reference articles.

**Nothing enters the health record without patient confirmation.** Extractions
and confirmed records are separate tables for exactly this reason.

**Authorization lives in RLS, not application code.** An application-layer check
is a rule that must be remembered at every call site. `match_knowledge` is
`SECURITY INVOKER`, so a similarity search cannot rank another patient's chunk
— it cannot see it.

**Audit logs are append-only, including to their subject.** A trail the audited
party can delete is not evidence of anything.

## Environment

See [`.env.example`](.env.example). The essentials:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_ANON_KEY` | Publishable key — safe in the browser *because* RLS protects the data |
| `GROQ_API_KEY` | Phrasing only. Absent, AVERIS falls back to deterministic text |
| `REDIS_URL` | Shared cache and rate limits. Unset ⇒ in-process, correct for one instance only |
| `SUPABASE_SERVICE_ROLE_KEY` | **Worker only.** Bypasses RLS entirely — never set it on the web service |

Anything prefixed `NEXT_PUBLIC_` is inlined into the browser bundle. A secret
with that prefix is a published secret.

## Deployment

```bash
gh workflow run deploy.yml -f environment=staging
```

Manual by design — a push that deploys itself means a mistaken merge reaches
patients before anyone reads it. The workflow authenticates with Workload
Identity Federation (no long-lived service-account key), deploys with
`--no-traffic`, probes `/api/health/ready` on the tagged revision, and only then
migrates traffic.

Runtime secrets are bound from **Secret Manager** by reference, so no value
passes through a workflow log or an image layer. `NEXT_PUBLIC_*` values are
build args because Next.js inlines them into the client bundle.

## Project structure

```
averis/
├── app/
│   ├── (app)/                dashboard · records · twin · risk ·
│   │                         intelligence · monitoring · devices ·
│   │                         clinical · care · care-team · activity
│   ├── (auth)/               login · signup · OAuth callback
│   └── api/                  risk endpoint · health probes
├── lib/
│   ├── services/documents/   OCR · extraction · review · reconciliation
│   ├── services/twin/        timeline · insights · overview      (pure)
│   ├── care/                  triage · escalation · reports ·
│   │                          assistant · voice                   (pure core)
│   ├── iot/                   validation · alert rules · series   (pure)
│   ├── ml/                   inference · SHAP · feature mapping  (pure)
│   ├── rag/                  chunking · retrieval · grounded answers
│   ├── audit/ plans/ cache/ jobs/ security/ observability/
│   └── supabase/             browser · server · proxy clients
├── firmware/averis-wearable/ ESP32 firmware — logic tests run on the host
├── ai_engine/                Python health intelligence engine
├── iot-service/              FastAPI ingest, websocket hub, escalation
├── sensor_simulator/         speaks the device wire contract
├── ml/                       Python training pipeline + MLflow
├── supabase/
│   ├── migrations/           the source of truth for the schema
│   ├── seed/                 generated: model metrics · knowledge corpus
│   └── tests/                RLS assertions, one file per phase
├── scripts/                  worker · seed generation · model prefetch
├── docs/ARCHITECTURE.md
└── proxy.ts                  Next.js 16 route protection + token refresh
```

## Known gaps

- **Google OAuth** is implemented but needs credentials configured in Supabase.
- **Email confirmation** is on, so full signup testing needs it disabled or a real inbox.
- **Payments** are deliberately absent. `subscriptions` and limit enforcement exist, so
  adding a provider is a row write rather than a retrofit.
- **Email and push notifications** are not stubbed — a channel that silently does nothing
  is worse than an absent one, because the code reads as though patients are being told.
  Emergency notices are in-app only for the same reason.
- **No escalation ladder.** An emergency nobody acknowledges stays open and nothing else
  happens: no timeout, no on-call rotation, no fallback contact. The most important gap
  in the care-team work, and the next honest piece of it.
- **Clinician verification** is not implemented. `doctors` rows are created out of band and
  `verified_at` is never set, so the UI says the licence is unverified rather than showing
  a badge nobody checked.
- **Data drift detection** has its prerequisites (model registry, inference logging) but
  no detector.
- **The wearable is a prototype, not a medical device.** SpO₂ uses the MAX30102 datasheet's
  generic curve rather than a calibration against a reference oximeter, and the MLX90614
  reports skin temperature with no correction to core temperature. Both limits are stated in
  [docs/HARDWARE.md](docs/HARDWARE.md) and surfaced in the UI rather than hidden behind a
  fudge factor.
- **A band dropped on a table registers as a fall.** An accelerometer cannot distinguish a
  still wrist from a still table; the skin-contact signal that would suppress it is not wired
  into the fall path yet. Asserted in the firmware tests as a known limitation.

## A note on the models

The diabetes model is fitted on the Pima Indians dataset: 768 women of Pima
heritage aged 21 and over. The cardiovascular model uses the Cleveland cohort:
303 cardiac referrals, predominantly male, recording neither BMI nor smoking.

Neither transfers cleanly to an arbitrary patient, and neither supports a claim
about an individual's future. AVERIS presents both as awareness signals with the
cohort and its caveat on the same screen as the number — because a risk
percentage without its provenance is a claim the model cannot support.

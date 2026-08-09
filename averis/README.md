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
| **IoT 6** | Health command centre, clinical zones, guided demonstration |
| **IoT 7** | Personal baselines, deterioration detection, rural mode, Hindi insights |

A patient uploads a blood report, confirms what AVERIS read from it, and then
has a timeline, a risk estimate showing exactly which values drove it, and the
ability to ask "what does my HbA1c mean?" — answered from that report plus a
cited reference range.

## Architecture

```
  ESP32 wearable                    Browser
  MAX30102 · MLX90614 · MPU6050        │
  OLED · buzzer · LiPo                 │
        │                              │
        │ HTTPS + bearer token         │
        ▼                              ▼
  FastAPI ingest ─────────────▶  Next.js (Cloud Run)
  validate · alert · escalate          │        │
        │         ▲                    │        └──▶ Redis
        │         │ service role       │ RLS, as the signed-in user
        ▼         │                    ▼
     Supabase ◀───┴──── Worker ──▶ Groq / xAI
     Postgres · pgvector · Auth · Storage · Realtime
        │
        ▼
  AI engine (Python) ──▶ risk · anomalies · falls ──▶ emergency ──▶ care team
        │
        ▼
  Personal baseline ──▶ "unusual for THIS patient" ──▶ deterioration over days
```

**The web app never holds a service-role key.** It talks to Postgres as the
signed-in user, over Row Level Security — so a bug in a page cannot read a
chart the policy would refuse, because the page has no credential that bypasses
the policy. Only the ingest service and the worker hold one, and both run as
separate processes.

ML inference and embeddings run **in-process**, not in sidecars. The reasoning —
and the one case where it flipped — is in **[docs/architecture.md](docs/architecture.md)**.

## Stack

### Software

- **Next.js 16** (App Router, Server Components, Server Actions) · TypeScript · Tailwind v4
- **Supabase** — Postgres, Row Level Security, Auth, Storage, pgvector
- **scikit-learn / XGBoost / SHAP** for training; logistic regression scored in TypeScript
- **transformers.js** — `all-MiniLM-L6-v2` embeddings, 384 dimensions
- **Groq** (or xAI) for phrasing only, never for computation
- **MLflow** for experiment tracking · **Redis** for cache and rate limits
- **Docker** · **GitHub Actions** · **GCP Cloud Run**

### Hardware

- **ESP32-WROOM-32** · Arduino C++ · PlatformIO
- **MAX30102** heart rate and SpO₂ · **MLX90614** infrared skin temperature ·
  **MPU6050** motion and falls
- **SSD1306** OLED · passive buzzer · 3.7 V LiPo with a divider on ADC1
- WiFi (HTTP) primary, **BLE read-only** as a local view

Full pin map, wiring and accuracy limits: **[docs/hardware.md](docs/hardware.md)**.
Bring-up procedure: **[HARDWARE_INTEGRATION_GUIDE.md](HARDWARE_INTEGRATION_GUIDE.md)**.

## Getting started

```bash
git clone <repo> && cd medicalproj/averis
npm install
cp .env.example .env.local     # fill in the Supabase values

./scripts/setup_database.sh    # migrations + seeds + schema validation + RLS suite
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

## Running the pieces

Four processes. You need the first two; the rest depend on what you are doing.

```bash
# 1 — the web app
npm run dev                                   # http://localhost:3100

# 2 — the ingest service, which devices talk to
cd iot-service
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
set -a && . ./.env && set +a
.venv/bin/uvicorn app.main:app --port 8000

# 3 — the simulator, standing in for a wearable
python3 sensor_simulator/simulate.py \
  --token avd_... --device-key AVR001 --mode normal      # normal | warning | emergency

# 4 — the background worker, for document processing
npx tsx scripts/worker.ts
```

The simulator speaks the **same HTTP contract the firmware does** — bearer
token, same JSON, same endpoint. It is a separate process, not seeded rows,
which is why swapping it for real hardware changes nothing else in the system.

Register its device with **"This is a simulator"** ticked. Every row it writes
is then stamped as generated and stays distinguishable from a measurement.

### When the ESP32 arrives

```bash
cd firmware/averis-wearable
cp src/config.example.h src/config.h    # key, token, WiFi, ingest URL
pio run -t upload
```

Stop the simulator, start the band. Nothing else changes — same endpoint, same
payload, same pipeline, same dashboards. Full procedure:
**[HARDWARE_INTEGRATION_GUIDE.md](HARDWARE_INTEGRATION_GUIDE.md)**.

### A guided demonstration

```bash
NEXT_PUBLIC_DEMO_MODE=true npm run dev      # then open /demo
```

Six steps from sensor to clinician, each checked against live data. It seeds
nothing — it tells you which simulator command to run and then verifies what
actually happened.

## Verification

```bash
./run_all_tests.sh           # every suite; writes TEST_REPORT.md

# or individually:
npm test                     # 668 tests — no database, no network, no API key
npx tsc --noEmit             # type check
npm run build                # production build
node scripts/audit-gate.mjs  # blocks on any critical, and any unargued high

# 153 Python tests: wire-contract conformance, the AI engine, escalation,
# batching, and the inference service's auth boundary
iot-service/.venv/bin/python -m pytest \
  iot-service/tests ai_engine/tests services/ai-service/tests -q

# 91 firmware checks — filters, fall detection, edge policy, payload encoding.
firmware/averis-wearable/test/run.sh

# 280 RLS assertions against the unmodified production migrations
PG_CONTAINER=<pg-container> PG_USER=postgres ./supabase/tests/run.sh

# Does a backup actually restore with its authorisation model intact?
PG_USER=postgres ./scripts/restore-drill.sh backup.dump --with-rls

# How long AVERIS takes to decide: validate → rules → escalate → notify.
node --import tsx scripts/bench-pipeline.mjs

# Fall model: cross-validated, with the operating point in field units.
ml/.venv/bin/python ml/evaluation/validate_fall_model.py

# Device → backend: latency percentiles, packet loss, auth, buffered replay.
# Measures the transport only; the sensor half needs a board and a person.
python3 scripts/hardware-validation/transport_validation.py --url ... --token ...
```

`run_all_tests.sh` reports a suite that could not run as SKIPPED, never as
passed — three of them need something that may be absent (Python, a C++
compiler, a database), and a runner that silently omits them produces a green
summary describing a fraction of the system.

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
├── ai_engine/                Python health intelligence engine
├── iot-service/              FastAPI ingest, websocket hub, escalation
├── sensor_simulator/         speaks the device wire contract
├── ml/                       Python training pipeline + MLflow
├── supabase/
│   ├── migrations/           the source of truth for the schema
│   ├── seed/                 generated: model metrics · knowledge corpus
│   └── tests/                RLS assertions, one file per phase
├── scripts/                  worker · seed generation · model prefetch
├── docs/                     architecture · hardware · ai_pipeline · deployment
├── firmware/averis-wearable/ ESP32 firmware — logic tests run on the host
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
  [docs/hardware.md](docs/hardware.md) and surfaced in the UI rather than hidden behind a
  fudge factor.
- **A band dropped on a table registers as a fall.** An accelerometer cannot distinguish a
  still wrist from a still table; the skin-contact signal that would suppress it is not wired
  into the fall path yet. Asserted in the firmware tests as a known limitation.

## Documentation

| Document | What it answers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Why the system is shaped the way it is |
| [docs/ai_pipeline.md](docs/ai_pipeline.md) | Where models are used, and where they deliberately are not |
| [docs/personalisation.md](docs/personalisation.md) | Personal baselines, deterioration, rural mode, multi-language |
| [docs/hardware.md](docs/hardware.md) | Pin map, wiring, BLE contract, power, accuracy limits |
| [docs/deployment.md](docs/deployment.md) | Runtimes, environment, CI, deploy ordering |
| [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) | Abstract, architecture diagrams, models, results, future scope |
| [SIH_ALIGNMENT.md](SIH_ALIGNMENT.md) | Problem fit, and which problem statements this does *not* address |
| [INNOVATION_REPORT.md](INNOVATION_REPORT.md) | What is different, and §8: what is not novel |
| [FINAL_PROJECT_REVIEW.md](FINAL_PROJECT_REVIEW.md) | Six dimensions graded, two of them weak |
| [VALIDATION_REPORT.md](VALIDATION_REPORT.md) | Methodology, results, and seven known limitations |
| [END_TO_END_TEST_REPORT.md](END_TO_END_TEST_REPORT.md) | Test cases, actual results, and nine issues found |
| [PRESENTATION.md](PRESENTATION.md) | Slide structure, speaker notes, the questions you will be asked |
| [RESUME_DESCRIPTION.md](RESUME_DESCRIPTION.md) | Resume and portfolio text, every claim checkable |
| [HARDWARE_SETUP_GUIDE.md](HARDWARE_SETUP_GUIDE.md) | Power path, build order, and a troubleshooting decision tree |
| [docs/hardware_validation.md](docs/hardware_validation.md) | What is validated, what is not, and the protocol for the rest |
| [docs/cloud_architecture.md](docs/cloud_architecture.md) | Topology, scaling, which services were *not* split out, and the partitioning cutover |
| [docs/disaster_recovery.md](docs/disaster_recovery.md) | Backups, the restore drill, and what is not covered |
| [docs/iot_architecture.md](docs/iot_architecture.md) | The IoT track, phase by phase |
| [docs/iot_runbook.md](docs/iot_runbook.md) | Running it end to end |
| [HARDWARE_INTEGRATION_GUIDE.md](HARDWARE_INTEGRATION_GUIDE.md) | Bringing up a band, step by step |
| [SECURITY_REPORT.md](SECURITY_REPORT.md) | The authorisation model, six defects found by running it, and eight known weaknesses |
| [SECURITY_AUDIT.md](SECURITY_AUDIT.md) | Findings, fixes, and accepted risks |
| [LOGGING_ARCHITECTURE.md](LOGGING_ARCHITECTURE.md) | What is logged, what must never be |
| [PROJECT_COMPLETION_REPORT.md](PROJECT_COMPLETION_REPORT.md) | Built, not built, and what needs hardware |
| [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) | Cloud account to running platform, step by step |
| [FINAL_TEST_REPORT.md](FINAL_TEST_REPORT.md) | What is verified, and what is not |
| [TEST_REPORT.md](TEST_REPORT.md) | Generated by `./run_all_tests.sh` |

## A note on the models

The diabetes model is fitted on the Pima Indians dataset: 768 women of Pima
heritage aged 21 and over. The cardiovascular model uses the Cleveland cohort:
303 cardiac referrals, predominantly male, recording neither BMI nor smoking.

Neither transfers cleanly to an arbitrary patient, and neither supports a claim
about an individual's future. AVERIS presents both as awareness signals with the
cohort and its caveat on the same screen as the number — because a risk
percentage without its provenance is a claim the model cannot support.

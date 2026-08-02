# Meridian — Clinical Intelligence Platform

Meridian turns scattered patient data into actionable clinical intelligence. It is built as a
production-grade healthcare SaaS product: doctors get structured patient profiles, an explainable
risk engine, medication safety checks, emergency triage scoring, AI-drafted documentation and an
evidence-grounded knowledge assistant — with role-based access, audit logging and a deployable
Docker stack.

> **Positioning** — Meridian is clinical *decision support*. Every AI output is labelled with the
> engine that produced it and requires clinician review. Nothing in the product diagnoses or
> prescribes autonomously.

## The problem → solution → impact

- **Problem.** Physicians spend a large share of every shift reconstructing patients from
  fragmented documents, and preventable errors (missed allergies, drug interactions, deteriorating
  trends) hide in that fragmentation.
- **Solution.** Meridian ingests unstructured medical documents, extracts structured intelligence,
  assembles a longitudinal timeline, scores risk with an *explainable-by-construction* engine,
  guards prescriptions against interactions and allergies, and drafts clinical documentation.
- **Impact.** Faster chart review, fewer medication errors, less after-hours paperwork.

## Modules

| # | Module | Where |
|---|--------|-------|
| 1 | Patient Intelligence System (document → structured profile) | `/intelligence`, patient record |
| 2 | Medical Timeline Engine | `/patients/[id]/timeline` |
| 3 | AI Clinical Decision Support (explainable risk scores) | patient record → Risk analysis |
| 4 | Medical Report Analyzer (values, flags, cross-report trends) | `/patients/[id]/reports` |
| 5 | Emergency AI Triage (ESI-style scoring + queue) | `/triage` |
| 6 | Medication Safety Engine (interactions, allergy cross-reactivity, duplication) | patient record → Safety |
| 7 | AI Documentation Assistant (shorthand → SOAP + patient summary) | `/documentation` |
| 8 | Medical Knowledge RAG (cited, corpus-grounded answers) | `/knowledge` |
| 9 | Role-based portals (Doctor / Patient / Admin) | `/dashboard`, `/portal`, `/admin` |

## Architecture in one paragraph

Next.js 15 (App Router, TypeScript, Tailwind v4) serves both the UI (server components) and the
REST API (route handlers). PostgreSQL via Prisma is the system of record; Redis is an optional
cache tier. The AI layer is deliberately two-tiered: **deterministic clinical engines**
(risk scoring, triage, drug interactions — every point traceable to a named factor) run always,
and **Claude (`claude-opus-5`)** adds extraction from unstructured text, narratives, note drafting
and RAG synthesis when an API key is configured. Without a key the platform runs fully in
deterministic mode. Auth is JWT (httpOnly cookies) with role-based access control, and every
authentication, record access and AI invocation lands in an immutable audit log.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/API.md](docs/API.md),
[docs/DESIGN.md](docs/DESIGN.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Quick start (local)

```bash
# 1. Postgres (Docker)
docker run -d --name meridian-pg -e POSTGRES_USER=meridian -e POSTGRES_PASSWORD=meridian \
  -e POSTGRES_DB=meridian -p 5433:5432 postgres:16-alpine

# 2. Environment
cp .env.example .env        # defaults match the container above

# 3. Install, migrate, seed
npm install
npm run db:migrate
npm run db:seed

# 4. Run
npm run dev                  # http://localhost:3000
```

### Demo accounts (password `demo1234`)

| Role | Email |
|------|-------|
| Physician | `dr.reyes@meridian.health` |
| Administrator | `admin@meridian.health` |
| Patient | `eleanor.vance@example.com` |

### Enabling the LLM layer

Set `ANTHROPIC_API_KEY` in `.env`. Extraction, risk narratives, note drafting and knowledge
synthesis switch from deterministic/template mode to `claude-opus-5` automatically — the UI labels
which engine produced each artifact.

## Production (Docker Compose)

```bash
cp .env.example .env         # set AUTH_SECRET (required) and ANTHROPIC_API_KEY
docker compose up --build    # app + postgres + redis; migrations run on boot
docker compose exec app node node_modules/prisma/build/index.js db seed   # optional demo data
```

## Suggested demo walkthrough

1. Sign in as the physician → **Today** shows the live ED queue and high-severity signals.
2. **Document Intelligence** → “Use sample lab report” → extract → structured profile with
   flagged HbA1c.
3. Open **Eleanor Vance** → the medication safety engine has caught an externally-prescribed
   **amoxicillin against her documented penicillin allergy**.
4. Run **Risk analysis** → cardiovascular/metabolic scores decomposed into weighted, evidenced
   factors.
5. **Medical Timeline** → seven years of disease progression at a glance.
6. **Lab Reports** → HbA1c trend 6.8 → 8.5 marked “Needs attention”.
7. **Emergency Triage** → expand the chest-pain case → every point of the score is attributed.
8. **Documentation** → insert sample dictation → structured SOAP note → approve & finalize.
9. **Knowledge** → “Can a patient with penicillin allergy receive amoxicillin?” → cited answer.
10. Sign in as the patient → the same record, translated into plain language.

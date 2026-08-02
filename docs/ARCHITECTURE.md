# Meridian — Architecture

## System overview

```
┌────────────────────────────────────────────────────────────────────┐
│                         Next.js 15 (App Router)                    │
│                                                                    │
│  Server Components (UI)          Route Handlers (REST API)         │
│  /dashboard /patients/[id]       /api/auth/*     /api/triage       │
│  /triage /intelligence           /api/documents/extract            │
│  /documentation /knowledge       /api/risk/assess                  │
│  /admin /portal                  /api/medications/check            │
│                                  /api/notes/*   /api/knowledge/ask │
├──────────────┬─────────────────────────────┬───────────────────────┤
│  Auth layer  │   Clinical engines (lib/)   │      AI layer (lib/ai)│
│  JWT cookie  │   risk.ts     rules-v1      │  client.ts  Anthropic │
│  RBAC guards │   triage.ts   ESI rubric    │  extraction.ts        │
│  audit.ts    │   interactions.ts           │  documentation.ts     │
│              │   rag.ts (BM25 retrieval)   │  (claude-opus-5)      │
├──────────────┴─────────────────────────────┴───────────────────────┤
│                      Prisma ORM  →  PostgreSQL 16                  │
│                      (optional Redis cache tier)                   │
└────────────────────────────────────────────────────────────────────┘
```

## Design principle: deterministic core, LLM enhancement

Healthcare software has to answer *"why did the system say that?"* — so Meridian splits its
intelligence layer into two tiers:

1. **Deterministic clinical engines** (`lib/clinical/*`, `lib/rag.ts` retrieval). Risk scores,
   triage acuity, drug-interaction and allergy checks, and evidence retrieval are computed by
   weighted rule engines. Every output decomposes into named factors with points and cited
   evidence. These run always, are unit-testable, cost nothing per call, and are *explainable by
   construction* — the explanation IS the computation, not a post-hoc rationalization.
2. **LLM layer** (`lib/ai/*`, Anthropic SDK, `claude-opus-5`). Adds what rules cannot do:
   extraction from free-form documents, clinician-facing narratives on top of deterministic
   scores, SOAP-note drafting, and grounded synthesis of retrieved guideline passages. Structured
   outputs (`output_config.format` with JSON Schema) guarantee parseable extraction results;
   `stop_reason: "refusal"` is handled explicitly.

When `ANTHROPIC_API_KEY` is unset, every LLM call site falls back to a deterministic
implementation (regex/dictionary document parser, SOAP templating by cue words, extractive RAG
answers). The UI always labels which engine produced an artifact.

## Data model (Prisma)

- **Identity**: `User` (role: DOCTOR | PATIENT | ADMIN) — a patient user links 1:1 to a `Patient`.
- **Clinical record**: `Patient` → `Condition`, `Allergy`, `Medication`, `TimelineEvent`,
  `LabReport`→`LabValue`, `Document` (raw text + JSON extraction), `ClinicalNote` (SOAP fields,
  DRAFT→FINALIZED), `RiskAssessment` (score, band, factor JSON, engine), `TriageCase`
  (vitals JSON, acuity, rationale JSON).
- **Knowledge**: `GuidelineChunk` (content + keyword index) and `DrugInteraction`
  (curated pair table with mechanism + advice).
- **Compliance**: `AuditLog` — append-only; every login, record access and AI invocation.

## Security

- **Authentication**: bcrypt-hashed passwords; sessions are HS256 JWTs in httpOnly, SameSite=Lax
  cookies with 12 h expiry (`lib/auth.ts`).
- **Authorization**: layout-level guards redirect users out of portals their role cannot see;
  every API route re-validates with `requireRole(...)` server-side — UI checks are never the
  only barrier.
- **Validation**: all request bodies parse through Zod schemas before touching the database.
- **Audit**: `audit()` writes fire-and-forget entries so logging can never break the care path.
- **Transport/PHI posture**: designed to sit behind TLS termination; the seed contains only
  synthetic patients. For production: encrypt Postgres at rest (pgcrypto/KMS volume encryption),
  pin `AUTH_SECRET` from a secrets manager, and add IP allow-listing at the proxy.

## Caching & scale path

- Server components read Prisma directly; hot aggregate queries (admin stats, dashboard counts)
  are cheap at demo scale. `REDIS_URL` is wired in compose for the next step: caching RAG
  retrievals and dashboard aggregates, plus rate-limiting AI endpoints.
- The app is stateless (JWT sessions) — horizontal scaling is adding replicas behind the proxy;
  Postgres is the single source of truth.
- Document uploads are text-first (paste or .txt). The `Document.rawText` column and extraction
  pipeline are storage-agnostic; swapping in S3/GCS presigned uploads + a PDF text-extraction
  worker does not change the schema.

## Module → code map

| Module | Engine | UI |
|---|---|---|
| Patient intelligence | `lib/ai/extraction.ts` | `/intelligence`, patient Notes & Documents |
| Timeline | `TimelineEvent` + grouping | `/patients/[id]/timeline` |
| Decision support | `lib/clinical/risk.ts` | RiskPanel on patient overview |
| Report analyzer | `LabValue` flags + trend builder | `/patients/[id]/reports` |
| Triage | `lib/clinical/triage.ts` | `/triage` |
| Medication safety | `lib/clinical/interactions.ts` | SafetyPanel on patient overview |
| Documentation | `lib/ai/documentation.ts` | `/documentation` |
| Knowledge RAG | `lib/rag.ts` | `/knowledge` |
| RBAC portals | `lib/auth.ts` + route groups | `(clinic)/(admin)/(portal)` |

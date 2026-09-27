# CareBridge — Target Architecture

**Positioning (do not deviate from this in any code, copy, or demo):** CareBridge is an
*"AI-powered pre-consultation and care navigation assistant."* It is **not** a doctor replacement,
**not** a diagnostic system, and **does not guarantee medical decisions.** Every safety-relevant
conclusion is produced by deterministic rules, not by the language model alone.

## 1. Conceptual architecture (product-level)

```
                              Patient
                                 │
                                 ▼
                      Next.js / Frontend (chat UI)
                                 │
                                 ▼
                             API Layer
                                 │
                                 ▼
                     Backend Orchestration
                 ┌───────────────┼────────────────┐
                 ▼               ▼                ▼
         AI / Amazon Bedrock   Deterministic    Session / Data
        (language understanding) Safety Engine     Storage
                 │               │                │
                 └───────────────┴────────────────┘
                                 │
                                 ▼
                  Structured Health Assessment
                                 │
                                 ▼
                    Doctor-ready Summary
```

The key architectural rule, carried over directly from Meridian's `lib/clinical/*` pattern: **the
AI layer and the Safety Engine are separate boxes that both feed the orchestration layer — the AI
never talks directly to the safety-critical decision.** The orchestration layer is the only thing
that combines "what the AI understood" with "what the rules say" into a response.

## 2. Layer responsibilities

| Layer | Responsibility | Must NOT do |
|---|---|---|
| **Frontend (Next.js)** | Render the conversation, show questions, show the structured summary, show urgency guidance. | Must not compute urgency or interpret red flags itself — it only displays what the backend decided. |
| **API Layer** | Auth, request validation (Zod, as Meridian already does), rate limiting, routing to orchestration. | Must not contain clinical logic. |
| **Backend Orchestration** | Drives the interview loop: takes the patient's message + current structured state, calls AI extraction, calls the Safety Engine, decides the next question or the final summary, persists session state. | Must not let the AI's free-text output bypass the Safety Engine before being shown to the patient. |
| **AI / Language Understanding (Bedrock or Anthropic)** | Understand free-text patient input, extract/update structured symptom fields, generate the next natural-language question, phrase the final summary in plain language. | Must never be the sole source of an urgency/red-flag classification. Must always run through a structured-output schema (as `lib/ai/client.ts`'s `completeJson` already enforces) so its output is machine-checkable, not just "trust the prose." |
| **Deterministic Safety Engine** | Pure functions over the structured symptom state → red flags found, urgency level, recommended action. Unit-testable, auditable, versioned. | Must not call the AI. Must not depend on network/session state — same input always gives same output. |
| **Session / Data Storage** | Persist the conversation, the structured state as it evolves, and the final assessment + summary. | — |

## 3. Where this maps onto the existing codebase

| Target layer | Existing Meridian equivalent | Status |
|---|---|---|
| Frontend chat UI | *(none — closest analog is `KnowledgePanel.tsx`'s single-turn Q&A, or `TriageForm.tsx`'s structured intake)* | **New in Phase 2** |
| API Layer | `app/api/**/route.ts` pattern (Zod validation → guard → business logic → audit) | **Reuse the pattern directly** |
| Backend Orchestration | *(none — Meridian's routes call one engine each; nothing currently chains AI → rules → response)* | **New in Phase 3/4** |
| AI / language understanding | `lib/ai/client.ts`, `lib/ai/extraction.ts` | **Reuse the wrapper; new schemas** |
| Deterministic Safety Engine | `lib/clinical/risk.ts`, `lib/clinical/triage.ts` (rule-table → score/band → factors pattern) | **New engine, same architectural pattern** |
| Session/data storage | `lib/db.ts` (Prisma/Postgres) | **Reuse the plumbing; new schema (see Data Flow doc)** |
| Auth | `lib/auth.ts` | **Reuse directly** |

## 4. What stays temporarily vs. what migrates

**Can remain as-is through the hackathon (Phases 1–6):**
- Next.js App Router + TypeScript + Tailwind on the frontend.
- Prisma + local/managed PostgreSQL for session and assessment storage.
- JWT httpOnly-cookie auth (`lib/auth.ts`).
- Anthropic Claude directly via the SDK (`lib/ai/client.ts`) for the AI layer, exactly as Meridian
  already does — no need to touch AWS at all to build and demo the product.
- Docker Compose for local/deployment convenience.

**Planned migration to AWS (Phase 7, "AWS Integration + Polish"), only if time and the hackathon's
judging criteria reward it:**

| Current | AWS target | Why only then |
|---|---|---|
| Anthropic SDK direct calls | **Amazon Bedrock** (hosting Claude or another foundation model) | Swapping the model provider behind `lib/ai/client.ts`'s existing abstraction is a contained, late-stage change — the rest of the app is provider-agnostic already. |
| Next.js API routes running as one server process | **AWS Lambda** behind **API Gateway** | Only worth doing once the workflow is stable; premature serverless-ification would slow down iteration during Phases 2–6. |
| PostgreSQL (Prisma) | **DynamoDB** for session/assessment data | A session's structured state (see Data Flow doc) is a good fit for a document store, but Postgres is faster to iterate with locally and the team already knows Prisma from Meridian. |
| Local file storage (as Meridian's `uploads/` dir does today) | **S3** for any generated report/document | Only needed if the "downloadable report" nice-to-have is built. |
| `console`/no monitoring | **CloudWatch** | Add once there's a deployed environment worth monitoring; not needed for local demo-driven development. |

**Important constraint:** Don't force every AWS service into the system just because it's listed
above. If the hackathon demo runs entirely on a local/managed Postgres + direct Anthropic API and
that's what gets built and works, that is a legitimate, complete architecture — AWS migration is an
enhancement path, not a requirement for CareBridge to be "done."

## 5. Multilingual support (future enhancement, not MVP)

English/Hindi/Kannada support (if built) belongs entirely inside the **AI / language
understanding** layer — the patient's message is translated/understood in their language, but the
**structured symptom state and the Safety Engine's rules stay in one canonical internal
representation** (e.g. English field names, standardized symptom keys), so the deterministic rules
never need per-language logic. Only the final patient-facing text (questions, summary, urgency
guidance) needs localization.

## 6. Non-negotiable safety architecture rule

Repeating this because it is the single most important constraint on every phase from here on:

> The LLM may **understand** input and **phrase** output. It may never be the only thing standing
> between a red-flag symptom and the patient. The Safety Engine's red-flag check must run on every
> turn, on the structured (not free-text) state, and must be able to override or annotate whatever
> the AI generated before it reaches the patient.

This is not a new invention — it is the exact same separation Meridian already implements between
`lib/clinical/risk.ts`/`lib/clinical/triage.ts` (the deterministic score) and the optional AI
narrative layered on top in `assessRisks()`. CareBridge's Safety Engine should be built the same
way.

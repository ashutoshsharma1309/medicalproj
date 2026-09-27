# CareBridge — Codebase Map (of the existing Meridian app)

This document explains, in plain language, what already exists in this repository before we
start building CareBridge. It is a map, not a judgment — the "keep / modify / remove" decisions
live in [`MERIDIAN_TO_CAREBRIDGE.md`](./MERIDIAN_TO_CAREBRIDGE.md).

> **One repo, two unrelated projects.** This git repository contains **two separate products**:
> 1. **Meridian** (the root of the repo: `app/`, `lib/`, `components/`, `prisma/`) — a doctor-facing
>    clinical intelligence platform. **This is the codebase we are pivoting into CareBridge.**
> 2. **`averis/`** — a completely different, self-contained project (an IoT elderly-care wearable
>    + digital-twin platform, its own Next.js app, its own Supabase/Postgres schema, its own
>    Python services and ESP32 firmware). It has its own `package.json`, `tsconfig.json`, `README.md`
>    and `node_modules` requirements. **It is not part of Meridian, shares no code with it, and is
>    out of scope for CareBridge.** Do not edit files under `averis/` while doing CareBridge work,
>    and do not confuse its docs (e.g. `averis/ARCHITECTURE.md`) with Meridian's
>    (`docs/ARCHITECTURE.md`). The rest of this document only covers the root project.

---

## A. Project overview

**Meridian** is a "clinical intelligence" web app for a hospital/clinic. It has three portals for
three kinds of users:

- **Doctor portal** (`/dashboard`, `/patients`, `/triage`, `/intelligence`, `/documentation`,
  `/knowledge`) — a clinician manages patient charts, runs AI-assisted document extraction, scores
  ED triage, checks medication safety, drafts SOAP notes, and asks a guideline knowledge base
  questions.
- **Admin portal** (`/admin`, `/admin/users`, `/admin/audit`) — user directory and compliance
  audit log for a hospital administrator.
- **Patient portal** (`/portal`, `/portal/setup`, `/portal/documents`) — a patient completes a
  medical-intake form, uploads their own documents (lab reports, prescriptions), and views a
  simplified, plain-language version of their own chart.

It's built with **Next.js 15** (App Router, server components + API route handlers in one
codebase), **TypeScript**, **Tailwind v4**, **PostgreSQL** via **Prisma**, and an optional
**Anthropic Claude** integration for the AI layer. Every AI-produced result is deterministic-first:
rule engines compute the actual numbers (risk score, triage acuity, drug interactions); the LLM,
when configured, only adds narrative explanation on top. Without an API key, the whole app still
works in "deterministic mode."

This existing codebase is a strong foundation for CareBridge because it already has: working auth
with roles, a Prisma/Postgres data model for patients/conditions/medications/allergies, a
deterministic-first AI pattern (exactly what CareBridge's safety requirement calls for), a document
upload + AI extraction pipeline, and a patient-facing intake form — all of which map closely onto
CareBridge's "patient describes symptoms → AI extracts structured info → safety rules → summary"
workflow.

## B. Repository structure

```
healthcare/                       (repo root — this IS the Meridian app)
├── app/                          Next.js App Router — pages + API routes
│   ├── (admin)/                  admin portal route group
│   ├── (clinic)/                 doctor portal route group
│   ├── (portal)/                 patient portal route group
│   ├── api/                      REST API route handlers
│   ├── login/, signup/           public auth pages
│   ├── layout.tsx, page.tsx      root shell + "/" redirect router
│   └── globals.css               design system (colors, fonts, utility classes)
├── components/
│   ├── shell/                    sidebar layout, nav links, icons, logout button
│   └── ui.tsx                    shared UI primitives (cards, chips, stats, charts)
├── lib/                          all business logic — not tied to any one page
│   ├── ai/                       Anthropic client + AI-powered feature modules
│   ├── clinical/                 deterministic clinical rule engines
│   ├── auth.ts                   sessions, login, role guards
│   ├── patient.ts                patient-portal guard + MRN generator
│   ├── audit.ts                  audit-log writer
│   ├── db.ts                     Prisma client singleton
│   ├── format.ts                 date/age formatting helpers
│   └── rag.ts                    knowledge-base retrieval + Q&A
├── prisma/
│   ├── schema.prisma             the entire data model (source of truth)
│   ├── migrations/                SQL migration history
│   └── seed.ts                   demo data (3 users, patients, drug table, guidelines)
├── docs/                         Meridian's own docs (ARCHITECTURE, API, DESIGN, DEPLOYMENT)
│                                  + this Phase 1 CareBridge documentation set
├── docker-compose.yml, Dockerfile, docker-entrypoint.sh   container deployment
├── package.json                  scripts: dev, build, start, db:migrate/seed/generate
├── next.config.ts, tsconfig.json, postcss.config.mjs      framework config
└── averis/                       ⚠️ SEPARATE, UNRELATED PROJECT — see note above, ignore for CareBridge
```

## C. Frontend structure

Next.js "route groups" (folders in parentheses) split the app into three portals that share one
layout shell but show different navigation per role. Each group has a `layout.tsx` that
(1) redirects a signed-out visitor to `/login`, (2) redirects a signed-in user whose role doesn't
match that portal to their own portal, and (3) wraps the page in `<AppShell>` (the sidebar).

**Root & auth**
- `app/layout.tsx` → The outermost HTML page. Loads the app's fonts (IBM Plex Sans/Mono, Source
  Serif) and sets the page title. No navigation or auth logic lives here.
- `app/page.tsx` → The `/` route. Doesn't render a page — it just checks who's logged in and
  redirects to `/login`, `/dashboard`, `/admin`, or `/portal` accordingly.
- `app/globals.css` → The entire visual design system in one file: colors (paper background,
  surgical-green primary, red/amber/green/blue for clinical severity), and hand-written CSS classes
  like `.card`, `.btn-primary`, `.field`, `.chip-critical`, `.timeline-spine` used everywhere. There
  is no component-scoped CSS — this file is the single source of styling.
- `app/login/page.tsx` + `LoginForm.tsx` → Sign-in screen. `LoginForm.tsx` is a client component
  that posts credentials to `/api/auth/login` and includes one-click demo-account buttons
  (physician/admin/patient) for fast testing.
- `app/signup/page.tsx` + `SignupForm.tsx` → Patient self-registration screen with a live
  password-strength meter; posts to `/api/auth/signup`.

**(admin) — hospital administrator portal**
- `app/(admin)/layout.tsx` → Access guard + sidebar wrapper for everything under `/admin`.
- `app/(admin)/admin/page.tsx` → Overview dashboard: counts of users/patients/notes, an "AI engine
  utilization" bar chart, and a feed of recent audit-log entries.
- `app/(admin)/admin/users/page.tsx` → Read-only table of every registered user and their activity.
- `app/(admin)/admin/audit/page.tsx` → Raw audit-log table (last 200 events) for compliance review.

**(clinic) — doctor portal**
- `app/(clinic)/layout.tsx` → Access guard + sidebar for everything a doctor uses.
- `app/(clinic)/dashboard/page.tsx` → The doctor's homepage: stat tiles (patients on service, ED
  queue size, critical cases, draft notes), a triage-queue preview, and recently processed
  documents.
- `app/(clinic)/patients/page.tsx` → Searchable patient registry table.
- `app/(clinic)/patients/[id]/layout.tsx` → Shared "chart header" for one patient (name, MRN, DOB,
  vitals, a red allergy banner) plus the `PatientTabs` sub-navigation.
- `app/(clinic)/patients/[id]/PatientTabs.tsx` → Tab strip: Intelligence Profile / Timeline / Lab
  Reports / Notes & Documents.
- `app/(clinic)/patients/[id]/page.tsx` → The "Intelligence Profile" tab: problem list,
  medications, and the two interactive AI panels below.
- `app/(clinic)/patients/[id]/RiskPanel.tsx` → Client component; "Run risk analysis" button calls
  `POST /api/risk/assess` and renders the cardiovascular/metabolic risk scores with an
  explainability breakdown (which factors contributed how much).
- `app/(clinic)/patients/[id]/SafetyPanel.tsx` → Shows current medication-safety alerts and lets
  the doctor test a proposed new drug against the patient's regimen via `POST /api/medications/check`.
- `app/(clinic)/patients/[id]/notes/page.tsx` → Clinical notes (SOAP) and uploaded documents with
  their AI extractions.
- `app/(clinic)/patients/[id]/reports/page.tsx` → Lab report history with per-analyte trend lines.
- `app/(clinic)/patients/[id]/timeline/page.tsx` → Vertical, year-grouped medical history timeline.
- `app/(clinic)/triage/page.tsx`, `TriageBoard.tsx`, `TriageForm.tsx` → The Emergency Department
  triage queue: a form to register a new arrival's vitals/symptoms (scored by
  `POST /api/triage`) and a board of waiting patients ranked by acuity with a full "why this score"
  breakdown per case. **This is the closest existing analog to CareBridge's symptom-intake form.**
- `app/(clinic)/intelligence/page.tsx` + `ExtractPanel.tsx` → Paste or upload a document (or use a
  sample) → `POST /api/documents/extract` → structured result (conditions, symptoms, allergies,
  medications, lab values, key findings) shown as cards. **This is the closest existing analog to
  CareBridge's "unstructured text → structured symptom data" step.**
- `app/(clinic)/documentation/page.tsx` + `NoteComposer.tsx` → Doctor types shorthand notes →
  `POST /api/notes/generate` turns them into a structured SOAP note → doctor edits and finalizes.
  **This is the closest existing analog to CareBridge's doctor-ready pre-consultation summary.**
- `app/(clinic)/knowledge/page.tsx` + `KnowledgePanel.tsx` → Single-question Q&A box over a curated
  guideline corpus, with cited passages. Not a multi-turn chat (no message history) — closest
  existing analog to a chat UI, but CareBridge's multi-turn interview still needs to be built new.

**(portal) — patient portal**
- `app/(portal)/layout.tsx` → Access guard + sidebar for the patient-facing pages.
- `app/(portal)/portal/page.tsx` → The patient's home page: their own info, documents, conditions,
  medications, labs and timeline, in plain language. Redirects to `/portal/setup` if onboarding
  isn't done yet.
- `app/(portal)/portal/setup/page.tsx` + `ProfileForm.tsx` → **The patient's self-service medical
  intake form** — name, DOB, gender, phone, blood group, and comma-list fields (with live chip
  preview) for existing conditions/allergies/medications, plus emergency contact. Submits to
  `PUT /api/portal/profile`. **This is the best existing structural model for a CareBridge symptom
  intake step** — it already collects patient-entered structured health data.
- `app/(portal)/portal/documents/page.tsx` + `UploadPanel.tsx` → Drag-and-drop upload of a
  PDF/JPG/PNG/TXT document; posts to `POST /api/portal/documents`, which runs AI (or deterministic)
  extraction synchronously.
- `app/(portal)/portal/documents/[id]/page.tsx` + `ReviewActions.tsx` → Shows the AI's extraction
  from an uploaded document and lets the patient **confirm** it before anything is written into
  their profile (`POST /api/portal/documents/[id]/confirm`) — nothing is auto-applied.

**Shared components**
- `components/shell/AppShell.tsx` → The persistent sidebar layout (logo, role-based nav menu, user
  footer, logout) used by all three portals.
- `components/shell/NavLink.tsx`, `LogoutButton.tsx`, `icons.tsx` → Small supporting pieces of the
  sidebar (active-link highlighting, logout POST, hand-drawn SVG icon set).
- `components/ui.tsx` → The reusable building blocks nearly every page uses: `SectionCard` (bordered
  card container), `Chip`/`SeverityChip` (colored pill), `Stat` (KPI tile), `EmptyState`,
  `FactorBars` (the "why" explainability bar chart), and `Sparkline` (hand-rolled trend line SVG).

## D. Backend/API structure

All APIs are Next.js **route handlers** under `app/api/**/route.ts`. Every one follows the same
shape: parse the JSON body with a **Zod** schema → check the caller's role with `requireRole(...)`
(or `requirePatient()` for portal routes) → do the work (usually via a `lib/` module) → write an
**audit log entry** → return JSON. Errors return `{ "error": "message" }` with a matching HTTP
status (400/401/403/404/500). Full request/response shapes are documented in
[`docs/API.md`](./API.md).

| Route | Role | What it does |
|---|---|---|
| `POST /api/auth/login` | public | Verify credentials, create a JWT session cookie, return where to redirect. |
| `POST /api/auth/signup` | public | Create a new PATIENT user + session. |
| `POST /api/auth/logout` | any | Destroy the session cookie. |
| `POST /api/documents/extract` | DOCTOR, ADMIN | Extract structured data from pasted document text (clinician-side). |
| `POST /api/risk/assess` | DOCTOR, ADMIN | Run the deterministic risk engine (+ optional AI narrative), persist a `RiskAssessment`. |
| `POST /api/triage` | DOCTOR, ADMIN | Score a new ED arrival and create a `TriageCase`. |
| `PATCH /api/triage/:id` | DOCTOR, ADMIN | Update a triage case's status (waiting/in-treatment/discharged). |
| `POST /api/medications/check` | DOCTOR, ADMIN | Run the medication-safety engine, optionally against a proposed new drug. |
| `POST /api/notes/generate` | DOCTOR | Turn shorthand notes into a structured SOAP note via AI or template. |
| `PATCH /api/notes/:id` | DOCTOR | Edit or finalize a clinical note. |
| `POST /api/knowledge/ask` | DOCTOR, ADMIN | Ask the guideline knowledge base a question (BM25 retrieval + optional AI synthesis). |
| `GET/PUT /api/portal/profile` | PATIENT | Fetch or save the patient's own medical-intake profile. |
| `POST /api/portal/documents` | PATIENT | Upload a document; extraction runs synchronously; result stored with a status. |
| `GET /api/portal/documents/:id/file` | PATIENT | Ownership-checked download of an uploaded file. |
| `POST /api/portal/documents/:id/confirm` | PATIENT | Merge a reviewed AI extraction into the patient's profile (additive, never overwrites). |

## E. Database structure

Everything is defined in one file: [`prisma/schema.prisma`](../prisma/schema.prisma), using
PostgreSQL via Prisma. Key models:

- **`User`** — login identity (email, password hash, `role`: DOCTOR/PATIENT/ADMIN).
- **`Patient`** — the clinical record: demographics, blood type, height/weight/smoker, optional
  1:1 link to a `User` (for the patient's own login), plus onboarding fields
  (`emergencyContactName`, `surgeries`, `profileCompleted`).
- **`Condition`**, **`Allergy`**, **`Medication`** — the patient's structured problem list,
  allergy list, and medication list.
- **`TimelineEvent`** — one row per notable clinical event, used to build the timeline UI.
- **`LabReport`** → **`LabValue`** — a report (e.g. "CBC panel") containing individual analyte
  values with reference ranges and H/L flags.
- **`Document`** — an uploaded or pasted document: raw text, the AI's structured `extraction`
  (JSON), which engine produced it, and (for patient uploads) file metadata, confidence score, and
  an `extractionStatus` lifecycle (`PROCESSING → EXTRACTED → CONFIRMED`, or `UNAVAILABLE`/`FAILED`).
- **`RiskAssessment`** — one row per risk-engine run: domain, 0–100 score, severity band, the
  factor breakdown (JSON), and which engine computed it.
- **`TriageCase`** — one ED visit: symptoms/vitals (JSON), acuity (1–5), computed score, and the
  rationale (JSON) behind the score.
- **`ClinicalNote`** — a SOAP note (subjective/objective/assessment/plan), draft or finalized.
- **`GuidelineChunk`** — the knowledge-base corpus used by the RAG Q&A feature.
- **`DrugInteraction`** — a curated table of drug-pair interactions (severity, mechanism, advice).
- **`AuditLog`** — append-only record of every login, record access, and AI invocation.

This schema is **doctor/hospital-shaped** (MRNs, ED triage, SOAP notes, admin audit) rather than
**patient-symptom-shaped**. CareBridge needs a different core object — something like a
"HealthInterviewSession" holding a conversation and an evolving structured symptom state — which
does not exist yet. See [`CAREBRIDGE_DATA_FLOW.md`](./CAREBRIDGE_DATA_FLOW.md).

## F. Authentication flow

Implemented in `lib/auth.ts`:

1. Passwords are hashed with **bcrypt** (`hashPassword`, `verifyCredentials`).
2. On successful login, `createSession()` signs an **HS256 JWT** (via the `jose` library)
   containing `{ sub, email, name, role, title }` and sets it as an **httpOnly, SameSite=Lax**
   cookie named `meridian_session` (12h expiry, or 30 days with "remember me").
3. `getSession()` reads and verifies that cookie on every request that needs to know who's logged
   in; server components call it directly, API routes call the wrapper `requireRole(...roles)`,
   which returns either `{ user }` or a ready-made 401/403 `NextResponse`.
4. `lib/patient.ts`'s `requirePatient()` is a specialized guard for the patient portal — it also
   loads (or confirms the absence of) the caller's own `Patient` record, so a patient can only ever
   touch their own data.
5. Every route-group `layout.tsx` (`(admin)`, `(clinic)`, `(portal)`) re-checks the role at the UI
   level too, but the **API routes are the real enforcement point** — the UI check is just a
   redirect for a better experience, never the only barrier.
6. `AUTH_SECRET` (an env var) signs the JWT; rotating it invalidates every session.

This whole layer is generic — it has nothing hospital-specific baked into it — so it's directly
reusable for CareBridge's patient login, with the DOCTOR/ADMIN portals and roles simplified away
(see the Meridian→CareBridge mapping doc).

## G. AI/LLM flow

Implemented in `lib/ai/*`, using the **Anthropic SDK** directly (`lib/ai/client.ts`):

- `aiAvailable()` returns `true` only if `ANTHROPIC_API_KEY` is set. **Every AI-powered feature in
  this codebase checks this first and has a deterministic fallback** — this "LLM optional, rules
  always" pattern is exactly the safety posture CareBridge's design calls for, and it's the single
  most valuable thing to carry over conceptually.
- `complete()` / `completeJson()` wrap `anthropic.messages.create(...)`. `completeJson` passes a
  JSON Schema via `output_config.format` so the model's reply is guaranteed-parseable structured
  data — this is the mechanism CareBridge's "structured health information extraction" module
  should reuse.
- Both helpers check `response.stop_reason === "refusal"` and throw a typed `AiRefusalError` —
  i.e., the codebase already has a pattern for handling the model declining a request.
- `CLINICAL_SYSTEM` is a shared system prompt establishing tone/rules ("never invent values",
  "decision support, not a diagnosis") — the right template to adapt for a CareBridge system
  prompt, with wording changed from "physician" to "patient".
- `lib/ai/extraction.ts` (`extractDocument`) — turns a document's raw text into structured clinical
  data (conditions, symptoms, allergies, medications, lab values, risk factors, summary) via a
  strict JSON Schema; falls back to a regex/dictionary `deterministicExtract()` parser when no API
  key is set.
- `lib/ai/patientExtraction.ts` (`extractFromFile` / `extractFromText`) — the patient-upload
  variant: adds age/gender/blood group/doctors/important dates and a 0–1 **confidence score**, and
  supports binary files (PDF/JPG/PNG) via Claude's native document/vision input, not just plain
  text.
- `lib/ai/documentation.ts` (`generateNote`) — turns a doctor's shorthand into a structured SOAP
  note (or a cue-word-based template if no API key).

There is **no conversational (multi-turn) chat implementation anywhere in this codebase** — every
AI call site is single-shot request → structured response. Building the actual multi-turn "AI
Health Interview" (ask a question, get an answer, ask a follow-up) is new work for Phase 4, though
the extraction schema pattern, the deterministic-fallback pattern, and the refusal handling all
transfer directly.

## H. Clinical/risk/safety logic

This is the most important section for CareBridge, because it's the existing proof that
**deterministic rule engines, not the LLM, own safety-relevant conclusions** — precisely the
architecture the CareBridge brief requires.

- **`lib/clinical/risk.ts`** — `cardiovascularRisk()` / `metabolicRisk()`: each is a **weighted rule
  table** (age, diagnoses, lab values, smoking, BMI → points), summed into a 0–100 score and a
  CRITICAL/HIGH/MEDIUM/LOW band, with every point traceable to a named factor + a plain-language
  evidence string (`RiskFactor`). `assessRisks()` runs both engines and, only if AI is configured,
  asks the LLM to *phrase* (never recompute) a narrative on top of the number. **This is the
  reference pattern for CareBridge's Safety/Red-Flag Engine**: compute the classification with
  code, let the LLM only narrate it afterward.
- **`lib/clinical/triage.ts`** — `scoreTriage()`: an ESI-inspired rubric over vitals + a fixed table
  of `RED_FLAG_SYMPTOMS` (e.g. "chest pain" → 18 points, "stroke symptoms" → 24 points) + age/history
  modifiers, producing a score, a 1–5 acuity, a priority band, a line-by-line rationale, and a
  disposition sentence. **This is the closest existing analog to CareBridge's red-flag detection**
  — the `RED_FLAG_SYMPTOMS` table is a near-literal precedent for a future
  `symptom → escalate-to-urgent-care` rule table, just needs reframing from "ED nurse triage" to
  "patient self-triage guidance."
- **`lib/clinical/interactions.ts`** — `checkMedicationSafety()`: three deterministic checks (drug↔drug
  interaction against a curated table, drug↔allergy conflict including cross-reactivity classes,
  and therapeutic duplication). Not directly needed for CareBridge's MVP (no active-medication
  cross-check in the brief) but the "curated table + pure function, no LLM" shape is a good model
  for any future rule addition.
- **`lib/rag.ts`** — `retrieve()` (BM25-style lexical scoring, no LLM, no vector DB) +
  `answerClinicalQuestion()` (LLM synthesizes an answer **only** from retrieved passages, with an
  extractive fallback). Not required for CareBridge's MVP (explicitly listed as "complex RAG —
  don't build unless time remains"), but useful later if CareBridge adds a cited-guidance feature.

None of these engines depend on Next.js or the UI — they're plain TypeScript functions taking
plain data and returning plain data, which is exactly the shape CareBridge's own Safety/Red-Flag
Engine should take (a pure function `evaluateRedFlags(structuredSymptoms) → { urgency, reasons }`,
callable from an API route and unit-testable in isolation).

## I. Important reusable components

Ranked by how directly they transfer to CareBridge:

1. **`lib/auth.ts` + `lib/patient.ts`** — session/JWT/role-guard system. Reuse almost as-is; drop
   the DOCTOR/ADMIN roles.
2. **`lib/ai/client.ts`** — the Anthropic wrapper, `aiAvailable()` fallback pattern, and refusal
   handling. Reuse the pattern; point `MODEL`/system prompt at CareBridge's needs.
3. **The deterministic-rule-table shape** in `lib/clinical/risk.ts` and `lib/clinical/triage.ts`
   (`RED_FLAG_SYMPTOMS`-style tables, `Rule[]` → score → band). This is the template for the Safety
   Engine.
4. **`lib/audit.ts`** — fire-and-forget audit logging. Directly reusable for any compliance/
   traceability need in CareBridge.
5. **`components/ui.tsx`** (`SectionCard`, `Chip`, `Stat`, `EmptyState`, `FactorBars`, `Sparkline`)
   and `components/shell/AppShell.tsx` — domain-agnostic UI primitives and the sidebar shell. Reuse
   directly for a leaner, patient-only CareBridge UI.
6. **`app/globals.css`** design tokens (`.card`, `.btn`, `.field`, `.chip`) — ready-made coherent
   visual language, reusable wholesale.
7. **`app/(portal)/portal/setup/ProfileForm.tsx`** and **`app/(clinic)/triage/TriageForm.tsx`** —
   the best existing structural models for a step-by-step or chat-driven symptom-intake flow
   (chief-complaint text, symptom toggle grid, free-text lists parsed into chips).
8. **`app/(clinic)/intelligence/ExtractPanel.tsx`** pattern (paste/upload → structured card output)
   — model for showing AI Health Interview results.
9. **`lib/db.ts`** (Prisma singleton) and the overall Prisma+Postgres setup — reuse the plumbing;
   the schema itself needs new CareBridge-specific models (see the data-flow doc).

## J. Important files and what each does

(This consolidates the most load-bearing files across the whole codebase into one lookup table.)

| File | What it does |
|---|---|
| `prisma/schema.prisma` | The entire data model — the single source of truth for what data the app can store. |
| `lib/auth.ts` | Login, session cookies (JWT), and role-based access guards used by every protected page/API. |
| `lib/patient.ts` | Patient-only access guard + medical record number (MRN) generator. |
| `lib/audit.ts` | Writes an entry to the compliance audit log every time something sensitive happens. |
| `lib/ai/client.ts` | The one place that talks to Claude; defines the shared system prompt and the "no API key → deterministic mode" switch every AI feature depends on. |
| `lib/ai/extraction.ts` | Turns a medical document's text into structured data (conditions, meds, labs, etc.), with a rule-based fallback. |
| `lib/ai/patientExtraction.ts` | Same idea as above but for patient-uploaded files (PDF/image), with a confidence score. |
| `lib/ai/documentation.ts` | Turns a doctor's shorthand notes into a structured SOAP note. |
| `lib/clinical/risk.ts` | The deterministic cardiovascular/metabolic risk-scoring engine — the reference pattern for a Safety Engine. |
| `lib/clinical/triage.ts` | The deterministic ED triage/red-flag scoring engine — the closest existing precedent for symptom-based urgency detection. |
| `lib/clinical/interactions.ts` | Deterministic medication-safety checks (interactions, allergies, duplication). |
| `lib/rag.ts` | Lexical retrieval + optional AI synthesis over a guideline knowledge base. |
| `app/api/**/route.ts` | The REST API surface — one file per endpoint, each auth-guarded and audited. |
| `components/shell/AppShell.tsx` | The sidebar layout wrapping every page in every portal. |
| `components/ui.tsx` | Shared visual building blocks (cards, chips, stat tiles, explainability bars, sparklines). |
| `app/globals.css` | The entire visual design system (colors, fonts, reusable CSS classes). |
| `app/(portal)/portal/setup/ProfileForm.tsx` | The existing patient self-service health-intake form — closest thing to a CareBridge intake step today. |
| `prisma/seed.ts` | Populates demo users/patients/drug-interactions/guidelines so the app is usable immediately after setup. |
| `docker-compose.yml`, `Dockerfile` | Containerized deployment (Postgres + Redis + the app). |
| `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/DESIGN.md`, `docs/DEPLOYMENT.md` | Meridian's own existing documentation (kept for reference; not CareBridge docs). |

# Meridian → CareBridge Feature Map

This table classifies every meaningful piece of the existing Meridian codebase (root project only —
`averis/` is a separate, unrelated project and is not covered here) into **KEEP**, **MODIFY**, or
**REMOVE / DISABLE** for the CareBridge pivot.

Nothing listed as REMOVE has been deleted yet. Per the Phase 1 rules, only clearly dead code or
trivially safe cleanup would be removed at this stage, and no such dead code was found — everything
below is a *plan* for Phase 2 onward.

| Current Meridian Feature | Keep / Modify / Remove | CareBridge Purpose | Reason |
|---|---|---|---|
| **Auth: JWT session cookies** (`lib/auth.ts`) | **KEEP** | Patient login/session for CareBridge | Generic, role-agnostic session mechanism; solid and already working. |
| **Auth: DOCTOR / ADMIN roles & guards** | **MODIFY** | Simplify to PATIENT-only for MVP; DOCTOR role becomes "read-only summary viewer" in Phase 6 | CareBridge's target users are patients; a doctor identity is only needed later for the hand-off view. |
| **Signup / Login pages + forms** (`app/login/*`, `app/signup/*`) | **KEEP** (restyle only) | Patient entry point into CareBridge | Working, tested flow; only copy/branding changes. |
| **`Patient` model** (demographics, blood type, height/weight/smoker) | **KEEP** | Base patient profile CareBridge can attach a health interview to | Directly matches "who is this patient" needs. |
| **`Patient` onboarding fields** (`emergencyContactName`, `surgeries`, `profileCompleted`) | **KEEP** | Useful context fields for a pre-consultation summary | Already patient-authored, additive-only pattern — same posture CareBridge needs. |
| **`(portal)/portal/setup/ProfileForm.tsx`** — patient self-service intake form | **MODIFY** | Structural template for a CareBridge symptom-intake step (or a "known history" pre-fill before the AI interview starts) | Already collects patient-entered structured health data (conditions/allergies/meds as chips) via the additive-merge pattern CareBridge should reuse. |
| **`Condition` / `Allergy` / `Medication` models** | **KEEP** | Known-history context fed into the AI interview and the safety engine | Same shape needed for "does the patient have relevant history" checks. |
| **Document upload + AI extraction** (`app/(portal)/portal/documents/*`, `lib/ai/patientExtraction.ts`, `app/api/portal/documents/*`) | **MODIFY** | Optional "attach a report/photo" enhancement to the AI Health Interview (nice-to-have, not MVP) | The extraction-then-patient-confirms pattern is exactly right, but full document upload is beyond CareBridge's MVP scope; keep the code as a later enhancement path. |
| **`lib/ai/client.ts`** (Anthropic wrapper, `aiAvailable()`, structured JSON output, refusal handling) | **KEEP** | Core AI plumbing for the whole CareBridge AI layer | Reusable almost unchanged — model, system prompt and schemas will differ, the wrapper won't. |
| **`lib/ai/extraction.ts`** (document → structured clinical data) | **MODIFY** | Template for CareBridge's "patient message → structured symptom state" extractor | Same JSON-Schema-constrained-completion technique, applied to a chat turn instead of a document. |
| **`lib/ai/documentation.ts`** (shorthand → SOAP note) | **MODIFY** | Template for CareBridge's doctor-ready pre-consultation summary generator | Same "structured input → structured clinical writeup" shape; audience changes from doctor-dictation to interview-transcript. |
| **`lib/clinical/risk.ts`** (weighted rule engine, factor breakdown, band) | **MODIFY** (as a pattern) | Template for the Safety / Red-Flag Engine's scoring shape | Not the same rules, but the exact "deterministic rule table → score → explainable factors" architecture CareBridge's non-negotiable safety requirement calls for. |
| **`lib/clinical/triage.ts`** (`RED_FLAG_SYMPTOMS` table, ESI-style acuity) | **MODIFY** | Direct precedent/starting point for CareBridge's red-flag symptom table (e.g. "chest pain", "stroke symptoms", "difficulty breathing" → escalate) | Reframe from "ED nurse triage disposition" to "patient self-triage: see a doctor now / soon / routine" language and thresholds. |
| **`lib/clinical/interactions.ts`** (drug interactions/allergy/duplication) | **REMOVE for MVP** (keep file, don't wire up) | Not part of CareBridge's core workflow | CareBridge doesn't manage active prescriptions; revisit only if a future phase adds medication review. |
| **`lib/rag.ts`** (BM25 + guideline corpus Q&A) | **REMOVE for MVP** (keep as reference) | Not part of CareBridge's MVP | Explicitly listed as "don't build unless time remains" (complex RAG) in the product brief; the deterministic-retrieval pattern is a fine reference if a cited-guidance feature is added post-hackathon. |
| **`GuidelineChunk` / `DrugInteraction` models + seed data** | **REMOVE for MVP** (leave in schema, unused) | — | Support the two removed features above; no CareBridge workflow reads them yet. |
| **Emergency Triage board & form** (`app/(clinic)/triage/*`, `TriageCase` model, triage APIs) | **REMOVE** | — | This is ED-staff-facing queue management, the opposite of a patient self-service tool; CareBridge has no "ED queue" concept. The vitals-input and symptom-toggle UI patterns are salvageable for the intake screen, but the feature itself does not carry over. |
| **Clinical documentation / SOAP notes** (`app/(clinic)/documentation/*`, `NoteComposer.tsx`, `ClinicalNote` model) | **MODIFY** | Becomes the doctor-facing pre-consultation summary (Phase 6) | Same underlying idea (structure a clinical narrative) but the input is a patient interview, not a doctor's dictation, and there's no "sign & finalize" clinician workflow at MVP. |
| **Knowledge / RAG Q&A page** (`app/(clinic)/knowledge/*`) | **REMOVE** | — | Clinician-facing, citation-heavy, guideline-corpus feature; out of MVP scope per the product brief. |
| **Doctor dashboard** (`app/(clinic)/dashboard/*`) | **REMOVE** | — | Assumes a doctor managing many patients on service; CareBridge's doctor-facing surface (Phase 6) is a single pre-consultation summary view, not a full dashboard. |
| **Patient registry & full patient chart** (`app/(clinic)/patients/*`, `RiskPanel.tsx`, `SafetyPanel.tsx`, timeline/reports tabs) | **REMOVE** | — | This is the full hospital EHR chart view; CareBridge is explicitly *not* a hospital management system. The `RiskPanel`'s "factor breakdown" UI pattern is worth reusing visually for showing red-flag reasoning to the patient, but the page itself goes. |
| **Admin portal** (`app/(admin)/*`: overview, users, audit log viewer) | **REMOVE** | — | Hospital-administrator tooling with no role in a patient-facing pre-consultation tool. `lib/audit.ts` itself (the logger) is kept; only the admin UI that displays it is removed. |
| **`RiskAssessment` / `TriageCase` / `ClinicalNote` models** | **REMOVE for MVP** (or replace with CareBridge-specific models) | — | Shaped around hospital workflows (ED acuity, SOAP sign-off) that don't match CareBridge's session/summary model; new models are defined in `CAREBRIDGE_DATA_FLOW.md`. |
| **`lib/audit.ts`** (audit log writer) | **KEEP** | Traceability for AI calls and safety-engine decisions | Generic and valuable for any healthcare-adjacent product; keep logging AI extraction/safety-engine invocations. |
| **`components/ui.tsx`** (SectionCard, Chip, Stat, EmptyState, FactorBars, Sparkline) | **KEEP** | Visual building blocks for the new CareBridge screens | Domain-agnostic; `FactorBars` in particular is ideal for showing red-flag reasoning. |
| **`components/shell/AppShell.tsx`** (sidebar shell, role-based nav) | **MODIFY** | Simplified single-role (patient) app shell, or removed in favor of a lighter chat-first layout | CareBridge's core screen is a conversation, not a multi-section dashboard; the sidebar pattern may be too heavy for the MVP's primary flow but is fine for a "past sessions" list later. |
| **`app/globals.css`** design tokens | **KEEP** | Visual language for CareBridge | Coherent, hospital-appropriate, reusable wholesale; may want a warmer/more approachable variant for a patient-first (not clinician-first) product, but the token system itself stays. |
| **Docker/Compose deployment, Prisma migration workflow** | **KEEP** | Deployment plumbing for CareBridge during the hackathon and beyond | Infra is product-agnostic; keep as-is. |
| **`averis/` (entire subdirectory)** | **REMOVE / IGNORE** | Not applicable — unrelated project | Confirmed to be a self-contained, unrelated IoT/wearable health platform bundled in the same repo. Not touched, not migrated, not referenced by CareBridge. |

## Summary counts

- **KEEP as-is:** 10 items — mostly infrastructure (auth plumbing, AI client wrapper, audit log,
  UI primitives, design tokens, deployment config, core patient/condition/allergy/medication data
  models).
- **MODIFY:** 8 items — the patient intake form, document extraction/AI modules, the risk/triage
  *pattern* (not the specific rules), and the documentation-generation pattern.
- **REMOVE (for MVP) / IGNORE:** 10 items — everything clinician/hospital-facing (triage board,
  doctor dashboard, patient registry/chart, admin portal, SOAP note workflow, RAG knowledge base,
  medication interactions) plus the entire unrelated `averis/` project.

This leaves a clean, small surface to build Phase 2 onward: **auth + patient profile (kept) +
a new AI Health Interview + a new Safety Engine (patterned on the risk/triage engines) + a
new, much simpler doctor hand-off view (patterned on, but not equal to, the SOAP note flow).**

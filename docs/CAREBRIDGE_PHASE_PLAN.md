# CareBridge — 7-Phase Development Plan

## Phase 1 — Understand & Prepare *(this phase — complete)*

- **Objective:** Understand the existing Meridian codebase, decide what to reuse, and set up a
  clean, working local development baseline before writing any CareBridge feature code.
- **Key tasks:** Explore the full repo structure; run the app locally end-to-end (auth, dashboard,
  migrations, seed data); write the codebase map, the Meridian→CareBridge feature mapping, the
  target architecture, the data-flow spec, the MVP boundary, and this phase plan; fix the one
  typecheck-scope issue found (`tsconfig.json` was sweeping the unrelated `averis/` project into
  `tsc --noEmit`); create the `feature/carebridge-phase-1` branch.
- **Expected output:** This full `docs/CAREBRIDGE_*.md` / `docs/MERIDIAN_TO_CAREBRIDGE.md` /
  `docs/TEAM_WORK_SPLIT.md` set, a confirmed-working local dev environment, and a clean git branch.
- **What the team should understand after this phase:** What Meridian already does, which parts of
  it are directly reusable, which parts must change, which parts get removed, and what the seven
  phases ahead look like — without having written a single line of CareBridge-specific feature code
  yet.

## Phase 2 — CareBridge UI

- **Objective:** Build the patient-facing shell and chat interface, wired to placeholder/stub
  responses (no real AI or Safety Engine yet).
- **Key tasks:** Adapt `components/shell/AppShell.tsx` and `app/globals.css` tokens into a simpler,
  patient-only shell; build the chat conversation screen (message list, input, loading state); build
  the structured-assessment display screen and the summary display screen, using
  `components/ui.tsx` primitives (`SectionCard`, `Chip`, `FactorBars`); wire these to a stub API
  that echoes canned responses so the UI can be demoed and iterated on independently of the backend.
- **Expected output:** A clickable, navigable CareBridge frontend that looks and feels right, backed
  by fake data.
- **What the team should understand after this phase:** The exact shape of data the UI needs at
  each screen — this becomes the contract the Backend and AI teams build to in Phases 3–4.

## Phase 3 — Backend + APIs

- **Objective:** Replace the Phase 2 stub API with a real one: session persistence, request
  validation, and auth wiring — still without real AI (canned/rule-based responses are fine).
- **Key tasks:** Design and migrate the new Prisma model(s) for a CareBridge session (structured
  state + conversation history, per `CAREBRIDGE_DATA_FLOW.md`); build the real API route(s) for
  "send a message" and "get session state," following the existing Zod-validate → guard → audit
  pattern from `app/api/**/route.ts`; reuse `lib/auth.ts`/`lib/patient.ts` for patient login and
  ownership checks.
- **Expected output:** A working, authenticated, persisted chat session — a patient can send
  messages and reload the page without losing state — even though the "intelligence" behind the
  replies is still a placeholder.
- **What the team should understand after this phase:** How a request flows from the browser
  through auth, validation, and into the database, and back — the exact backbone every later phase
  builds on top of.

## Phase 4 — AI Health Interview

- **Objective:** Replace the placeholder backend logic with real AI: understanding patient messages,
  extracting structured symptom data, and generating adaptive follow-up questions.
- **Key tasks:** Build the structured-extraction function (patterned on
  `lib/ai/extraction.ts`), with a JSON Schema for the symptom state and a deterministic fallback for
  when no API key is set; build the next-question generator; wire both into the Phase 3 backend so
  a real conversation now produces real, evolving structured state.
- **Expected output:** A patient can describe symptoms in their own words and receive sensible,
  context-aware follow-up questions, with the structured state visibly filling in as the
  conversation progresses.
- **What the team should understand after this phase:** How the deterministic-fallback pattern
  works in practice (the app should still function, in a reduced way, with no API key set) and why
  structured-output schemas matter for making AI output machine-checkable.

## Phase 5 — Safety Engine

- **Objective:** Build the deterministic red-flag / urgency engine and wire it into the conversation
  loop so it runs on every turn, independent of the AI.
- **Key tasks:** Design the red-flag rule table (patterned on `lib/clinical/triage.ts`'s
  `RED_FLAG_SYMPTOMS`), as a pure, unit-tested function taking the structured state and returning
  red flags + an urgency level; wire the orchestration logic so a detected red flag short-circuits
  AI question-generation and returns fixed, reviewed urgency-guidance copy instead (see the example
  in `CAREBRIDGE_DATA_FLOW.md`).
- **Expected output:** The single most safety-critical piece of the product, working and tested:
  a red-flag symptom combination reliably produces urgency guidance, every time, regardless of what
  the AI would have said.
- **What the team should understand after this phase:** Why this engine is deterministic and
  AI-independent by design — this is the concrete, working proof of CareBridge's core safety
  promise, not just a claim in a slide deck.

## Phase 6 — Doctor Handoff

- **Objective:** Generate the doctor-ready pre-consultation summary from a completed session.
- **Key tasks:** Build the summary-generation function (patterned on `lib/ai/documentation.ts`'s
  `generateNote()`) that turns the structured state + conversation into a clear, professionally
  worded summary; build the patient-facing "here's what will be shared with your doctor" screen
  (transparency matters — the patient should see exactly what the doctor sees); if time allows, a
  minimal doctor-facing view to read the summary (not a full dashboard — see `CAREBRIDGE_MVP.md`).
- **Expected output:** A complete, end-to-end MUST HAVE list (per `CAREBRIDGE_MVP.md`) — patient
  chat → extraction → questions → safety check → summary → doctor hand-off — all working together.
- **What the team should understand after this phase:** The product is now demoable start to finish;
  everything after this is polish, robustness, and (optionally) AWS migration — not new core
  functionality.

## Phase 7 — AWS Integration + Polish + Demo

- **Objective:** Harden and, if valuable for the hackathon's judging criteria, migrate pieces to
  AWS; polish the UI; rehearse the demo.
- **Key tasks:** (Only if pursued — see `CAREBRIDGE_ARCHITECTURE.md`'s "don't force every AWS
  service in" caution) swap Anthropic direct calls for Amazon Bedrock behind the existing
  `lib/ai/client.ts`-style abstraction; consider Lambda/API Gateway for the API layer and DynamoDB
  for session storage if there's a clear win; add CloudWatch monitoring only if there's a deployed
  environment to monitor. In parallel: visual polish, error-state handling, a rehearsed walkthrough
  of a realistic symptom scenario (mirroring how Meridian's own README documents a "suggested demo
  walkthrough"), and a final pass through `CAREBRIDGE_MVP.md`'s nice-to-have list if time remains.
- **Expected output:** A polished, reliably demoable product, with an honest account of what's on
  AWS vs. what's still local/direct-API, ready to present.
- **What the team should understand after this phase:** The difference between "what we needed to
  ship the MVP" and "what we added because the judging criteria rewarded it" — and be able to
  explain that distinction clearly if asked.

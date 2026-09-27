# CareBridge — Team Work Split

Written for a first-time hackathon team of 3–4 beginners. Everyone should be able to read their own
section and know exactly what to open, build, and hand off — and roughly what the other roles are
doing so the whole team can coordinate.

## Frontend

**What you own:** everything the patient (and later, the doctor) actually sees and clicks.

- **Patient UI** — the overall app shell, navigation, and the entry point where a patient starts a
  new CareBridge session. Reuse `components/shell/AppShell.tsx` and `app/globals.css`'s design
  tokens (`.card`, `.btn`, `.field`) so you're not starting from a blank page.
- **Chat UI** — the actual conversation screen: message bubbles, a text input, a "typing/thinking"
  state while the backend responds. There's no existing multi-turn chat component in this codebase
  to copy directly (the closest thing, `app/(clinic)/knowledge/KnowledgePanel.tsx`, is single-Q&A
  only), so this is new UI — but its `fetch` → loading state → render pattern is worth copying.
- **Assessment UI** — the screen showing the current structured symptom state and, if a red flag is
  found, the urgency guidance message. `components/ui.tsx`'s `FactorBars` and `Chip`/`SeverityChip`
  are ready-made for showing "why" something was flagged, the same way `RiskPanel.tsx` uses them
  today.
- **Report UI** — the doctor-ready summary screen, shown to the patient before hand-off (and later
  to the doctor). Model it on how `app/(clinic)/documentation/NoteComposer.tsx` displays a generated
  SOAP note.

**Where to start reading:** `components/ui.tsx`, `components/shell/AppShell.tsx`,
`app/(portal)/portal/setup/ProfileForm.tsx` (for form/input patterns), `app/globals.css`.

**Hand-off to Backend:** you need one API endpoint that takes a chat message + session id and
returns the assistant's reply + updated state — agree on that shape together before building either
side.

## Backend

**What you own:** the API layer, session persistence, request validation, and getting things
correctly wired to AWS if that phase is reached.

- **APIs** — new route handlers under `app/api/carebridge/...` (or similar), following the existing
  pattern exactly: Zod schema for the request body → `requireRole`/`requirePatient` guard →
  business logic → `audit()` call → JSON response. Copy the shape from
  `app/api/triage/route.ts` or `app/api/portal/profile/route.ts` — both are small, complete
  examples.
- **Sessions** — design and implement the new Prisma model(s) for a CareBridge session (see
  `CAREBRIDGE_DATA_FLOW.md` for the structured-state shape). `lib/db.ts` is the existing Prisma
  client singleton — reuse it as-is.
- **Data validation** — every request body gets a Zod schema, same as every existing route in
  `app/api/**/route.ts`. This is not optional — it's the pattern the whole codebase already follows.
- **AWS integration** (Phase 7 only, if reached) — swapping the Anthropic SDK calls for Bedrock,
  and/or moving routes to Lambda behind API Gateway. Don't start this until the AI and Safety Engine
  teams have something working locally.

**Where to start reading:** `app/api/triage/route.ts`, `app/api/portal/profile/route.ts`,
`lib/auth.ts`, `lib/patient.ts`, `lib/db.ts`, `prisma/schema.prisma`.

**Hand-off to AI:** you call the AI team's extraction/question-generation functions from inside your
route handler — agree on their function signatures (inputs/outputs as plain TypeScript types) so
you can build against a stub before their implementation is ready.

## AI

**What you own:** everything that talks to the language model.

- **Bedrock (or Anthropic) integration** — start from `lib/ai/client.ts`: it already has the
  `aiAvailable()` fallback check, the `completeJson()` structured-output helper, and refusal
  handling. If staying on Anthropic directly for the hackathon (recommended — see the architecture
  doc), you barely need to change this file. If migrating to Bedrock, this is the one file that
  needs a new implementation behind the same function signatures.
- **Structured extraction** — the function that takes a patient's chat message + the current
  structured state and returns an updated structured state. Model it directly on
  `lib/ai/extraction.ts`'s `extractDocument()`: define a JSON Schema for the symptom state, call
  `completeJson()` with it, and — just like that file does — write a simple deterministic fallback
  for when no API key is configured, so the demo never fully breaks.
- **Adaptive question generation** — the function that looks at what fields are still missing (as
  decided by the Safety Engine's needs, not the AI's own judgment — see the architecture doc's
  non-negotiable rule) and phrases the next question in plain, empathetic language.
- **Summary generation** — model this on `lib/ai/documentation.ts`'s `generateNote()`: structured
  input in, structured doctor-readable output out, with a template-based fallback for offline
  demos.

**Where to start reading:** `lib/ai/client.ts`, `lib/ai/extraction.ts`, `lib/ai/documentation.ts`.

**Hand-off to Backend:** your functions should be plain, testable TypeScript functions
(`(input) => Promise<output>`) that the backend team calls from a route handler — don't couple them
to `NextRequest`/`NextResponse` directly, the same way `lib/ai/extraction.ts` has no idea it's being
called from an API route.

## Lead / Integration

**What you own:** making sure the pieces the other three roles build actually fit together safely,
plus deployment and testing.

- **Architecture** — keep everyone honest about the separation in `CAREBRIDGE_ARCHITECTURE.md`:
  the AI layer must never be the sole source of a red-flag/urgency decision. Review any PR that
  touches both the AI extraction code and the Safety Engine code for this specifically.
- **Safety rules** — you personally own the deterministic Safety Engine (the CareBridge equivalent
  of `lib/clinical/triage.ts`'s `RED_FLAG_SYMPTOMS` table): a plain-function rule table that takes
  the structured symptom state and returns red flags + urgency, with zero AI calls inside it. This
  is the single most safety-critical piece of the product — it should be simple, readable, and unit
  tested.
- **Integration** — wire Frontend ↔ Backend ↔ AI ↔ Safety Engine together; this is usually the
  first person to notice when two roles built to slightly different assumptions about a data shape,
  so keep `CAREBRIDGE_DATA_FLOW.md`'s example state up to date as the real source of truth for what
  fields exist.
- **Deployment** — keep `docker-compose.yml`/`Dockerfile`/`.env.example` current as new environment
  variables get added (e.g. a Bedrock region, a new API key).
- **Testing** — write the tests for the Safety Engine especially (it's pure functions — this is the
  easiest and most important part of the codebase to have solid test coverage on), and do an
  end-to-end pass through the MUST HAVE list in `CAREBRIDGE_MVP.md` before every demo.

**Where to start reading:** everything in `docs/`, especially this Phase 1 set, plus
`lib/clinical/triage.ts` and `lib/clinical/risk.ts` as the reference pattern for the Safety Engine.

## How the four roles fit together in one sentence each

- **Frontend** shows the conversation and the result.
- **Backend** receives messages, persists sessions, and calls AI + Safety in the right order.
- **AI** understands language and phrases language; it never decides urgency.
- **Lead/Integration** owns the one rule that makes this a safe product: the Safety Engine decides
  urgency, always, on every turn, deterministically.

# CareBridge — Phase 2: UI/UX

Phase 2 builds the complete, clickable CareBridge patient experience — landing page through
doctor-ready summary — on **mock data only**. No AI, no real API calls, no AWS, no changes to
authentication. Everything described here is frontend work; the real backend/AI/safety logic
arrives in Phases 3–5.

## 1. Pages created

| Route | File | Purpose |
|---|---|---|
| `/` | `app/page.tsx` | New CareBridge landing page — replaces the old Meridian role-redirect logic. Hero, 3-step explainer, safety note. |
| `/assessment` | `app/assessment/page.tsx` | Health Assessment Setup — age, preferred language, optional existing conditions/medications, with a "Why do we ask this?" explainer. Frontend validation only. |
| `/assessment/interview` | `app/assessment/interview/page.tsx` | The AI Health Interview — scripted mock chat + live assessment-progress panel. |
| `/assessment/result` | `app/assessment/result/page.tsx` | Assessment Result — status banner (routine / consult soon / urgent), symptom summary, reported details, care guidance. |
| `/assessment/summary` | `app/assessment/summary/page.tsx` | Doctor-ready pre-consultation summary, with download/copy/start-new actions. |

`app/assessment/layout.tsx` wraps the four assessment pages in the CareBridge shell and provides
the shared assessment state (see §4). `app/layout.tsx`'s metadata (page title/description) was
rebranded from Meridian to CareBridge.

**What was intentionally left alone:** the old Meridian `(admin)`, `(clinic)`, and `(portal)` route
groups still exist, unedited, at their original URLs (`/dashboard`, `/admin`, `/portal`, etc.) —
per `docs/MERIDIAN_TO_CAREBRIDGE.md` they're slated for removal in a later phase, so a full rebrand
sweep of their internal copy would have been wasted, unrelated-refactor effort in a UI/UX-only
phase. The only Meridian-wide change is that `/` no longer auto-redirects into those portals — it's
now the CareBridge landing page for everyone, matching this phase's routing spec.

## 2. Components created

All under `components/carebridge/`, plus one new icon set. Kept intentionally small — nothing here
is a one-off single-use wrapper unless the brief specifically named it.

| Component | Role |
|---|---|
| `CareBridgeShell` | Page frame: skip-link + `TopNav` + a centered content well. |
| `TopNav` | Logo, "Health Assessment" link, decorative profile menu (no auth wiring — see §8). |
| `PrimaryButton` / `SecondaryButton` | The two button styles used everywhere; render as a `<button>` or, given `href`, a `next/link`. |
| `AssessmentProgress` | The right-hand checklist (desktop) / compact bar (mobile) — see §5. |
| `ChatWindow` / `ChatMessage` / `ChatInput` / `QuickReply` / `TypingIndicator` | The chat UI: scrollable log, one bubble, the input, the pill-button quick replies, and the "assistant is typing" indicator. |
| `RiskStatusCard` | The routine/consult-soon/urgent banner — icon + label + color, never color alone. |
| `PatientInfoCard` | Small demographic summary block used at the top of the summary page. |
| `DoctorSummary` | Renders the full pre-consultation summary sections. |
| `EmptyState` / `ErrorState` / `LoadingState` | The three CareBridge-specific placeholder states (see §8). |
| `icons.tsx` | New icons this feature needed (check-circle, circle, send, alert-triangle, info, user, close, download, copy, refresh, chevron-right); the logo mark reuses the existing `IconHeart` from `components/shell/icons.tsx` rather than duplicating it. |

**Reused, not rebuilt:** `components/ui.tsx`'s `SectionCard` is visually neutral already (white
card, grey hairline, grey eyebrow text — no Meridian green baked in), so a `HealthSummaryCard`
wrapper the brief suggested would have been a near-duplicate; the result/summary pages compose
their sections directly instead. `EmptyState` and `Chip` from `components/ui.tsx` were *not* reused
as-is because they lack an action slot and use Meridian's own token names — CareBridge's versions
add a CTA slot and use the new `cb-*` tokens, which is why they're separate small components rather
than edits to the shared Meridian file (avoiding any regression risk to the pages that still use it).

## 3. Routes created

Exactly the five routes the brief specified, using the existing Next.js App Router — no parallel
routing system was introduced:

```
/                       → landing
/assessment             → setup
/assessment/interview   → AI interview
/assessment/result      → assessment result
/assessment/summary     → doctor-ready summary
```

All five are public (no auth guard) — Phase 2 explicitly excludes authentication changes, and the
success criteria describe a flow anyone can click through.

## 4. Mock data structure

```
lib/carebridge/
├── types.ts                 shared TypeScript types (ChatMessage, ProgressState,
│                             AssessmentSetup, ResultStatus, SymptomFindings, DoctorSummary)
├── assessment-context.tsx    "use client" React context — the mock "backend" for Phase 2
└── mock/
    ├── conversation.ts       the scripted interview (INTERVIEW_STEPS)
    ├── assessment.ts         defaults, progress/status/findings computation, status copy
    └── summary.ts            builds a DoctorSummary + formats it as plain text
```

`CareBridgeAssessmentProvider` (in `assessment-context.tsx`) holds the in-progress assessment —
setup answers, chat messages, per-step answers, completion state — in React state, persisted to
`localStorage` so a page refresh mid-flow doesn't lose progress. It exposes one hook,
`useCareBridgeAssessment()`, that every assessment page and component reads from. **This is the
intended Phase 3 integration seam** — see §9.

The mock interview is a fixed script (`INTERVIEW_STEPS`), not a real conversation: each step is one
assistant message and (for most steps) the checklist field the patient's next reply satisfies.
Three small deterministic helper functions turn the patient's raw answers into demo content:

- `deriveMockSymptoms()` — a keyword scan over the patient's free-text chief complaint (the same
  "deterministic keyword matching" shape as `lib/ai/extraction.ts`'s fallback parser elsewhere in
  this codebase — a deliberate echo, not a coincidence).
- `computeMockStatus()` — a reported warning sign always wins, then severity; this is a tiny preview
  of the real Safety Engine's shape (Phase 5), **not** a medical classification.
- `computeMockFindings()` — assembles the "symptom summary" shown on the result page from the raw
  answers.

## 5. Design system

Added as a clearly delimited, additive section at the bottom of `app/globals.css`, namespaced with
a `cb-` prefix throughout (`--color-cb-*` tokens, `.cb-card`, `.cb-btn*`, `.cb-field`, `.cb-status*`,
`.cb-bubble*`, `.cb-quick-reply`, `.cb-progress*`) so it never overrides the existing Meridian
tokens/classes the old clinic/admin/portal pages still use. No new UI library or font was added —
CareBridge reuses the existing IBM Plex Sans (already "a highly readable sans-serif") and Tailwind
v4's `@theme` mechanism, which auto-generates utility classes (`bg-cb-primary`, `text-cb-danger`,
etc.) from the new tokens the same way the Meridian tokens already do.

- **Color:** deep medical blue (`#1d4ed8`) as the one primary/brand color; soft slate neutrals for
  backgrounds and surfaces; green/amber/red reserved strictly for the three result states, never
  used decoratively.
- **Typography:** IBM Plex Sans throughout (no change).
- **Radius:** 14px cards, 10px buttons/fields, pill-shaped (999px) chips and quick-replies —
  "rounded but not excessive."
- **Shadows:** two subtle levels (`--shadow-cb-card`, `--shadow-cb-pop`), no heavy drop shadows.
- **Motion:** the 120ms transitions already defined for Meridian, plus one small typing-indicator
  keyframe — all disabled by the existing sitewide `prefers-reduced-motion` rule.

## 6. Responsive behavior

- **Interview page** (the one screen with a genuinely different mobile layout): a CSS grid
  (`md:grid-cols-[1fr_300px]`) puts the chat and the progress panel side by side on desktop/tablet.
  Below the `md` breakpoint, `AssessmentProgress` renders in a `compact` mode (a single percentage
  bar) placed above the chat instead of the full checklist sidebar — exactly the "collapses into a
  compact indicator" behavior the brief asked for — implemented with plain responsive Tailwind
  classes (`hidden md:block` / a separate `md:hidden` compact block), no JavaScript toggle needed.
- **Chat input** stays inside the chat card, which has a bounded height (`h-[68vh]`) with its own
  internal scroll — so the input is always one scroll away, never pushed off-screen, on any
  viewport.
- **Buttons** stack vertically (`flex-col sm:flex-row`) on narrow screens so nothing overflows; all
  interactive controls (buttons, quick-replies, the profile menu button) have a 40–44px minimum
  touch target.
- **Cards** (result/summary sections) are single-column by default and only introduce multi-column
  grids at `sm:`/`md:` widths.
- Manually verified at a 390×844 mobile viewport via `agent-browser` (see §8 testing notes).

## 7. Accessibility work

- Semantic landmarks: `<header>`, `<main id="cb-main">`, a "Skip to content" link
  (`.cb-skip-link`) as the very first focusable element.
- Every form input has a real `<label htmlFor>`; the chat input's label is visually hidden
  (`sr-only`) but present for screen readers.
- Visible focus rings on every interactive element inside the CareBridge UI (`.cb-app :focus-visible`
  sets a 2px outline), not just a color change.
- The progress checklist and progress bar use `role="progressbar"` with `aria-valuenow/min/max`, and
  each checklist row has an `sr-only` "— collected / — not yet collected" suffix so the check/circle
  icon's meaning isn't color/shape-only for screen-reader users.
- The result page's status card communicates urgency with an icon **and** a text label **and**
  color together (`RiskStatusCard`), per the brief's "not color alone" requirement — same principle
  applied to the checklist rows (check-circle vs. plain circle icon, not just a color swap).
- The chat log is `role="log"` with `aria-live="polite"` so new assistant messages are announced;
  the typing indicator has an `sr-only` "CareBridge is typing a reply" label so it isn't silent for
  screen-reader users.
- All touch targets meet a 40–44px minimum (buttons, quick-replies, the profile icon button).

## 8. What is intentionally mocked

- **The entire AI Health Interview** is a fixed script (`INTERVIEW_STEPS`), not a real language
  model — Phase 4's job.
- **The three result states** are reached through simple, transparent client-side branching on the
  patient's own quick-reply choices (a warning sign always wins; otherwise severity decides) — a
  deliberately simplistic stand-in for Phase 5's real, deterministic Safety Engine, not a medical
  classification of any kind.
- **The result page's "Demo: preview other outcomes" control** (three pills to force
  routine/consult-soon/urgent) exists purely so this Phase 2 prototype's three visual states can be
  reviewed without re-running the whole scripted chat three times; it's clearly labeled as a demo
  aid and is a natural thing to remove once Phase 5 supplies a real status.
- **"Download summary" and "Copy summary"** are real, working, purely client-side actions (a text
  Blob download and `navigator.clipboard.writeText`) — not PDF generation and not a backend call,
  per the phase's explicit constraints, but genuinely functional rather than inert buttons.
- **The profile menu** in `TopNav` is decorative — it opens a small note that sign-in/profile
  management is a later phase; there is no auth change in this phase.
- **`ErrorState`'s "session expired" framing** was built as a ready component variant but is not
  triggered anywhere live — there is no real session or API call yet for either to genuinely fail.
  It's there for Phase 3 to wire up once a real request can actually fail or a real session can
  actually expire; forcing an artificial failure into the UI now would be misleading rather than
  useful.
- **The setup form's "Continue"** and the transition from a finished interview into the result page
  both show a brief, real `LoadingState` (a short timeout, not a spinner-for-show) — simulating the
  latency a real API call will have in Phase 3.

## 9. What Phase 3 will connect

The seam is exactly `lib/carebridge/assessment-context.tsx`. Phase 3 should:

1. Replace `sendReply()`'s scripted `window.setTimeout` + `INTERVIEW_STEPS` lookup with a real
   `POST` to a new API route (following the existing `app/api/**/route.ts` Zod-validate → guard →
   audit pattern), which will itself call the Phase 4 AI extraction function and the Phase 5 Safety
   Engine.
2. Replace `computeMockStatus()` / `computeMockFindings()` with whatever the real API response
   shape turns out to be — the `SymptomFindings` / `ResultStatus` types in `lib/carebridge/types.ts`
   are the contract every CareBridge component already renders against, so the components
   themselves shouldn't need to change.
3. Replace the `localStorage`-backed `PersistedState` with a real session, persisted via Prisma
   (see `docs/CAREBRIDGE_DATA_FLOW.md` for the target schema) instead of the browser.
4. Remove the result page's "Demo: preview other outcomes" control once a real `ResultStatus` is
   coming from the Safety Engine.

Nothing in `components/carebridge/*` imports the mock files directly except the four page
components — swapping the context's internals is the entire integration point.

## Testing performed

- `npx tsc --noEmit` — clean.
- `npm run build` — clean; all five new routes compile and prerender as static pages.
- Manual, scripted browser walkthrough via `agent-browser` covering: landing page content, setup
  form validation (empty/invalid age blocked with an inline error), the full scripted interview
  (free-text + quick-reply answers), live progress-checklist updates, the "urgent" result path,
  the demo status-preview toggle, the doctor-ready summary (patient info + full summary sections),
  working copy-to-clipboard and file download, `localStorage` persistence across a page reload, the
  reset flow via "Start new assessment," the "no assessment available" empty state, and the mobile
  (390×844) responsive layout of the interview page. See the end-of-phase report for the detailed
  results and any findings.

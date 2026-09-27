# CareBridge — Data Flow

This is documentation only — nothing described here is implemented yet. It describes the future
request lifecycle so Phase 3–5 have a shared target to build against.

## 1. The lifecycle

```
User message
   → frontend (chat UI)
   → backend (API layer)
   → AI extraction (understand the new message, update structured state)
   → structured symptom state (merged with prior turns)
   → safety rule evaluation (deterministic — runs on every turn)
   → urgency result (none / routine / soon / urgent — deterministic, not from the AI)
   → next-question generation (AI decides what's still missing, phrased in plain language)
       — unless a red flag was found, in which case urgency guidance replaces the next question
   → response to user
   → (once enough information is collected) summary generation
   → doctor-ready pre-consultation summary
```

Two things run **on every single turn**, not just at the end: **structured extraction** (so the
state is always current) and **safety rule evaluation** (so a red flag raised on turn 2 is caught
immediately, not only after the interview "finishes").

## 2. Conceptual data shape

The structured state is the thing that actually flows through the system — the chat transcript is
context for the AI, but the state is what the Safety Engine and the summary generator read.

```jsonc
{
  "sessionId": "cb_9f2a...",
  "patientId": "usr_123",
  "status": "collecting_information",   // collecting_information | red_flag | ready_for_summary | completed
  "symptoms": ["fever"],
  "duration": "1 day",
  "severity": null,                      // e.g. "mild" | "moderate" | "severe", once asked
  "temperature": null,
  "associated_symptoms": [],
  "relevant_history": [],                // pulled from the patient's known Conditions/Allergies if available
  "red_flags": [],                       // filled in by the Safety Engine, never by the AI directly
  "conversation": [
    { "role": "patient", "text": "I have had fever since yesterday.", "at": "2026-09-27T10:02:00Z" }
  ]
}
```

## 3. Concrete example, turn by turn

**Turn 1**

> **Patient:** "I have had fever since yesterday."

1. Frontend sends `{ sessionId, message: "I have had fever since yesterday." }` to the backend.
2. Backend orchestration loads (or creates) the session's current structured state — empty, since
   this is turn 1.
3. AI extraction step reads the message + current state, returns an **updated** state (this mirrors
   `lib/ai/extraction.ts`'s pattern of a JSON-Schema-constrained completion, applied to a chat turn
   instead of a whole document):

   ```jsonc
   {
     "symptoms": ["fever"],
     "duration": "1 day",
     "severity": null,
     "temperature": null,
     "red_flags": [],
     "status": "collecting_information"
   }
   ```
4. Safety Engine evaluates this state against its deterministic red-flag rules (patterned on
   `lib/clinical/triage.ts`'s `RED_FLAG_SYMPTOMS` table). Fever alone, with no other information,
   triggers **no red flag** — but the engine also decides what critical fields are still unknown
   (e.g. temperature, associated symptoms) that it needs before it can rule out something serious.
5. Backend orchestration asks the AI to phrase the next question from the *missing fields the
   Safety Engine flagged* — not from the AI's own judgment of what's "medically interesting." This
   is the key wiring that keeps the AI subordinate to the rules.
6. Response to patient: *"How high has your temperature gotten, and have you noticed any other
   symptoms like a rash, stiff neck, or difficulty breathing?"*

**Turn 2**

> **Patient:** "It's been around 101°F, and I also feel a bit short of breath."

1. AI extraction updates the state:

   ```jsonc
   {
     "symptoms": ["fever", "shortness of breath"],
     "duration": "1 day",
     "severity": null,
     "temperature": "101°F",
     "red_flags": [],
     "status": "collecting_information"
   }
   ```
2. Safety Engine re-evaluates. "Shortness of breath" is a red-flag symptom (directly analogous to
   `RED_FLAG_SYMPTOMS["shortness of breath"]` in `lib/clinical/triage.ts`, which scores it 14
   points as "respiratory compromise risk"). The Safety Engine sets:

   ```jsonc
   {
     "red_flags": ["shortness of breath with fever"],
     "status": "red_flag"
   }
   ```
3. Because `status` is now `red_flag`, the orchestration layer **skips AI question-generation
   entirely** and returns deterministic urgency guidance instead — the AI is not asked to decide
   what to say here; the copy for a red-flag response is fixed, reviewed text.
4. Response to patient: a clear, calm statement that this combination of symptoms warrants prompt
   in-person medical attention, with guidance to seek care soon (exact thresholds/wording are a
   Phase 5 deliverable, written and reviewed as fixed strings — not generated fresh by the LLM per
   the non-negotiable safety rule in the architecture doc).

**If no red flag had been found**, the loop continues (more turns → more fields filled) until the
Safety Engine decides enough structured information exists to stop collecting and the orchestration
layer triggers **summary generation**: a final AI call turns the accumulated structured state +
conversation into a doctor-ready pre-consultation summary (this mirrors `lib/ai/documentation.ts`'s
"structured input → structured clinical writeup" pattern, but built from an interview instead of a
doctor's dictation).

## 4. Why this shape matters

- **The AI touches the state, never the decision.** It can add `"shortness of breath"` to
  `symptoms`, but only the Safety Engine can set `red_flags` or `status: "red_flag"`. This is a
  direct application of the pattern already proven in `lib/clinical/risk.ts`, where the LLM writes
  a narrative but never the score.
- **Every turn is independently auditable.** Because the structured state is what gets evaluated
  (not raw chat text), a reviewer can look at any point in a session and see exactly what
  information was known and what the rules concluded from it — same spirit as Meridian's
  `AuditLog` and `RiskAssessment.factors` JSON columns.
- **The summary is a derived artifact, not the source of truth.** The structured state + full
  conversation is what's stored; the doctor-ready summary is generated from it and can be
  regenerated if the summary format changes later.

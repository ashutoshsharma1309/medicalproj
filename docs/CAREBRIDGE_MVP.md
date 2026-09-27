# CareBridge — MVP Boundary

The purpose of this document is to prevent scope creep. If something isn't in **MUST HAVE**, it
doesn't get built before the MUST HAVE list is done and demoable — no exceptions, no "just a quick
add-on."

## MUST HAVE (the hackathon demo does not work without these)

1. **Patient chat** — a conversational UI where a patient describes symptoms in free text and
   receives follow-up questions, turn by turn.
2. **Symptom extraction** — every patient message is parsed into the structured symptom state
   described in [`CAREBRIDGE_DATA_FLOW.md`](./CAREBRIDGE_DATA_FLOW.md), using the AI layer
   (`lib/ai/client.ts`'s structured-JSON pattern).
3. **Adaptive follow-up questions** — the next question is chosen based on what's still missing
   from the structured state, not a fixed script.
4. **Deterministic red-flag checks** — a rule-based Safety Engine (patterned on
   `lib/clinical/triage.ts`) evaluates the structured state on every turn and can independently
   flag urgency, regardless of what the AI generated.
5. **Urgency guidance** — a clear, fixed-wording response shown to the patient when a red flag is
   found (e.g. "seek care promptly"), and a routine closing message otherwise.
6. **Structured patient summary** — the final structured state, viewable by the patient in plain
   language.
7. **Doctor-ready summary** — a structured, professionally-worded write-up generated from the
   session (patterned on `lib/ai/documentation.ts`), suitable for a doctor to skim before a
   consultation.

If all seven of these work end-to-end for at least one realistic symptom scenario, CareBridge has a
demoable product. Everything else is optional polish.

## NICE TO HAVE (build only after all seven MUST HAVEs work, and only if time remains)

- **Multilingual support** (English/Hindi/Kannada) — see the architecture doc's note that this
  belongs entirely in the AI layer, not the Safety Engine.
- **Voice input** — speech-to-text before the message hits the same chat pipeline; no new backend
  logic needed if built.
- **Downloadable report** — export the doctor-ready summary as a PDF (would need S3 or local file
  storage, mirroring Meridian's `uploads/` pattern).
- **Session history** — a patient's list of past CareBridge sessions (straightforward once the
  session model exists, but not needed for a single-session demo).
- **Additional analytics** — usage stats, admin views, etc.
- **Document upload during the interview** — attaching a photo of a rash or a lab report mid-chat,
  reusing Meridian's `lib/ai/patientExtraction.ts` pipeline.

## DO NOT BUILD FOR THE HACKATHON UNLESS TIME REMAINS AFTER *EVERYTHING ELSE* (including nice-to-haves)

These are explicitly out of scope — building any of these before the MUST HAVE list is complete is
a process failure, not initiative:

- Medical image diagnosis
- Wearable integrations
- IoT (note: the bundled `averis/` project already does extensive IoT/wearable work — it is a
  separate product and is not a shortcut into this scope; do not pull code from it)
- Multi-agent systems
- Model fine-tuning
- Complex RAG (Meridian's `lib/rag.ts` is available as a reference if this is ever revisited, but
  it is not part of CareBridge's MVP)
- Vector database
- Kubernetes
- Kafka
- Blockchain
- Unnecessary predictive disease models (Meridian's `lib/clinical/risk.ts` cardiovascular/metabolic
  scoring is a hospital feature, not a CareBridge one — do not port it in)

## How to use this document

When someone on the team proposes a feature, check it against these three lists before writing any
code. If it's not on the MUST HAVE list and the MUST HAVE list isn't fully working end-to-end yet,
the answer is "not now" — write it down for later instead of building it.

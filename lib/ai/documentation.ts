import { aiAvailable, completeJson, CLINICAL_SYSTEM, MODEL } from "./client";

/**
 * Module 7 — Clinical documentation assistant.
 * Turns dictated / shorthand encounter notes into a structured SOAP note,
 * a patient-friendly summary and a follow-up plan.
 */

export type GeneratedNote = {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  summary: string;
  followUp: string;
};

const NOTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subjective", "objective", "assessment", "plan", "summary", "followUp"],
  properties: {
    subjective: { type: "string" },
    objective: { type: "string" },
    assessment: { type: "string" },
    plan: { type: "string" },
    summary: { type: "string" },
    followUp: { type: "string" },
  },
};

export async function generateNote(opts: {
  rawInput: string;
  kind: string;
  patientContext: string; // conditions, meds, allergies summary
}): Promise<{ note: GeneratedNote; engine: string }> {
  if (aiAvailable()) {
    const note = await completeJson<GeneratedNote>({
      system: CLINICAL_SYSTEM,
      prompt: `Convert the physician's raw encounter notes into a structured ${opts.kind.toUpperCase()} note.

Patient context (verified from the record — use for accuracy, do not copy wholesale):
${opts.patientContext}

Physician's raw notes:
<notes>
${opts.rawInput}
</notes>

Requirements:
- subjective / objective / assessment / plan: professional clinical register, concise bullet-style sentences separated by newlines.
- Never add findings, values or medications not present in the raw notes or patient context.
- summary: 2–3 sentences in plain language a patient could understand.
- followUp: concrete actions with timeframes (e.g. "Repeat HbA1c in 3 months").`,
      schema: NOTE_SCHEMA,
      maxTokens: 3000,
    });
    return { note, engine: MODEL };
  }
  return { note: templateNote(opts.rawInput, opts.patientContext), engine: "template-v1" };
}

/** Deterministic fallback: structures the raw input into SOAP sections by cue words. */
function templateNote(raw: string, context: string): GeneratedNote {
  const lines = raw
    .split(/\r?\n|(?<=\.)\s+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const objective: string[] = [];
  const subjective: string[] = [];
  const planLines: string[] = [];
  const assessLines: string[] = [];

  const objCues = /\b(bp|blood pressure|hr|heart rate|temp|spo2|exam|auscultat|palpat|\d+\s*(mmhg|bpm|%|°|kg))\b/i;
  const planCues = /\b(start|stop|increase|decrease|continue|order|refer|schedule|follow.?up|repeat|prescribe|titrate)\b/i;
  const assessCues = /\b(likely|consistent with|impression|assessment|suspect|differential|uncontrolled|stable|improving|worsening)\b/i;

  for (const l of lines) {
    if (planCues.test(l)) planLines.push(l);
    else if (objCues.test(l)) objective.push(l);
    else if (assessCues.test(l)) assessLines.push(l);
    else subjective.push(l);
  }

  return {
    subjective: subjective.join("\n") || "Patient-reported history as dictated.",
    objective: objective.join("\n") || "See vitals and examination findings in the record.",
    assessment:
      assessLines.join("\n") ||
      "Assessment pending physician review. Context on file:\n" + context,
    plan: planLines.join("\n") || "Plan to be completed by the treating physician.",
    summary:
      "Your clinician reviewed your current condition and updated your care plan. The details of today's visit have been recorded in your chart.",
    followUp: planLines.find((l) => /follow.?up|repeat|schedule/i.test(l)) ?? "Follow-up as advised by your clinician.",
  };
}

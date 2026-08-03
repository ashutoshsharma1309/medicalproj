import {
  medicalExtraction,
  DocumentProcessingError,
  type MedicalExtraction,
} from "./types";

/**
 * The AI provider is injected rather than statically imported so this module
 * stays free of the `server-only` chain — that keeps the prompt construction,
 * JSON recovery and contract validation directly unit-testable, and inverts
 * the dependency so a different model can be substituted without touching the
 * pipeline.
 */
export type CompletionFn = (opts: {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  maxTokens?: number;
  json?: boolean;
}) => Promise<string>;

/**
 * The AI layer of the pipeline.
 *
 * Responsibilities (and nothing else): build the extraction prompt, call the
 * provider, validate that what came back really is the contract, and fail
 * loudly when it is not. It never touches storage or the database.
 */

const SYSTEM_PROMPT = `You are the medical document extraction engine inside AVERIS, a patient health platform.

Your job is to read a medical document and return structured data about it. Patients — not clinicians — read your output.

Hard rules:
- Return ONLY a single JSON object. No prose, no markdown fences, no commentary.
- Extract only what the document actually states. Never infer, complete, or invent a value. If something is absent, use null or an empty array.
- Every extracted field carries a "confidence" between 0 and 1 reflecting how clearly the source supports it. Illegible or ambiguous text must score low (below 0.7). Do not inflate confidence.
- Preserve numbers, units and dosages exactly as written.
- NEVER diagnose, interpret severity, or advise on treatment. Do not tell the patient what they have, what to take, or what to change.
- Do NOT draw conclusions from the values. Restating a recorded number is allowed; judging what it means is not.
  ALLOWED:     "This report records an HbA1c of 8.2%, above the stated reference range of 4.0-5.6%."
  NOT ALLOWED: "These findings indicate your diabetes control may need attention."
  NOT ALLOWED: "Your cholesterol requires monitoring."
  The difference: the first restates the document, the second forms a clinical judgement.
- "flag" is the ONE exception, and it is arithmetic rather than judgement: set HIGH or LOW when
  the value falls outside the reference range printed on the document itself. Use UNKNOWN only
  when the document states no reference range.
- "summary" is 2-3 plain-language sentences describing what the document contains and what was recorded. Observational only, written for a layperson. Always direct the patient to their healthcare provider for interpretation.
- "key_findings" are short factual restatements of notable recorded values (e.g. "HbA1c recorded at 8.2%"), never judgements about them.`;

/** The exact shape the model must return. */
const OUTPUT_CONTRACT = `{
  "patient_name": { "value": string, "confidence": number } | null,
  "age": { "value": integer, "confidence": number } | null,
  "gender": { "value": "FEMALE"|"MALE"|"OTHER"|"UNKNOWN", "confidence": number } | null,
  "blood_group": { "value": "A+"|"A-"|"B+"|"B-"|"AB+"|"AB-"|"O+"|"O-"|"UNKNOWN", "confidence": number } | null,
  "conditions":  [{ "value": string, "confidence": number }],
  "symptoms":    [{ "value": string, "confidence": number }],
  "allergies":   [{ "value": string, "confidence": number }],
  "medications": [{ "name": string, "dosage": string|null, "frequency": string|null, "confidence": number }],
  "lab_results": [{ "test": string, "value": string, "unit": string|null, "reference_range": string|null, "flag": "NORMAL"|"HIGH"|"LOW"|"UNKNOWN", "confidence": number }],
  "doctor_name":   { "value": string, "confidence": number } | null,
  "hospital_name": { "value": string, "confidence": number } | null,
  "document_date": { "value": string, "confidence": number } | null,
  "summary": string,
  "key_findings": [string]
}`;

/** Guards against a runaway document consuming the whole context window. */
const MAX_TEXT_CHARS = 24_000;

export type ExtractionOutcome = {
  extraction: MedicalExtraction;
  model: string;
};

/**
 * Models occasionally wrap JSON in prose or fences despite instructions.
 * Recover the outermost JSON object rather than failing the whole upload.
 */
export function parseJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new DocumentProcessingError(
      "The AI response was not valid JSON.",
      "ai-extraction",
    );
  }
}

export async function extractMedicalData(opts: {
  text: string;
  documentType: string;
  /** Injected in tests so the pipeline runs without a network. */
  complete?: CompletionFn;
  /** Label recorded as provenance. Resolved from the provider when omitted. */
  model?: string;
}): Promise<ExtractionOutcome> {
  // The provider is imported lazily and ONLY when no client was injected, so
  // the `server-only` chain never enters the module graph during testing.
  let complete = opts.complete;
  let model = opts.model;

  if (!complete) {
    const provider = await import("@/lib/ai/provider");
    complete = provider.aiComplete as CompletionFn;
    // Provenance must name the model that actually ran, not a default guess —
    // otherwise document_extractions.extraction_model records a fiction.
    model ??= provider.resolveProvider().model;
  }
  model ??= "injected-client";

  const text = opts.text.slice(0, MAX_TEXT_CHARS);
  if (text.trim().length < 20) {
    throw new DocumentProcessingError(
      "This document did not contain enough readable text to analyze. Try a clearer scan.",
      "ai-extraction",
    );
  }

  const prompt = `Extract structured medical information from the document below.

The patient categorized it as: ${opts.documentType}.

Return JSON matching exactly this contract:
${OUTPUT_CONTRACT}

<document>
${text}
</document>`;


  // One retry: transient upstream failures and the occasional malformed
  // payload are both worth a second attempt before failing the upload.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await complete({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        maxTokens: 6000,
        // Provider-enforced JSON removes an entire class of failure: the model
        // can no longer wrap its answer in prose or a markdown fence.
        json: true,
      });

      const parsed = medicalExtraction.safeParse(parseJsonPayload(raw));
      if (!parsed.success) {
        throw new DocumentProcessingError(
          `The AI response did not match the expected structure: ${
            parsed.error.issues[0]?.message ?? "unknown field error"
          }`,
          "ai-extraction",
        );
      }

      return { extraction: parsed.data, model };
    } catch (error) {
      lastError = error;
      // A configuration problem will never resolve itself on retry.
      if (error instanceof Error && error.name === "AiNotConfiguredError") throw error;
    }
  }

  if (lastError instanceof DocumentProcessingError) throw lastError;
  throw new DocumentProcessingError(
    "The AI extraction service could not process this document.",
    "ai-extraction",
    lastError,
  );
}

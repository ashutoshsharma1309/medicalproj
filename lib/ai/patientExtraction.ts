import Anthropic from "@anthropic-ai/sdk";
import { aiAvailable, CLINICAL_SYSTEM, MODEL } from "./client";
import { deterministicExtract, type Extraction } from "./extraction";

/**
 * Phase 2 — extraction for patient-uploaded documents (PDF / JPG / PNG / TXT).
 *
 * Adds demographic fields, doctor details, important dates and a confidence
 * score on top of the clinical extraction. Binary formats require the LLM
 * (vision / native PDF reading); plain text falls back to the deterministic
 * parser so the flow works without an API key.
 */

export type PatientExtraction = Extraction & {
  age: number | null;
  gender: string | null;
  bloodGroup: string | null;
  doctors: string[];
  importantDates: { date: string; event: string }[];
};

export type PatientExtractionResult = {
  extraction: PatientExtraction | null;
  confidence: number | null; // 0–1
  engine: string;
  status: "EXTRACTED" | "UNAVAILABLE" | "FAILED";
  message?: string;
};

const PATIENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "patientName", "age", "gender", "bloodGroup", "documentType",
    "conditions", "symptoms", "allergies", "medications", "labValues",
    "riskFactors", "keyFindings", "doctors", "importantDates", "summary", "confidence",
  ],
  properties: {
    patientName: { type: ["string", "null"] },
    age: { type: ["integer", "null"] },
    gender: { type: ["string", "null"] },
    bloodGroup: { type: ["string", "null"] },
    documentType: {
      type: "string",
      enum: ["lab_report", "prescription", "discharge_summary", "referral", "other"],
    },
    conditions: { type: "array", items: { type: "string" } },
    symptoms: { type: "array", items: { type: "string" } },
    allergies: { type: "array", items: { type: "string" } },
    medications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "dose", "frequency"],
        properties: {
          name: { type: "string" },
          dose: { type: ["string", "null"] },
          frequency: { type: ["string", "null"] },
        },
      },
    },
    labValues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["analyte", "value", "unit", "refLow", "refHigh", "flag"],
        properties: {
          analyte: { type: "string" },
          value: { type: "number" },
          unit: { type: "string" },
          refLow: { type: ["number", "null"] },
          refHigh: { type: ["number", "null"] },
          flag: { type: ["string", "null"], enum: ["H", "L", null] },
        },
      },
    },
    riskFactors: { type: "array", items: { type: "string" } },
    keyFindings: { type: "array", items: { type: "string" } },
    doctors: { type: "array", items: { type: "string" } },
    importantDates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "event"],
        properties: { date: { type: "string" }, event: { type: "string" } },
      },
    },
    summary: { type: "string" },
    confidence: { type: "number" },
  },
};

const PROMPT = `Extract structured patient information from this medical document.

Rules:
- Only extract facts literally present in the document — never infer or invent.
- "age": as stated, or computed from a date of birth if one is present; otherwise null.
- "bloodGroup": one of A+/A-/B+/B-/AB+/AB-/O+/O- if stated; otherwise null.
- "doctors": names of clinicians mentioned (prescriber, reviewer, referrer).
- "importantDates": clinically relevant dates (visit, collection, admission, follow-up) as ISO strings where possible, each with a short label.
- "confidence": your 0–1 confidence that the extraction is complete and correct for this document (lower for poor scans or ambiguous text).
- "summary": 2–3 sentences a patient could understand.`;

function client(): Anthropic {
  return new Anthropic();
}

/** Extraction for binary uploads (PDF or image), via Claude native document/vision input. */
export async function extractFromFile(opts: {
  base64: string;
  mediaType: string; // application/pdf | image/jpeg | image/png
}): Promise<PatientExtractionResult> {
  if (!aiAvailable()) {
    return {
      extraction: null,
      confidence: null,
      engine: "none",
      status: "UNAVAILABLE",
      message:
        "AI extraction for scanned documents requires the platform's AI layer (ANTHROPIC_API_KEY). Your document is stored safely — you can enter the details manually, or extraction can be re-run once AI is enabled.",
    };
  }

  const block =
    opts.mediaType === "application/pdf"
      ? {
          type: "document" as const,
          source: { type: "base64" as const, media_type: "application/pdf" as const, data: opts.base64 },
        }
      : {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: opts.mediaType as "image/jpeg" | "image/png",
            data: opts.base64,
          },
        };

  try {
    const params = {
      model: MODEL,
      max_tokens: 6000,
      system: CLINICAL_SYSTEM,
      output_config: { format: { type: "json_schema", schema: PATIENT_SCHEMA } },
      messages: [{ role: "user" as const, content: [block, { type: "text" as const, text: PROMPT }] }],
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;
    const response = await client().messages.create(params);
    if (response.stop_reason === "refusal") {
      return {
        extraction: null,
        confidence: null,
        engine: MODEL,
        status: "FAILED",
        message: "The AI engine declined to process this document. Enter the details manually.",
      };
    }
    const text = response.content.find((b) => b.type === "text");
    if (!text) throw new Error("Empty model response");
    const parsed = JSON.parse(text.text) as PatientExtraction & { confidence: number };
    const { confidence, ...extraction } = parsed;
    return {
      extraction: extraction as PatientExtraction,
      confidence: clamp01(confidence),
      engine: MODEL,
      status: "EXTRACTED",
    };
  } catch (e) {
    return {
      extraction: null,
      confidence: null,
      engine: MODEL,
      status: "FAILED",
      message: e instanceof Error ? e.message : "Extraction failed.",
    };
  }
}

/** Extraction for plain-text uploads — works with or without the AI layer. */
export async function extractFromText(rawText: string): Promise<PatientExtractionResult> {
  if (aiAvailable()) {
    // Reuse the file path with a text block through the same schema.
    try {
      const params = {
        model: MODEL,
        max_tokens: 6000,
        system: CLINICAL_SYSTEM,
        output_config: { format: { type: "json_schema", schema: PATIENT_SCHEMA } },
        messages: [
          { role: "user" as const, content: `${PROMPT}\n\n<document>\n${rawText.slice(0, 30000)}\n</document>` },
        ],
      } as unknown as Anthropic.MessageCreateParamsNonStreaming;
      const response = await client().messages.create(params);
      const text = response.content.find((b) => b.type === "text");
      if (!text) throw new Error("Empty model response");
      const parsed = JSON.parse(text.text) as PatientExtraction & { confidence: number };
      const { confidence, ...extraction } = parsed;
      return {
        extraction: extraction as PatientExtraction,
        confidence: clamp01(confidence),
        engine: MODEL,
        status: "EXTRACTED",
      };
    } catch {
      /* fall through to deterministic */
    }
  }

  const base = deterministicExtract(rawText);
  const enriched = enrichDeterministic(base, rawText);
  return {
    extraction: enriched,
    confidence: deterministicConfidence(enriched),
    engine: "deterministic-parser-v1",
    status: "EXTRACTED",
  };
}

/* --------- deterministic enrichment for the extra patient fields --------- */

function enrichDeterministic(base: Extraction, rawText: string): PatientExtraction {
  const bloodMatch = rawText.match(/blood\s*(?:group|type)\s*[:\-]?\s*(A|B|AB|O)\s*([+-]|pos|neg)?/i);
  const ageMatch = rawText.match(/\bage\s*[:\-]?\s*(\d{1,3})\b/i);
  const dobMatch = rawText.match(/(?:dob|date of birth)\s*[:\-]?\s*([0-9]{1,2}[\/-][0-9]{1,2}[\/-][0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i);
  const genderMatch = rawText.match(/\b(?:sex|gender)\s*[:\-]?\s*(male|female|m\b|f\b)/i);
  const doctors = [...new Set([...rawText.matchAll(/\bDr\.?\s+([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)?)/g)].map((m) => `Dr. ${m[1]}`))];

  let age: number | null = ageMatch ? parseInt(ageMatch[1], 10) : null;
  const importantDates: { date: string; event: string }[] = [];
  if (dobMatch) {
    importantDates.push({ date: dobMatch[1], event: "Date of birth" });
    if (age === null) {
      const dob = new Date(dobMatch[1]);
      if (!isNaN(dob.getTime())) age = Math.floor((Date.now() - dob.getTime()) / 31557600000);
    }
  }
  const collected = rawText.match(/(?:collected|date of visit|visit date|report date)\s*[:\-]?\s*([A-Za-z0-9 ,\/-]{6,24})/i);
  if (collected) importantDates.push({ date: collected[1].trim(), event: "Document date" });

  let bloodGroup: string | null = null;
  if (bloodMatch) {
    const sign = bloodMatch[2] === "pos" ? "+" : bloodMatch[2] === "neg" ? "-" : (bloodMatch[2] ?? "");
    bloodGroup = `${bloodMatch[1].toUpperCase()}${sign}`;
  }

  return {
    ...base,
    age,
    gender: genderMatch ? (genderMatch[1].toLowerCase().startsWith("f") ? "Female" : "Male") : null,
    bloodGroup,
    doctors,
    importantDates,
  };
}

function deterministicConfidence(e: PatientExtraction): number {
  let hits = 0;
  let total = 8;
  if (e.patientName) hits++;
  if (e.age !== null) hits++;
  if (e.bloodGroup) hits++;
  if (e.conditions.length) hits++;
  if (e.medications.length) hits++;
  if (e.labValues.length) hits++;
  if (e.allergies.length) hits++;
  if (e.doctors.length) hits++;
  // rule parser is precise on what it does find; base floor of 0.35
  return Math.round((0.35 + 0.6 * (hits / total)) * 100) / 100;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0.5));

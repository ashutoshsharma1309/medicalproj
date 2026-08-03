import { z } from "zod";

/**
 * The extraction contract.
 *
 * Every clinically meaningful field carries its own confidence score, because
 * a document that yields a crisp "Metformin 500mg" and a smudged blood group
 * should not be trusted uniformly. The review UI sorts by this, and anything
 * below REVIEW_THRESHOLD is surfaced for explicit patient attention.
 */

export const REVIEW_THRESHOLD = 0.7;

const confidence = z.number().min(0).max(1);

/** A single extracted value plus how sure the model was about it. */
export const scoredString = z.object({
  value: z.string().trim().min(1).max(300),
  confidence,
});
export type ScoredString = z.infer<typeof scoredString>;

export const extractedMedication = z.object({
  name: z.string().trim().min(1).max(200),
  dosage: z.string().trim().max(120).nullable(),
  frequency: z.string().trim().max(120).nullable(),
  confidence,
});
export type ExtractedMedication = z.infer<typeof extractedMedication>;

export const extractedLabResult = z.object({
  test: z.string().trim().min(1).max(200),
  value: z.string().trim().max(80),
  unit: z.string().trim().max(60).nullable(),
  reference_range: z.string().trim().max(120).nullable(),
  /** Model's read of whether the value sits outside the reference range. */
  flag: z.enum(["NORMAL", "HIGH", "LOW", "UNKNOWN"]).default("UNKNOWN"),
  confidence,
});
export type ExtractedLabResult = z.infer<typeof extractedLabResult>;

/**
 * The full structured payload. Grok is instructed to return exactly this
 * shape; anything else is rejected before it reaches the database.
 */
export const medicalExtraction = z.object({
  patient_name: scoredString.nullable(),
  age: z
    .object({ value: z.number().int().min(0).max(130), confidence })
    .nullable(),
  gender: z
    .object({
      value: z.enum(["FEMALE", "MALE", "OTHER", "UNKNOWN"]),
      confidence,
    })
    .nullable(),
  blood_group: z
    .object({
      value: z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "UNKNOWN"]),
      confidence,
    })
    .nullable(),

  conditions: z.array(scoredString).max(60).default([]),
  symptoms: z.array(scoredString).max(60).default([]),
  allergies: z.array(scoredString).max(60).default([]),
  medications: z.array(extractedMedication).max(80).default([]),
  lab_results: z.array(extractedLabResult).max(120).default([]),

  doctor_name: scoredString.nullable(),
  hospital_name: scoredString.nullable(),
  /** ISO-8601 date of the document itself, when stated. */
  document_date: scoredString.nullable(),

  /**
   * Plain-language summary for the patient. Prompted to observe and refer,
   * never to diagnose — see enforceNoDiagnosis().
   */
  summary: z.string().trim().max(1200),
  key_findings: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
});

export type MedicalExtraction = z.infer<typeof medicalExtraction>;

/* ------------------------------------------------------------------ Review */

export type ReviewItemKind = "CONDITION" | "MEDICATION" | "ALLERGY" | "LAB_RESULT";

/**
 * One reviewable row in the verification UI. Flattens the extraction into a
 * uniform shape so the review screen does not branch per category.
 */
export type ReviewItem = {
  /** Stable within a single extraction; used as the form field key. */
  id: string;
  kind: ReviewItemKind;
  /** What the patient reads, e.g. "Metformin 500mg — twice daily". */
  label: string;
  confidence: number;
  needsAttention: boolean;
  /** Structured payload preserved for writing patient_medical_records. */
  detail: {
    condition?: string;
    medication?: string;
    allergy?: string;
    test_name?: string;
    test_value?: string;
    test_unit?: string | null;
    reference_range?: string | null;
  };
};

export type ReviewDecision = "CONFIRM" | "REJECT";

/** What the review form posts back for each item. */
export type ReviewSubmission = {
  id: string;
  decision: ReviewDecision;
  /** Patient-corrected label; when present it supersedes the extracted value. */
  editedLabel?: string;
};

/* ------------------------------------------------------- Pipeline plumbing */

export type TextSource = "pdf-text" | "ocr-tesseract" | "ocr-vision";

export type ExtractedText = {
  text: string;
  source: TextSource;
  /** OCR engines report their own confidence; PDF text extraction does not. */
  ocrConfidence: number | null;
};

export class DocumentProcessingError extends Error {
  constructor(
    message: string,
    readonly stage: "storage" | "text-extraction" | "ai-extraction" | "persistence",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DocumentProcessingError";
  }
}

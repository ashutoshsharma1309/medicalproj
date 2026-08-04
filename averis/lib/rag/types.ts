/**
 * Retrieval-augmented generation types.
 */

export type KnowledgeSourceType = "PATIENT_DOCUMENT" | "MEDICAL_KNOWLEDGE";

export type KnowledgeCategory =
  | "LAB_REFERENCE"
  | "CONDITION"
  | "MEDICATION"
  | "PROCEDURE"
  | "GENERAL_HEALTH";

/** A chunk returned by the similarity search. */
export type RetrievedChunk = {
  id: string;
  sourceType: KnowledgeSourceType;
  documentId: string | null;
  knowledgeDocumentId: string | null;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown>;
  /** Cosine similarity in [0, 1]. Vectors are normalised, so this is exact. */
  similarity: number;
};

/**
 * A source shown to the patient.
 *
 * Every answer names these. An explanation a patient cannot trace back to a
 * document is indistinguishable from one the model invented.
 */
export type AnswerSource = {
  kind: KnowledgeSourceType;
  /** "Blood Report — 12 March 2026" or "HbA1c reference ranges". */
  label: string;
  /** Deep link to the patient's own document, where one exists. */
  href?: string;
  /** Where a knowledge claim comes from. */
  citation?: string;
  similarity: number;
};

export type GroundedAnswer = {
  question: string;
  answer: string;
  sources: AnswerSource[];
  /** True when nothing in the record was relevant enough to answer from. */
  abstained: boolean;
  /** Set when the guardrail rewrote a drifting answer. */
  guardrailTriggered: boolean;
  /** The model that phrased it, or "deterministic" when none was available. */
  generatedBy: string;
  /** Never optional. */
  disclaimer: string;
};

export const DISCLAIMER =
  "This information is for awareness and should not replace professional medical advice.";

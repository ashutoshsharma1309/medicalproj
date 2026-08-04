import type { AnswerSource, RetrievedChunk } from "./types";

/**
 * Turning retrieved chunks into a prompt context and a citation list.
 *
 * Pure. This is the last point at which what the model will be told is still
 * inspectable, so the whole of it is testable without a database or a network.
 *
 * Three rules shape the output.
 *
 * **A weak match is worse than no match.** A chunk retrieved at 0.15 cosine
 * similarity is noise, and putting it in the prompt invites the model to
 * build an answer on it. Below the floor the context is empty and the caller
 * abstains rather than guessing.
 *
 * **Patient context comes first.** When a patient asks "what does my HbA1c
 * mean", the reading in their own report is the subject and the reference
 * range is the explanation. Ordering by raw similarity would sometimes put
 * the textbook above the patient.
 *
 * **Every chunk is labelled with its origin.** The model is told which
 * fragments are the patient's own record and which are general reference, so
 * it cannot present a textbook range as something measured about them.
 */

/** Below this a match is noise rather than a weak signal. */
export const RELEVANCE_FLOOR = 0.25;

/** Patient chunks admitted at a lower bar — their own record is the subject. */
export const PATIENT_RELEVANCE_FLOOR = 0.18;

/** Keeps the prompt inside a sane budget regardless of what came back. */
const MAX_CONTEXT_CHARS = 6000;

export type BuiltContext = {
  /** The text block handed to the model. Empty when nothing was relevant. */
  context: string;
  sources: AnswerSource[];
  chunks: RetrievedChunk[];
  /** True when nothing cleared the floor. */
  empty: boolean;
};

export type SourceLabeller = (chunk: RetrievedChunk) => {
  label: string;
  href?: string;
  citation?: string;
};

export function buildContext(
  retrieved: RetrievedChunk[],
  label: SourceLabeller,
): BuiltContext {
  const relevant = retrieved.filter((chunk) =>
    chunk.sourceType === "PATIENT_DOCUMENT"
      ? chunk.similarity >= PATIENT_RELEVANCE_FLOOR
      : chunk.similarity >= RELEVANCE_FLOOR,
  );

  if (relevant.length === 0) {
    return { context: "", sources: [], chunks: [], empty: true };
  }

  const ordered = [...relevant].sort((a, b) => {
    const aPatient = a.sourceType === "PATIENT_DOCUMENT" ? 1 : 0;
    const bPatient = b.sourceType === "PATIENT_DOCUMENT" ? 1 : 0;
    if (aPatient !== bPatient) return bPatient - aPatient;
    return b.similarity - a.similarity;
  });

  const included: RetrievedChunk[] = [];
  const blocks: string[] = [];
  let budget = MAX_CONTEXT_CHARS;

  for (const chunk of ordered) {
    const origin =
      chunk.sourceType === "PATIENT_DOCUMENT"
        ? "PATIENT RECORD"
        : "MEDICAL REFERENCE";
    const { label: name } = label(chunk);
    const block = `[${origin} — ${name}]\n${chunk.content}`;

    if (block.length > budget) break;

    blocks.push(block);
    included.push(chunk);
    budget -= block.length;
  }

  if (included.length === 0) {
    return { context: "", sources: [], chunks: [], empty: true };
  }

  return {
    context: blocks.join("\n\n"),
    sources: dedupeSources(included, label),
    chunks: included,
    empty: false,
  };
}

/**
 * One entry per source document, not per chunk.
 *
 * Four chunks from the same blood report are one source to a patient, and
 * listing it four times reads as four pieces of corroborating evidence.
 */
function dedupeSources(chunks: RetrievedChunk[], label: SourceLabeller): AnswerSource[] {
  const byKey = new Map<string, AnswerSource>();

  for (const chunk of chunks) {
    const key = chunk.documentId ?? chunk.knowledgeDocumentId ?? chunk.id;
    const existing = byKey.get(key);

    if (existing) {
      // Keep the strongest match as the representative similarity.
      existing.similarity = Math.max(existing.similarity, chunk.similarity);
      continue;
    }

    const { label: name, href, citation } = label(chunk);
    byKey.set(key, {
      kind: chunk.sourceType,
      label: name,
      href,
      citation,
      similarity: chunk.similarity,
    });
  }

  return [...byKey.values()].sort((a, b) => {
    const aPatient = a.kind === "PATIENT_DOCUMENT" ? 1 : 0;
    const bPatient = b.kind === "PATIENT_DOCUMENT" ? 1 : 0;
    if (aPatient !== bPatient) return bPatient - aPatient;
    return b.similarity - a.similarity;
  });
}

/** True when the context contains nothing from the patient's own record. */
export function isKnowledgeOnly(context: BuiltContext): boolean {
  return (
    !context.empty && context.chunks.every((c) => c.sourceType === "MEDICAL_KNOWLEDGE")
  );
}

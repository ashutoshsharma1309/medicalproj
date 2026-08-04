import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { formatDate } from "@/lib/utils/format";
import { generateAnswer } from "./answer-service";
import { buildContext, type SourceLabeller } from "./context-builder";
import { chunksForDocument, retrieveBalanced } from "./retrieval-service";
import { DISCLAIMER, type GroundedAnswer, type RetrievedChunk } from "./types";

/**
 * Question answering over a patient's own record.
 *
 * The whole flow in one place: retrieve, build context, generate, cite, store.
 *
 * Note what is *not* here — any filtering by patient. Retrieval is scoped by
 * the RLS policy inside `match_knowledge`, and re-checking ownership in this
 * file would be a second copy of that rule. Two copies of an authorization
 * rule is not twice the safety; it is one rule and one thing that can drift
 * out of agreement with it while still looking correct.
 */

/** Long enough to be a question, short enough not to be a prompt injection. */
const MAX_QUESTION_CHARS = 500;

export async function askAveris(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
  rawQuestion: string,
): Promise<GroundedAnswer> {
  const question = rawQuestion.trim().slice(0, MAX_QUESTION_CHARS);

  if (question.length < 3) {
    return {
      question,
      answer: "Ask a question about your health records and AVERIS will look for the answer in them.",
      sources: [],
      abstained: true,
      guardrailTriggered: false,
      generatedBy: "deterministic",
      disclaimer: DISCLAIMER,
    };
  }

  const retrieved = await retrieveBalanced(supabase, question);
  const context = buildContext(retrieved, await sourceLabeller(supabase, retrieved));
  const answer = await generateAnswer(question, context);

  // Storing must not cost the patient their answer.
  try {
    await storeConversation(supabase, patientProfileId, answer);
  } catch {
    /* history is best-effort */
  }

  return answer;
}

/**
 * Explains one report.
 *
 * Differs from a question in what it retrieves: the report's own chunks are
 * taken whole and in order rather than by similarity, because the patient
 * asked about *this document* and a similarity search over it would silently
 * drop the sections that happen to be phrased unusually.
 *
 * Reference material is still retrieved by similarity, keyed on the report's
 * own text, so the terms it actually contains are what get explained.
 */
export async function explainReport(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
  documentId: string,
  documentLabel: string,
): Promise<GroundedAnswer> {
  const own = await chunksForDocument(supabase, documentId);

  if (own.length === 0) {
    return {
      question: `Explain ${documentLabel}`,
      answer:
        "This report has not been indexed yet, so AVERIS cannot explain it. " +
        "Documents are indexed once their text has been extracted.",
      sources: [],
      abstained: true,
      guardrailTriggered: false,
      generatedBy: "deterministic",
      disclaimer: DISCLAIMER,
    };
  }

  // Key the reference lookup on the report's own text — those are the terms
  // that need explaining.
  const probe = own
    .map((chunk) => chunk.content)
    .join("\n")
    .slice(0, 1200);

  const reference = await retrieveBalanced(supabase, probe, {
    patientLimit: 0,
    knowledgeLimit: 4,
  });

  const combined = [...own, ...reference.filter((c) => c.sourceType === "MEDICAL_KNOWLEDGE")];
  const context = buildContext(combined, await sourceLabeller(supabase, combined));

  const question =
    `Explain ${documentLabel} in plain language. Say what the tests measure and what the ` +
    `reference ranges printed on it mean, without judging the patient's values.`;

  const answer = await generateAnswer(question, context);

  try {
    await storeConversation(supabase, patientProfileId, answer);
  } catch {
    /* history is best-effort */
  }

  return answer;
}

/* ------------------------------------------------------------- labelling */

/**
 * Builds a labeller that names each chunk's source for the patient.
 *
 * Document titles are fetched in one query rather than per chunk. Chunk
 * metadata usually carries the file name already, so this is a fallback for
 * rows indexed before that metadata existed — and it is a single round trip
 * either way.
 */
async function sourceLabeller(
  supabase: SupabaseClient<Database>,
  chunks: RetrievedChunk[],
): Promise<SourceLabeller> {
  const knowledgeIds = [
    ...new Set(chunks.map((c) => c.knowledgeDocumentId).filter(Boolean) as string[]),
  ];

  const citations = new Map<string, { title: string; citation: string }>();

  if (knowledgeIds.length > 0) {
    const { data } = await supabase
      .from("knowledge_documents")
      .select("id, title, citation")
      .in("id", knowledgeIds);

    for (const row of data ?? []) {
      citations.set(row.id, { title: row.title, citation: row.citation });
    }
  }

  return (chunk) => {
    if (chunk.sourceType === "MEDICAL_KNOWLEDGE") {
      const entry = chunk.knowledgeDocumentId
        ? citations.get(chunk.knowledgeDocumentId)
        : undefined;
      const meta = chunk.metadata as { title?: string; citation?: string };
      return {
        label: entry?.title ?? meta.title ?? "Medical reference",
        citation: entry?.citation ?? meta.citation,
      };
    }

    const meta = chunk.metadata as { fileName?: string; recordDate?: string | null };
    const name = meta.fileName ?? "Your document";
    const when = meta.recordDate ? ` — ${formatDate(meta.recordDate)}` : "";

    return {
      label: `${name}${when}`,
      href: chunk.documentId ? `/records/${chunk.documentId}` : undefined,
    };
  };
}

/* -------------------------------------------------------------- history */

async function storeConversation(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
  answer: GroundedAnswer,
): Promise<void> {
  const { error } = await supabase.from("ai_conversations").insert({
    patient_id: patientProfileId,
    question: answer.question,
    response: answer.answer,
    // Stored so the citation a patient saw can be reproduced later, rather
    // than re-derived from a corpus that may since have changed.
    sources_used: answer.sources,
  });

  if (error) throw new Error(error.message);
}

export type ConversationRecord = {
  id: string;
  question: string;
  response: string;
  sources: { label: string; kind: string; href?: string; citation?: string }[];
  createdAt: string;
};

export async function listConversations(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
  limit = 10,
): Promise<ConversationRecord[]> {
  const { data, error } = await supabase
    .from("ai_conversations")
    .select("id, question, response, sources_used, created_at")
    .eq("patient_id", patientProfileId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Could not read your question history: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    question: row.question,
    response: row.response,
    sources: Array.isArray(row.sources_used)
      ? (row.sources_used as ConversationRecord["sources"])
      : [],
    createdAt: row.created_at,
  }));
}

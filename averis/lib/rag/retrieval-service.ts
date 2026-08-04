import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { embedOne, toVectorLiteral } from "./embedding-service";
import type { KnowledgeSourceType, RetrievedChunk } from "./types";

/**
 * Similarity search.
 *
 * The search runs through `match_knowledge`, a SECURITY INVOKER function, so
 * the caller's RLS policies apply inside the ORDER BY. This file therefore
 * does *not* filter by patient — not because it forgot, but because doing so
 * would be the second copy of a rule that already lives in the database, and
 * the copy that drifts is always the one in application code.
 *
 * What this file is responsible for is over-fetching. With an approximate
 * index and an RLS predicate, Postgres can take k candidates from the index
 * and then discard some of them to the policy, returning fewer than asked.
 * Requesting a multiple of what we need means growing the corpus cannot
 * quietly start starving the context.
 */

/** How much to over-fetch, to absorb post-filtering losses. */
const OVERFETCH = 3;

export type RetrievalOptions = {
  limit?: number;
  /** Restrict to one side of the corpus. Omit for both. */
  sourceType?: KnowledgeSourceType;
};

export async function retrieve(
  supabase: SupabaseClient<Database>,
  query: string,
  options: RetrievalOptions = {},
): Promise<RetrievedChunk[]> {
  const limit = options.limit ?? 8;
  const embedding = await embedOne(query);

  const { data, error } = await supabase.rpc("match_knowledge", {
    query_embedding: toVectorLiteral(embedding),
    match_count: limit * OVERFETCH,
    filter_source: options.sourceType ?? undefined,
  });

  if (error) throw new Error(`Retrieval failed: ${error.message}`);

  return (data ?? [])
    .map(toChunk)
    .slice(0, limit);
}

/**
 * Retrieves from both halves of the corpus with a guaranteed share each.
 *
 * A single ranked query does not do this. Ask "what does my HbA1c mean" and
 * the reference article about HbA1c can out-score the patient's own report on
 * pure similarity, filling every slot with textbook material and answering a
 * question about *them* with nothing about them in it.
 *
 * So each side is retrieved separately and merged. The patient's record is
 * the subject of the question; the reference is the explanation.
 */
export async function retrieveBalanced(
  supabase: SupabaseClient<Database>,
  query: string,
  options: { patientLimit?: number; knowledgeLimit?: number } = {},
): Promise<RetrievedChunk[]> {
  const [patient, knowledge] = await Promise.all([
    retrieve(supabase, query, {
      limit: options.patientLimit ?? 5,
      sourceType: "PATIENT_DOCUMENT",
    }),
    retrieve(supabase, query, {
      limit: options.knowledgeLimit ?? 3,
      sourceType: "MEDICAL_KNOWLEDGE",
    }),
  ]);

  return [...patient, ...knowledge];
}

/** Chunks belonging to one document, in order. Used by the report explainer. */
export async function chunksForDocument(
  supabase: SupabaseClient<Database>,
  documentId: string,
): Promise<RetrievedChunk[]> {
  const { data, error } = await supabase
    .from("knowledge_embeddings")
    .select("id, source_type, document_id, knowledge_document_id, chunk_index, content, metadata")
    .eq("document_id", documentId)
    .order("chunk_index", { ascending: true });

  if (error) throw new Error(`Could not read the indexed report: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    sourceType: row.source_type as KnowledgeSourceType,
    documentId: row.document_id,
    knowledgeDocumentId: row.knowledge_document_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    // Not a search result; there is no query to be similar to.
    similarity: 1,
  }));
}

type MatchRow = {
  id: string;
  source_type: string;
  document_id: string | null;
  knowledge_document_id: string | null;
  chunk_index: number;
  content: string;
  metadata: unknown;
  similarity: number;
};

function toChunk(row: MatchRow): RetrievedChunk {
  return {
    id: row.id,
    sourceType: row.source_type as KnowledgeSourceType,
    documentId: row.document_id,
    knowledgeDocumentId: row.knowledge_document_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    similarity: Number(row.similarity),
  };
}

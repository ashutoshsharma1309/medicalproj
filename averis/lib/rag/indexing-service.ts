import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { chunkText } from "./chunking";
import { embedChunks, toVectorLiteral, type EmbedFn } from "./embedding-service";

/**
 * Indexing a patient's document into the retrievable corpus.
 *
 * Called after Phase 2 extraction succeeds, on the text that was already
 * pulled out of the file — the document is never re-read from storage, and
 * re-indexing costs an embedding pass rather than another OCR run.
 *
 * Re-indexing deletes first and inserts second. The alternative, upserting on
 * (document_id, chunk_index), leaves orphans behind whenever a re-extraction
 * produces fewer chunks than the previous run: the tail of the old version
 * stays in the index and keeps getting retrieved as though it were current.
 */

export type IndexResult = {
  documentId: string;
  chunks: number;
  skipped: boolean;
  reason?: string;
};

/** Below this there is nothing worth retrieving. */
const MIN_INDEXABLE_CHARS = 80;

export async function indexPatientDocument(
  supabase: SupabaseClient<Database>,
  input: {
    patientProfileId: string;
    documentId: string;
    text: string;
    fileName: string;
    documentType: string;
    recordDate?: string | null;
  },
  embedFn?: EmbedFn,
): Promise<IndexResult> {
  if (input.text.trim().length < MIN_INDEXABLE_CHARS) {
    return {
      documentId: input.documentId,
      chunks: 0,
      skipped: true,
      reason: "Not enough readable text to index.",
    };
  }

  const chunks = chunkText(input.text);
  if (chunks.length === 0) {
    return { documentId: input.documentId, chunks: 0, skipped: true, reason: "No chunks produced." };
  }

  const embedded = await embedChunks(chunks, embedFn);

  // Delete then insert. See the note above on orphaned tails.
  const { error: deleteError } = await supabase
    .from("knowledge_embeddings")
    .delete()
    .eq("document_id", input.documentId);

  if (deleteError) {
    throw new Error(`Could not clear the previous index: ${deleteError.message}`);
  }

  const rows = embedded.map(({ chunk, embedding }) => ({
    source_type: "PATIENT_DOCUMENT" as const,
    patient_id: input.patientProfileId,
    document_id: input.documentId,
    knowledge_document_id: null,
    chunk_index: chunk.index,
    content: chunk.content,
    embedding: toVectorLiteral(embedding),
    // Carried so a retrieved chunk can be labelled for the patient without a
    // second round trip to name the document it came from.
    metadata: {
      fileName: input.fileName,
      documentType: input.documentType,
      recordDate: input.recordDate ?? null,
    },
  }));

  const { error: insertError } = await supabase
    .from("knowledge_embeddings")
    .insert(rows as never);

  if (insertError) {
    throw new Error(`Could not index this document: ${insertError.message}`);
  }

  return { documentId: input.documentId, chunks: rows.length, skipped: false };
}

/** Removes a document's chunks. Used when a patient deletes the document. */
export async function removeDocumentFromIndex(
  supabase: SupabaseClient<Database>,
  documentId: string,
): Promise<void> {
  const { error } = await supabase
    .from("knowledge_embeddings")
    .delete()
    .eq("document_id", documentId);

  if (error) throw new Error(`Could not remove the document from the index: ${error.message}`);
}

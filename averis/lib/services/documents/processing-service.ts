import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { downloadDocument } from "./storage-service";
import { extractDocumentText } from "./text-extraction";
import { extractMedicalData } from "./extraction-service";
import { overallConfidence, enforceNoDiagnosis } from "./review";
import { DocumentProcessingError } from "./types";

/**
 * Pipeline orchestrator.
 *
 * Owns the sequence and the status machine; delegates every actual capability
 * to a focused service:
 *
 *   storage-service  → fetch the bytes
 *   text-extraction  → PDF text layer or OCR
 *   extraction-service → structured medical extraction
 *   this file        → status transitions + persistence
 *
 *   PENDING → PROCESSING → PENDING_REVIEW
 *                       ↘ FAILED (error_message explains)
 *
 * Every query runs through the caller's RLS-scoped client, so a document that
 * is not the caller's simply is not visible to this code.
 */

export type ProcessingResult =
  | { ok: true; documentId: string; confidence: number | null }
  | { ok: false; documentId: string; error: string };

export async function processDocument(
  supabase: SupabaseClient<Database>,
  documentId: string,
): Promise<ProcessingResult> {
  const { data: document, error: fetchError } = await supabase
    .from("medical_documents")
    .select("id, file_path, mime_type, document_type, upload_status")
    .eq("id", documentId)
    .maybeSingle();

  if (fetchError || !document) {
    return { ok: false, documentId, error: "Document not found." };
  }

  await supabase
    .from("medical_documents")
    .update({ upload_status: "PROCESSING", error_message: null })
    .eq("id", documentId);

  try {
    // 1. Bytes
    const bytes = await downloadDocument(supabase, document.file_path);

    // 2. Text (PDF text layer, or OCR for images and scanned PDFs)
    const extractedText = await extractDocumentText(bytes, document.mime_type);

    // 3. Structured medical extraction
    const { extraction, model } = await extractMedicalData({
      text: extractedText.text,
      documentType: document.document_type,
    });

    // 4. Guardrail: patient-facing prose must never read as a diagnosis.
    const { summary } = enforceNoDiagnosis(extraction.summary);
    const safeExtraction = { ...extraction, summary };

    const confidence = overallConfidence(safeExtraction);

    // 5. Persist. upsert keyed on the unique document_id so reprocessing a
    // document replaces its extraction rather than duplicating it.
    const { error: writeError } = await supabase.from("document_extractions").upsert(
      {
        document_id: documentId,
        extracted_text: extractedText.text.slice(0, 100_000),
        extracted_data: safeExtraction,
        confidence_score: confidence,
        extraction_model: model,
        text_source: extractedText.source,
      },
      { onConflict: "document_id" },
    );

    if (writeError) {
      throw new DocumentProcessingError(
        "We could not save the extracted information.",
        "persistence",
        writeError,
      );
    }

    await supabase
      .from("medical_documents")
      .update({ upload_status: "PENDING_REVIEW" })
      .eq("id", documentId);

    return { ok: true, documentId, confidence };
  } catch (error) {
    const message =
      error instanceof DocumentProcessingError
        ? error.message
        : "We could not process this document.";

    await supabase
      .from("medical_documents")
      .update({ upload_status: "FAILED", error_message: message })
      .eq("id", documentId);

    return { ok: false, documentId, error: message };
  }
}

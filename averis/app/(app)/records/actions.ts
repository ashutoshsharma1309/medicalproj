"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { rateLimitStore } from "@/lib/security/rate-limit-store";
import { documentQuota } from "@/lib/plans/entitlements";
import { recordAudit } from "@/lib/audit/audit-service";
import { invalidatePatient } from "@/lib/cache/cache";
import {
  buildStoragePath,
  uploadDocument,
  removeDocument,
  validateUpload,
} from "@/lib/services/documents/storage-service";
import { processDocument } from "@/lib/services/documents/processing-service";
import { refreshDigitalTwin } from "@/lib/services/twin/digital-twin-service";
import { buildReviewItems } from "@/lib/services/documents/review";
import {
  buildReconciliationPlan,
  mergeList,
} from "@/lib/services/documents/reconciliation";
import type {
  MedicalExtraction,
  ReviewSubmission,
} from "@/lib/services/documents/types";
import type { DocumentType } from "@/lib/supabase/database.types";

/**
 * API layer for the document pipeline.
 *
 * Every action re-establishes the session and the caller's patient profile
 * before touching anything. Server Actions are POSTs to their host route, so
 * proxy coverage is never treated as sufficient. Row Level Security is the
 * backstop: even a logic slip here cannot reach another patient's data.
 */

const DOCUMENT_TYPES: DocumentType[] = [
  "BLOOD_REPORT",
  "LAB_RESULT",
  "HEALTH_CHECKUP",
  "PRESCRIPTION",
  "DISCHARGE_SUMMARY",
  "DIAGNOSIS_REPORT",
  "CONSULTATION_NOTE",
  "OTHER",
];

export type UploadState = {
  error: string | null;
  documentId?: string;
  status?: "PENDING_REVIEW" | "FAILED";
};

export async function uploadMedicalDocumentAction(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  const account = await requireUser();
  if (!account.patientProfileId) {
    return { error: "Complete your health profile before uploading documents." };
  }

  const file = formData.get("file");
  const rawType = String(formData.get("documentType") ?? "OTHER");
  const documentType: DocumentType = DOCUMENT_TYPES.includes(rawType as DocumentType)
    ? (rawType as DocumentType)
    : "OTHER";

  if (!(file instanceof File)) {
    return { error: "Choose a document to upload." };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const validation = validateUpload({ size: file.size, type: file.type, bytes });
  if (!validation.ok) {
    return { error: validation.error };
  }

  const supabase = await createClient();

  // Rate limit before quota: the limiter protects against a loop hammering
  // OCR, and evaluating it first means an abusive caller does not get to run
  // a COUNT query per attempt.
  const limited = await checkRateLimit(
    rateLimitStore(),
    "documentUpload",
    account.patientProfileId,
  );
  if (!limited.allowed) {
    return {
      error:
        `You have uploaded a lot of documents in a short time. ` +
        `Try again in about ${Math.ceil(limited.retryAfterMs / 60000)} minutes.`,
    };
  }

  const quota = await documentQuota(supabase, account.appUserId, account.patientProfileId);
  if (!quota.allowed) return { error: quota.message ?? "Upload limit reached." };

  const storagePath = buildStoragePath(account.patientProfileId, validation.mimeType);

  try {
    await uploadDocument(supabase, storagePath, bytes, validation.mimeType);
  } catch {
    return { error: "We could not store your document. Please try again." };
  }

  const safeName = file.name.replace(/[^\w.\-() ]/g, "_").slice(0, 160) || "document";

  const { data: document, error: insertError } = await supabase
    .from("medical_documents")
    .insert({
      patient_id: account.patientProfileId,
      file_name: safeName,
      file_path: storagePath,
      mime_type: validation.mimeType,
      file_size: file.size,
      document_type: documentType,
      upload_status: "PENDING",
    })
    .select("id")
    .single();

  if (insertError || !document) {
    // Do not leave an orphaned object behind if the row could not be written.
    await removeDocument(supabase, storagePath);
    return { error: "We could not record your upload. Please try again." };
  }

  await recordAudit(supabase, account.authUserId, {
    action: "DOCUMENT_UPLOADED",
    resourceType: "DOCUMENT",
    resourceId: document.id,
    metadata: { documentType, fileSize: file.size, mimeType: validation.mimeType },
  });

  // Enqueued for the worker, and also processed inline.
  //
  // The queue row is what makes async processing real: a worker container
  // picks it up, and the exclusion constraint means the inline pass and the
  // worker cannot both own the same document. Inline processing stays because
  // a single-container deployment has no worker, and a patient waiting on an
  // upload should not be told to come back later because of how the operator
  // chose to deploy.
  await supabase
    .from("processing_jobs")
    .insert({ patient_id: account.patientProfileId, document_id: document.id })
    // A conflict means a job already exists for this document, which is the
    // constraint doing its job rather than an error.
    .then(() => undefined, () => undefined);

  const result = await processDocument(supabase, document.id);


  revalidatePath("/records");
  revalidatePath("/dashboard");

  return result.ok
    ? { error: null, documentId: document.id, status: "PENDING_REVIEW" }
    : { error: result.error, documentId: document.id, status: "FAILED" };
}

export async function reprocessDocumentAction(documentId: string): Promise<UploadState> {
  const account = await requireUser();
  if (!account.patientProfileId) return { error: "Complete your health profile first." };

  const supabase = await createClient();

  // Ownership check in application code as well as RLS.
  const { data: document } = await supabase
    .from("medical_documents")
    .select("id, patient_id")
    .eq("id", documentId)
    .maybeSingle();

  if (!document || document.patient_id !== account.patientProfileId) {
    return { error: "Document not found." };
  }

  const result = await processDocument(supabase, documentId);
  revalidatePath("/records");
  revalidatePath(`/records/${documentId}`);

  return result.ok
    ? { error: null, documentId, status: "PENDING_REVIEW" }
    : { error: result.error, documentId, status: "FAILED" };
}

export type ConfirmState = {
  error: string | null;
  confirmed?: number;
  rejected?: number;
};

/**
 * The verification step. Nothing an extraction produced reaches the patient's
 * health profile until it arrives here with an explicit CONFIRM decision.
 */
export async function confirmExtractionAction(
  documentId: string,
  submissions: ReviewSubmission[],
): Promise<ConfirmState> {
  const account = await requireUser();
  if (!account.patientProfileId) return { error: "Complete your health profile first." };

  const supabase = await createClient();

  const { data: document } = await supabase
    .from("medical_documents")
    .select("id, patient_id, upload_status")
    .eq("id", documentId)
    .maybeSingle();

  if (!document || document.patient_id !== account.patientProfileId) {
    return { error: "Document not found." };
  }

  const { data: extraction } = await supabase
    .from("document_extractions")
    .select("extracted_data")
    .eq("document_id", documentId)
    .maybeSingle();

  if (!extraction) {
    return { error: "This document has no extracted information to review." };
  }

  const items = buildReviewItems(extraction.extracted_data as MedicalExtraction);

  const { data: profile } = await supabase
    .from("patient_health_information")
    .select("allergies, existing_conditions, current_medications")
    .eq("patient_id", account.patientProfileId)
    .maybeSingle();

  const existing = {
    conditions: profile?.existing_conditions ?? [],
    medications: profile?.current_medications ?? [],
    allergies: profile?.allergies ?? [],
  };

  const plan = buildReconciliationPlan(items, submissions, existing);

  if (plan.records.length > 0) {
    const { error: recordsError } = await supabase.from("patient_medical_records").insert(
      plan.records.map((record) => ({
        ...record,
        patient_id: account.patientProfileId!,
        source_document_id: documentId,
      })),
    );
    if (recordsError) {
      return { error: "We could not save the confirmed information. Please try again." };
    }
  }

  // Additive merge — confirming a document never removes anything the patient
  // entered themselves.
  const hasProfileAdditions =
    plan.profileAdditions.conditions.length > 0 ||
    plan.profileAdditions.medications.length > 0 ||
    plan.profileAdditions.allergies.length > 0;

  if (hasProfileAdditions) {
    const { error: profileError } = await supabase
      .from("patient_health_information")
      .upsert(
        {
          patient_id: account.patientProfileId,
          existing_conditions: mergeList(existing.conditions, plan.profileAdditions.conditions),
          current_medications: mergeList(existing.medications, plan.profileAdditions.medications),
          allergies: mergeList(existing.allergies, plan.profileAdditions.allergies),
        },
        { onConflict: "patient_id" },
      );
    if (profileError) {
      return { error: "We could not update your health profile. Please try again." };
    }
  }

  await supabase
    .from("medical_documents")
    .update({ upload_status: "COMPLETED" })
    .eq("id", documentId);

  // Document → extracted data → digital twin. Confirming is the only event
  // that changes the patient's record, so it is the only thing that needs to
  // refresh the twin. A failure here must not fail the confirmation itself —
  // the twin is derived and can always be rebuilt.
  try {
    await refreshDigitalTwin(supabase, account.patientProfileId);
  } catch {
    /* twin refresh is best-effort; /twin rebuilds on demand */
  }

  // Everything derived for this patient is now stale.
  await invalidatePatient(account.patientProfileId);

  await recordAudit(supabase, account.authUserId, {
    action: "EXTRACTION_CONFIRMED",
    resourceType: "DOCUMENT",
    resourceId: documentId,
    metadata: { recordCount: plan.confirmedCount },
  });

  revalidatePath("/records");
  revalidatePath("/dashboard");
  revalidatePath("/twin");
  revalidatePath(`/records/${documentId}`);

  return {
    error: null,
    confirmed: plan.confirmedCount,
    rejected: plan.rejectedCount,
  };
}

export async function deleteDocumentAction(documentId: string): Promise<{ error: string | null }> {
  const account = await requireUser();
  if (!account.patientProfileId) return { error: "Complete your health profile first." };

  const supabase = await createClient();

  const { data: document } = await supabase
    .from("medical_documents")
    .select("id, patient_id, file_path")
    .eq("id", documentId)
    .maybeSingle();

  if (!document || document.patient_id !== account.patientProfileId) {
    return { error: "Document not found." };
  }

  await removeDocument(supabase, document.file_path);
  await supabase.from("medical_documents").delete().eq("id", documentId);

  revalidatePath("/records");
  return { error: null };
}

/* ------------------------------------------------ report explanation (P5) */

export type ExplainState = {
  answer: import("@/lib/rag/types").GroundedAnswer | null;
  error: string | null;
};

/**
 * Explains one report.
 *
 * The document id arrives from the client, so ownership is re-established here
 * before anything is read — the retrieval underneath is RLS-scoped, but a
 * request for a document belonging to someone else should be refused outright
 * rather than quietly returning an empty explanation.
 */
export async function explainReportAction(
  _previous: ExplainState,
  formData: FormData,
): Promise<ExplainState> {
  const documentId = String(formData.get("documentId") ?? "");
  const label = String(formData.get("label") ?? "this report");

  if (!documentId) return { answer: null, error: "Missing document." };

  const account = await requireUser();
  if (!account.patientProfileId) {
    return { answer: null, error: "Complete your health profile first." };
  }

  const supabase = await createClient();

  const { data: document } = await supabase
    .from("medical_documents")
    .select("id")
    .eq("id", documentId)
    .eq("patient_id", account.patientProfileId)
    .maybeSingle();

  if (!document) return { answer: null, error: "That document is not in your records." };

  try {
    const { explainReport } = await import("@/lib/rag/rag-service");
    const answer = await explainReport(supabase, account.patientProfileId, documentId, label);
    return { answer, error: null };
  } catch {
    return { answer: null, error: "AVERIS could not read this report just now. Try again." };
  }
}

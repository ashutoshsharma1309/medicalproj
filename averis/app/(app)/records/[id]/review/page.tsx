import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Callout } from "@/components/ui";
import { buildReviewItems } from "@/lib/services/documents/review";
import { documentTypeLabel } from "@/lib/services/documents/labels";
import type { MedicalExtraction } from "@/lib/services/documents/types";
import { ReviewForm } from "./ReviewForm";

export const metadata = { title: "Review extracted information" };
export const dynamic = "force-dynamic";

export default async function ReviewPage(props: { params: Promise<{ id: string }> }) {
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const { id } = await props.params;
  const supabase = await createClient();

  // RLS restricts this to the caller's own documents; the explicit patient_id
  // comparison below is a second, application-level check.
  const { data: document } = await supabase
    .from("medical_documents")
    .select("id, patient_id, file_name, document_type, upload_status")
    .eq("id", id)
    .maybeSingle();

  if (!document || document.patient_id !== account.patientProfileId) notFound();

  const { data: extraction } = await supabase
    .from("document_extractions")
    .select("extracted_data, confidence_score")
    .eq("document_id", id)
    .maybeSingle();

  if (!extraction) {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <Callout tone="notice" title="Nothing to review yet">
          This document hasn&rsquo;t been read successfully.{" "}
          <Link href={`/records/${id}`} className="font-semibold underline underline-offset-2">
            Open the document
          </Link>{" "}
          to try reading it again.
        </Callout>
      </div>
    );
  }

  const data = extraction.extracted_data as MedicalExtraction;
  const items = buildReviewItems(data);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <p className="eyebrow">
          <Link href="/records" className="hover:text-brand">
            Medical records
          </Link>{" "}
          · {documentTypeLabel(document.document_type)}
        </p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">
          Review what AVERIS found
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          From <strong>{document.file_name}</strong>. Nothing here has been added to your
          health profile yet — confirm what&rsquo;s correct, edit what isn&rsquo;t, and leave
          anything wrong unchecked.
        </p>
      </header>

      {document.upload_status === "COMPLETED" && (
        <Callout tone="positive" title="You already reviewed this document">
          Confirming again will add any items you select that aren&rsquo;t already on your
          profile.
        </Callout>
      )}

      <ReviewForm documentId={id} items={items} />

      <p className="text-[13px] leading-relaxed text-muted">
        AVERIS organizes your health information and does not provide medical advice. Discuss
        anything in this document with your healthcare provider.
      </p>
    </div>
  );
}

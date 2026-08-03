import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, Chip, Callout } from "@/components/ui";
import { formatDate } from "@/lib/utils/format";
import {
  documentTypeLabel,
  STATUS_PRESENTATION,
  confidencePercent,
} from "@/lib/services/documents/labels";
import { UploadPanel } from "./UploadPanel";

export const metadata = { title: "Medical Records" };
export const dynamic = "force-dynamic";

export default async function RecordsPage() {
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const supabase = await createClient();

  const [{ data: documents }, { data: records }] = await Promise.all([
    supabase
      .from("medical_documents")
      .select("id, file_name, document_type, upload_status, uploaded_at, error_message")
      .eq("patient_id", account.patientProfileId)
      .order("uploaded_at", { ascending: false }),
    supabase
      .from("patient_medical_records")
      .select("id, record_type, condition, medication, allergy, test_name, test_value, test_unit, confidence_score, created_at")
      .eq("patient_id", account.patientProfileId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const docs = documents ?? [];
  const confirmedRecords = records ?? [];
  const awaitingReview = docs.filter((d) => d.upload_status === "PENDING_REVIEW");

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">Medical Records Center</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">Your medical records</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          Upload reports, prescriptions and discharge summaries. AVERIS reads each one and
          organizes what it finds into your health profile — after you confirm it.
        </p>
      </header>

      {awaitingReview.length > 0 && (
        <Callout tone="notice" title={`${awaitingReview.length} document${awaitingReview.length > 1 ? "s" : ""} waiting for your review`}>
          AVERIS found information in{" "}
          {awaitingReview.length === 1 ? "a document" : "these documents"} but has not added
          anything to your profile yet.{" "}
          <Link
            href={`/records/${awaitingReview[0].id}/review`}
            className="font-semibold underline underline-offset-2"
          >
            Review now
          </Link>
        </Callout>
      )}

      <UploadPanel />

      {/* ------------------------------------------------ Uploaded documents */}
      <Card>
        <CardHeader
          eyebrow="Section 1"
          title="Uploaded documents"
          action={
            <span className="mono text-[12.5px] text-muted">
              {docs.length} {docs.length === 1 ? "document" : "documents"}
            </span>
          }
        />
        {docs.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-[15px] font-medium">No documents yet</p>
            <p className="mx-auto mt-1.5 max-w-md text-[14px] leading-relaxed text-ink-soft">
              Upload your first report above. AVERIS will read it and show you what it found
              before saving anything.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-rule">
            {docs.map((doc) => {
              const status = STATUS_PRESENTATION[doc.upload_status];
              return (
                <li key={doc.id} className="flex flex-wrap items-center gap-4 px-6 py-4">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/records/${doc.id}`}
                      className="block truncate text-[14.5px] font-semibold hover:text-brand"
                    >
                      {doc.file_name}
                    </Link>
                    <p className="mt-0.5 text-[12.5px] text-muted">
                      {documentTypeLabel(doc.document_type)} · uploaded{" "}
                      {formatDate(doc.uploaded_at)}
                    </p>
                    {doc.upload_status === "FAILED" && doc.error_message && (
                      <p className="mt-1 text-[12.5px] text-critical">{doc.error_message}</p>
                    )}
                  </div>

                  <Chip tone={status.tone}>{status.label}</Chip>

                  <Link
                    href={
                      doc.upload_status === "PENDING_REVIEW"
                        ? `/records/${doc.id}/review`
                        : `/records/${doc.id}`
                    }
                    className="text-[13.5px] font-medium text-brand hover:underline"
                  >
                    {doc.upload_status === "PENDING_REVIEW" ? "Review →" : "View →"}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* --------------------------------------------- Confirmed health records */}
      <Card>
        <CardHeader
          eyebrow="Section 2"
          title="Health records from your documents"
          action={
            <span className="mono text-[12.5px] text-muted">
              {confirmedRecords.length} confirmed
            </span>
          }
        />
        {confirmedRecords.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-[15px] font-medium">Nothing confirmed yet</p>
            <p className="mx-auto mt-1.5 max-w-md text-[14px] leading-relaxed text-ink-soft">
              Information you confirm from a document appears here and is added to your health
              profile.
            </p>
          </div>
        ) : (
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b border-rule text-left">
                <th className="eyebrow px-6 py-3 font-medium">Type</th>
                <th className="eyebrow px-6 py-3 font-medium">Detail</th>
                <th className="eyebrow px-6 py-3 font-medium">Confidence</th>
                <th className="eyebrow px-6 py-3 font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {confirmedRecords.map((record) => (
                <tr key={record.id} className="border-b border-rule last:border-0">
                  <td className="px-6 py-3">
                    <Chip>{record.record_type.toLowerCase().replace("_", " ")}</Chip>
                  </td>
                  <td className="px-6 py-3 font-medium">
                    {record.condition ??
                      record.medication ??
                      record.allergy ??
                      [record.test_name, record.test_value, record.test_unit]
                        .filter(Boolean)
                        .join(" ")}
                  </td>
                  <td className="mono px-6 py-3 text-muted">
                    {record.confidence_score != null
                      ? confidencePercent(Number(record.confidence_score))
                      : "—"}
                  </td>
                  <td className="mono px-6 py-3 text-muted">{formatDate(record.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

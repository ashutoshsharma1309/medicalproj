import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, Chip, Callout, ButtonLink, DataPoint } from "@/components/ui";
import { createSignedUrl } from "@/lib/services/documents/storage-service";
import {
  documentTypeLabel,
  STATUS_PRESENTATION,
  confidencePercent,
  confidenceTone,
} from "@/lib/services/documents/labels";
import type { MedicalExtraction } from "@/lib/services/documents/types";
import { formatDate } from "@/lib/utils/format";
import { ReprocessButton } from "./ReprocessButton";

export const metadata = { title: "Document" };
export const dynamic = "force-dynamic";

export default async function DocumentPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ confirmed?: string }>;
}) {
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const { id } = await props.params;
  const { confirmed } = await props.searchParams;
  const supabase = await createClient();

  const { data: document } = await supabase
    .from("medical_documents")
    .select(
      "id, patient_id, file_name, file_path, mime_type, document_type, upload_status, uploaded_at, processed_at, error_message",
    )
    .eq("id", id)
    .maybeSingle();

  if (!document || document.patient_id !== account.patientProfileId) notFound();

  const [{ data: extraction }, signedUrl, { data: records }] = await Promise.all([
    supabase
      .from("document_extractions")
      .select("extracted_data, confidence_score, extraction_model, text_source, created_at")
      .eq("document_id", id)
      .maybeSingle(),
    // Short-lived; the bucket is private and never publicly addressable.
    createSignedUrl(supabase, document.file_path, 300),
    supabase
      .from("patient_medical_records")
      .select("id, record_type, condition, medication, allergy, test_name, test_value, test_unit")
      .eq("source_document_id", id),
  ]);

  const data = extraction?.extracted_data as MedicalExtraction | undefined;
  const status = STATUS_PRESENTATION[document.upload_status];
  const confirmedCount = Number(confirmed ?? 0);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">
            <Link href="/records" className="hover:text-brand">
              Medical records
            </Link>{" "}
            · {documentTypeLabel(document.document_type)}
          </p>
          <h1 className="mt-2 truncate text-[24px] font-semibold leading-tight">
            {document.file_name}
          </h1>
          <p className="mt-1 text-[13px] text-muted">
            Uploaded {formatDate(document.uploaded_at)}
            {document.processed_at && ` · processed ${formatDate(document.processed_at)}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Chip tone={status.tone}>{status.label}</Chip>
          {document.upload_status === "PENDING_REVIEW" && (
            <ButtonLink href={`/records/${id}/review`}>Review findings</ButtonLink>
          )}
        </div>
      </header>

      {confirmedCount > 0 && (
        <Callout tone="positive" title="Added to your health profile">
          {confirmedCount} item{confirmedCount > 1 ? "s were" : " was"} confirmed and added.{" "}
          <Link href="/dashboard" className="font-semibold underline underline-offset-2">
            View your health profile
          </Link>
        </Callout>
      )}

      {document.upload_status === "FAILED" && (
        <Callout tone="critical" title="AVERIS couldn't read this document">
          {document.error_message ?? "The document could not be processed."}{" "}
          A clearer scan or a PDF exported from the original often reads better.
          <div className="mt-3">
            <ReprocessButton documentId={id} />
          </div>
        </Callout>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* ------------------------------------------------ Original document */}
        <Card>
          <CardHeader
            eyebrow="Original"
            title="Your document"
            action={
              signedUrl ? (
                <a
                  href={signedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[13.5px] font-medium text-brand hover:underline"
                >
                  Open full size
                </a>
              ) : undefined
            }
          />
          <div className="p-4">
            {!signedUrl ? (
              <p className="px-2 py-8 text-center text-[14px] text-muted">
                The stored file could not be loaded.
              </p>
            ) : document.mime_type === "application/pdf" ? (
              <object
                data={signedUrl}
                type="application/pdf"
                className="h-[480px] w-full rounded-md border border-rule"
                aria-label={`Preview of ${document.file_name}`}
              >
                <p className="p-4 text-[14px] text-ink-soft">
                  Your browser can&rsquo;t preview PDFs inline.{" "}
                  <a href={signedUrl} target="_blank" rel="noreferrer" className="text-brand underline">
                    Open the document
                  </a>
                  .
                </p>
              </object>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={signedUrl}
                alt={`Scan of ${document.file_name}`}
                className="max-h-[480px] w-full rounded-md border border-rule object-contain"
              />
            )}
            <p className="mt-3 px-1 text-[12px] leading-relaxed text-muted">
              Access to this file is granted through a link that expires in five minutes. Your
              documents are never publicly accessible.
            </p>
          </div>
        </Card>

        {/* ------------------------------------------------------- AI summary */}
        <Card>
          <CardHeader
            eyebrow="AVERIS summary"
            title="What this document contains"
            action={
              extraction?.confidence_score != null ? (
                <Chip tone={confidenceTone(Number(extraction.confidence_score))}>
                  {confidencePercent(Number(extraction.confidence_score))} confidence
                </Chip>
              ) : undefined
            }
          />

          {!data ? (
            <div className="px-6 py-10 text-center text-[14px] text-ink-soft">
              This document hasn&rsquo;t been read yet.
              <div className="mt-4">
                <ReprocessButton documentId={id} />
              </div>
            </div>
          ) : (
            <div className="space-y-5 px-6 py-5">
              <p className="text-[14.5px] leading-relaxed">{data.summary}</p>

              {data.key_findings.length > 0 && (
                <div>
                  <p className="eyebrow mb-2">Key findings</p>
                  <ul className="space-y-1.5">
                    {data.key_findings.map((finding) => (
                      <li key={finding} className="flex gap-2.5 text-[14px] leading-relaxed">
                        <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-brand" />
                        {finding}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {data.lab_results.length > 0 && (
                <div>
                  <p className="eyebrow mb-2">Recorded test results</p>
                  <table className="w-full text-[13.5px]">
                    <thead>
                      <tr className="border-b border-rule text-left text-muted">
                        <th className="py-1.5 font-medium">Test</th>
                        <th className="py-1.5 font-medium">Result</th>
                        <th className="py-1.5 font-medium">Reference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.lab_results.map((r) => (
                        <tr key={r.test} className="border-b border-rule last:border-0">
                          <td className="py-2 font-medium">{r.test}</td>
                          <td className="mono py-2">
                            {r.value} {r.unit ?? ""}
                            {r.flag !== "NORMAL" && r.flag !== "UNKNOWN" && (
                              <span className="ml-2">
                                <Chip tone={r.flag === "HIGH" ? "critical" : "notice"}>
                                  {r.flag.toLowerCase()}
                                </Chip>
                              </span>
                            )}
                          </td>
                          <td className="mono py-2 text-muted">{r.reference_range ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-rule pt-4">
                {data.doctor_name && (
                  <DataPoint label="Doctor" value={data.doctor_name.value} />
                )}
                {data.hospital_name && (
                  <DataPoint label="Hospital" value={data.hospital_name.value} />
                )}
                {data.document_date && (
                  <DataPoint label="Document date" value={data.document_date.value} mono />
                )}
                {data.blood_group && data.blood_group.value !== "UNKNOWN" && (
                  <DataPoint label="Blood group" value={data.blood_group.value} mono />
                )}
              </dl>

              <p className="border-t border-rule pt-4 font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted">
                Read by {extraction?.extraction_model ?? "—"} · text via{" "}
                {extraction?.text_source ?? "—"}
              </p>
            </div>
          )}
        </Card>
      </div>

      {records && records.length > 0 && (
        <Card>
          <CardHeader
            eyebrow="Confirmed"
            title="What you added to your profile from this document"
          />
          <ul className="flex flex-wrap gap-2 px-6 py-5">
            {records.map((record) => (
              <li key={record.id}>
                <Chip tone="positive">
                  {record.condition ??
                    record.medication ??
                    record.allergy ??
                    [record.test_name, record.test_value, record.test_unit]
                      .filter(Boolean)
                      .join(" ")}
                </Chip>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Callout tone="notice">
        AVERIS organizes your health information and does not provide medical advice or a
        diagnosis. Discuss anything in this document with your healthcare provider.
      </Callout>
    </div>
  );
}

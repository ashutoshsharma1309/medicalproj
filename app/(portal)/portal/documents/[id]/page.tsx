import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { SectionCard, Chip } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import type { PatientExtraction } from "@/lib/ai/patientExtraction";
import { ReviewActions } from "./ReviewActions";

export const metadata = { title: "Review document" };
export const dynamic = "force-dynamic";

export default async function DocumentReviewPage(props: { params: Promise<{ id: string }> }) {
  const user = await getSession();
  const patient = await db.patient.findFirst({ where: { userId: user!.id } });
  if (!patient) redirect("/portal/setup");

  const { id } = await props.params;
  const doc = await db.document.findUnique({ where: { id } });
  if (!doc || doc.patientId !== patient.id) notFound();

  const ex = doc.extraction as unknown as PatientExtraction | null;
  const awaitingReview = doc.extractionStatus === "EXTRACTED";

  const facts: { label: string; value: string | null }[] = ex
    ? [
        { label: "Patient name", value: ex.patientName },
        { label: "Age", value: ex.age != null ? String(ex.age) : null },
        { label: "Gender", value: ex.gender },
        { label: "Blood group", value: ex.bloodGroup },
        { label: "Document type", value: ex.documentType?.replace(/_/g, " ") ?? null },
        { label: "Doctors mentioned", value: ex.doctors?.length ? ex.doctors.join(", ") : null },
      ]
    : [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="eyebrow">
            <Link href="/portal/documents" className="hover:text-scrub">My documents</Link> · uploaded{" "}
            {fmtDateTime(doc.uploadedAt)}
          </div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight">{doc.filename}</h1>
        </div>
        <a
          href={`/api/portal/documents/${doc.id}/file`}
          target="_blank"
          className="btn btn-secondary text-xs"
        >
          View original file
        </a>
      </header>

      {doc.extractionStatus === "UNAVAILABLE" && (
        <SectionCard>
          <div className="px-5 py-5 text-[13.5px] leading-relaxed text-muted">
            Your document is stored securely, but automatic reading isn&rsquo;t available for
            this file right now. You can{" "}
            <Link href="/portal/setup" className="font-medium text-scrub hover:underline">
              add the details to your profile manually
            </Link>
            , and your care team can still open the original file.
          </div>
        </SectionCard>
      )}

      {doc.extractionStatus === "FAILED" && (
        <SectionCard>
          <div className="px-5 py-5 text-[13.5px] leading-relaxed">
            <span className="font-semibold text-critical">We couldn&rsquo;t read this document.</span>{" "}
            <span className="text-muted">
              The file may be blurry or incomplete. Try a clearer scan, or{" "}
              <Link href="/portal/setup" className="font-medium text-scrub hover:underline">
                enter the details manually
              </Link>
              .
            </span>
          </div>
        </SectionCard>
      )}

      {ex && (
        <SectionCard
          eyebrow={awaitingReview ? "Step 2 of 2 — verification" : "Extraction record"}
          title={awaitingReview ? "Review extracted information" : "Extracted information"}
          action={
            doc.confidence != null ? (
              <Chip tone={doc.confidence >= 0.75 ? "low" : doc.confidence >= 0.5 ? "medium" : "high"}>
                Confidence {(doc.confidence * 100).toFixed(0)}%
              </Chip>
            ) : undefined
          }
        >
          <div className="space-y-5 px-5 pb-5">
            {awaitingReview && (
              <p className="rounded-md border border-info-line bg-info-wash px-4 py-3 text-[13px] leading-relaxed">
                Meridian read your document and found the details below.{" "}
                <strong>Nothing has been added to your profile yet</strong> — check that this
                matches your document, then confirm or edit manually.
              </p>
            )}

            <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              {facts
                .filter((f) => f.value)
                .map((f) => (
                  <div key={f.label} className="flex items-baseline justify-between gap-4 border-b border-hairline pb-2">
                    <span className="eyebrow">{f.label}</span>
                    <span className="text-[13.5px] font-semibold">{f.value}</span>
                  </div>
                ))}
            </div>

            {ex.conditions?.length > 0 && (
              <div>
                <div className="eyebrow mb-1.5">Medical conditions</div>
                <div className="flex flex-wrap gap-1.5">
                  {ex.conditions.map((c) => (
                    <Chip key={c} tone="medium">{c}</Chip>
                  ))}
                </div>
              </div>
            )}
            {ex.allergies?.length > 0 && (
              <div>
                <div className="eyebrow mb-1.5">Allergies</div>
                <div className="flex flex-wrap gap-1.5">
                  {ex.allergies.map((a) => (
                    <Chip key={a} tone="critical">{a}</Chip>
                  ))}
                </div>
              </div>
            )}
            {ex.medications?.length > 0 && (
              <div>
                <div className="eyebrow mb-1.5">Medications</div>
                <ul className="space-y-1 text-[13.5px]">
                  {ex.medications.map((m) => (
                    <li key={m.name}>
                      <span className="font-medium">{m.name}</span>{" "}
                      <span className="text-muted">{[m.dose, m.frequency].filter(Boolean).join(" · ")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {ex.labValues?.length > 0 && (
              <div>
                <div className="eyebrow mb-1.5">Test results</div>
                <table className="table">
                  <thead>
                    <tr><th>Test</th><th>Result</th><th>Reference</th><th>Flag</th></tr>
                  </thead>
                  <tbody>
                    {ex.labValues.map((v) => (
                      <tr key={v.analyte}>
                        <td className="font-medium">{v.analyte}</td>
                        <td className="mono-data">{v.value} <span className="text-xs text-faint">{v.unit}</span></td>
                        <td className="mono-data text-xs text-muted">
                          {v.refLow != null && v.refHigh != null ? `${v.refLow} – ${v.refHigh}` : "—"}
                        </td>
                        <td>
                          {v.flag ? (
                            <Chip tone={v.flag === "H" ? "critical" : "medium"}>{v.flag === "H" ? "High" : "Low"}</Chip>
                          ) : (
                            <span className="text-xs text-ok">Normal</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {ex.importantDates?.length > 0 && (
              <div>
                <div className="eyebrow mb-1.5">Important dates</div>
                <ul className="space-y-1 text-[13px] text-muted">
                  {ex.importantDates.map((d) => (
                    <li key={`${d.date}-${d.event}`}>
                      <span className="mono-data text-ink">{d.date}</span> — {d.event}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {ex.summary && (
              <p className="rounded-md bg-paper px-4 py-3 text-[13px] leading-relaxed text-muted">
                {ex.summary}
              </p>
            )}

            <div className="border-t border-hairline pt-2 font-mono text-[10px] uppercase tracking-wider text-faint">
              Engine: {doc.extractedWith ?? "—"} · You decide what is saved to your record
            </div>

            {awaitingReview ? (
              <ReviewActions documentId={doc.id} />
            ) : (
              doc.extractionStatus === "CONFIRMED" && (
                <p className="rounded-md border border-ok-line bg-ok-wash px-4 py-2.5 text-[13px] text-ok">
                  Confirmed — this information has been merged into your profile.
                </p>
              )
            )}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

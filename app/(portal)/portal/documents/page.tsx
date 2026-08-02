import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { SectionCard, Chip, EmptyState } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { UploadPanel } from "./UploadPanel";

export const metadata = { title: "My Documents" };
export const dynamic = "force-dynamic";

const STATUS_META: Record<string, { tone: string; label: string }> = {
  EXTRACTED: { tone: "high", label: "Review extraction" },
  CONFIRMED: { tone: "low", label: "Confirmed" },
  PROCESSING: { tone: "medium", label: "Processing" },
  UNAVAILABLE: { tone: "neutral", label: "Stored — AI pending" },
  FAILED: { tone: "critical", label: "Extraction failed" },
};

export default async function DocumentsPage() {
  const user = await getSession();
  const patient = await db.patient.findFirst({ where: { userId: user!.id } });
  if (!patient || !patient.profileCompleted) redirect("/portal/setup");

  const documents = await db.document.findMany({
    where: { patientId: patient.id },
    orderBy: { uploadedAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">Personal health record</div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">My documents</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">
          Upload prescriptions, blood reports, discharge summaries or lab results. Meridian
          reads them and suggests updates to your profile — nothing is saved until you review
          and confirm it.
        </p>
      </header>

      <UploadPanel />

      <SectionCard eyebrow="Uploaded" title="Your documents">
        {documents.length === 0 ? (
          <EmptyState
            title="No documents yet"
            hint="Drag a file into the area above — PDF, JPG, PNG or TXT, up to 8 MB."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Type</th>
                <th>Uploaded</th>
                <th>Extraction</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {documents.map((d) => {
                const meta = STATUS_META[d.extractionStatus] ?? STATUS_META.PROCESSING;
                return (
                  <tr key={d.id}>
                    <td>
                      <span className="font-medium">{d.filename}</span>
                      {d.fileSize != null && (
                        <span className="mono-data ml-2 text-xs text-faint">
                          {(d.fileSize / 1024).toFixed(0)} KB
                        </span>
                      )}
                    </td>
                    <td className="text-muted">{d.kind.replace(/_/g, " ")}</td>
                    <td className="mono-data text-xs">{fmtDateTime(d.uploadedAt)}</td>
                    <td>
                      <Chip tone={meta.tone}>{meta.label}</Chip>
                      {d.confidence != null && d.extractionStatus !== "UNAVAILABLE" && (
                        <span className="mono-data ml-2 text-xs text-faint">
                          {(d.confidence * 100).toFixed(0)}%
                        </span>
                      )}
                    </td>
                    <td className="text-right">
                      <Link
                        href={`/portal/documents/${d.id}`}
                        className="text-[13px] font-medium text-scrub hover:underline"
                      >
                        {d.extractionStatus === "EXTRACTED" ? "Review →" : "View →"}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </SectionCard>
    </div>
  );
}

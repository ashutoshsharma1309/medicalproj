import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { SectionCard, Chip, EmptyState } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import type { Extraction } from "@/lib/ai/extraction";

export const dynamic = "force-dynamic";

export default async function NotesPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const patient = await db.patient.findUnique({
    where: { id },
    include: {
      notes: { include: { author: true }, orderBy: { createdAt: "desc" } },
      documents: { orderBy: { uploadedAt: "desc" } },
    },
  });
  if (!patient) notFound();

  return (
    <div className="space-y-5">
      <SectionCard
        eyebrow="Documentation"
        title="Clinical notes"
        action={
          <Link href={`/documentation?patient=${patient.id}`} className="btn btn-primary text-xs">
            New note
          </Link>
        }
      >
        {patient.notes.length === 0 ? (
          <EmptyState title="No notes yet" hint="Generate a structured note from dictated shorthand in Documentation." />
        ) : (
          <div className="divide-y divide-hairline">
            {patient.notes.map((n) => (
              <article key={n.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                    {n.kind}
                  </span>
                  <Chip tone={n.status === "FINALIZED" ? "low" : "high"}>
                    {n.status === "FINALIZED" ? "Finalized" : "Draft"}
                  </Chip>
                  <span className="text-xs text-faint">
                    {n.author.name} · {fmtDateTime(n.createdAt)}
                  </span>
                  {n.engine && (
                    <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-faint">
                      {n.engine}
                    </span>
                  )}
                </div>
                <dl className="mt-3 grid gap-3 md:grid-cols-2">
                  {(
                    [
                      ["Subjective", n.subjective],
                      ["Objective", n.objective],
                      ["Assessment", n.assessment],
                      ["Plan", n.plan],
                    ] as const
                  ).map(
                    ([label, body]) =>
                      body && (
                        <div key={label}>
                          <dt className="eyebrow mb-1">{label}</dt>
                          <dd className="whitespace-pre-line text-[13px] leading-relaxed text-muted">
                            {body}
                          </dd>
                        </div>
                      ),
                  )}
                </dl>
                {n.followUp && (
                  <div className="mt-3 rounded-md bg-scrub-wash px-3 py-2 text-[13px]">
                    <span className="font-semibold text-scrub">Follow-up: </span>
                    {n.followUp}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard eyebrow="Source documents" title="Uploaded documents & extractions">
        {patient.documents.length === 0 ? (
          <EmptyState title="No documents uploaded" />
        ) : (
          <div className="divide-y divide-hairline">
            {patient.documents.map((d) => {
              const ex = d.extraction as unknown as Extraction | null;
              return (
                <article key={d.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-[13.5px] font-semibold">{d.filename}</span>
                    <Chip tone="medium">{d.kind.replace(/_/g, " ")}</Chip>
                    <span className="text-xs text-faint">{fmtDateTime(d.uploadedAt)}</span>
                    <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-faint">
                      {d.extractedWith}
                    </span>
                  </div>
                  {ex && (
                    <div className="mt-3 space-y-2.5">
                      <p className="text-[13px] leading-relaxed text-muted">{ex.summary}</p>
                      {ex.keyFindings.length > 0 && (
                        <div className="rounded-md border border-warn-line bg-warn-wash px-3.5 py-2.5">
                          <div className="eyebrow mb-1">Key findings</div>
                          <ul className="list-disc space-y-0.5 pl-4 text-[13px]">
                            {ex.keyFindings.map((k) => (
                              <li key={k}>{k}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1.5">
                        {ex.conditions.map((c) => (
                          <Chip key={c} tone="medium">{c}</Chip>
                        ))}
                        {ex.medications.map((m) => (
                          <Chip key={m.name} tone="neutral">
                            {m.name} {m.dose ?? ""}
                          </Chip>
                        ))}
                        {ex.allergies.map((a) => (
                          <Chip key={a} tone="critical">Allergy: {a}</Chip>
                        ))}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

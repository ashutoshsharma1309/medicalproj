import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { SectionCard, SeverityChip, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const CATEGORY_COLOR: Record<string, string> = {
  diagnosis: "var(--color-info)",
  medication: "var(--color-scrub-mid)",
  procedure: "var(--color-warn)",
  lab: "var(--color-warn)",
  admission: "var(--color-critical)",
  note: "var(--color-faint)",
};

export default async function TimelinePage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const patient = await db.patient.findUnique({
    where: { id },
    include: { timelineEvents: { orderBy: { occurredAt: "desc" } } },
  });
  if (!patient) notFound();

  // Group by year, newest first
  const byYear = new Map<number, typeof patient.timelineEvents>();
  for (const e of patient.timelineEvents) {
    const y = e.occurredAt.getFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(e);
  }

  return (
    <SectionCard eyebrow="Longitudinal record" title="Medical timeline">
      {patient.timelineEvents.length === 0 ? (
        <EmptyState title="No events recorded" />
      ) : (
        <div className="space-y-8 px-6 pb-6 pt-2">
          {[...byYear.entries()].map(([year, events]) => (
            <div key={year} className="grid grid-cols-[64px_1fr] gap-6">
              <div className="mono-data pt-1 text-right text-[15px] font-semibold text-scrub">
                {year}
              </div>
              <div className="timeline-spine space-y-5 pl-7">
                {events.map((e) => (
                  <div key={e.id} className="relative">
                    <span
                      className="timeline-dot"
                      style={{ background: CATEGORY_COLOR[e.category] ?? "var(--color-faint)", left: "-28px" }}
                    />
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="mono-data text-xs text-faint">{fmtDate(e.occurredAt)}</span>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                        {e.category}
                      </span>
                      {(e.severity === "HIGH" || e.severity === "CRITICAL") && (
                        <SeverityChip level={e.severity} />
                      )}
                    </div>
                    <div className="mt-0.5 text-[13.5px] font-semibold">{e.title}</div>
                    {e.detail && (
                      <p className="mt-0.5 max-w-2xl text-[13px] leading-relaxed text-muted">
                        {e.detail}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

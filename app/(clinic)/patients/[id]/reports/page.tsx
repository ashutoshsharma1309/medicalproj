import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { SectionCard, Chip, EmptyState, Sparkline } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ReportsPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const patient = await db.patient.findUnique({
    where: { id },
    include: {
      labReports: { include: { values: true }, orderBy: { collectedAt: "desc" } },
    },
  });
  if (!patient) notFound();

  const reports = patient.labReports;

  // Build per-analyte trend series (chronological)
  const chronological = [...reports].reverse();
  const trends = new Map<string, { points: number[]; unit: string; refLow: number | null; refHigh: number | null }>();
  for (const r of chronological) {
    for (const v of r.values) {
      if (!trends.has(v.analyte)) {
        trends.set(v.analyte, { points: [], unit: v.unit, refLow: v.refLow, refHigh: v.refHigh });
      }
      trends.get(v.analyte)!.points.push(v.value);
    }
  }
  const trending = [...trends.entries()].filter(([, t]) => t.points.length >= 2);

  return (
    <div className="space-y-5">
      {trending.length > 0 && (
        <SectionCard eyebrow="Report analyzer" title="Trends across reports">
          <div className="grid gap-px divide-hairline border-t border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-3">
            {trending.map(([analyte, t]) => {
              const first = t.points[0];
              const last = t.points[t.points.length - 1];
              const delta = last - first;
              const worsening =
                (t.refHigh != null && last > t.refHigh && delta > 0) ||
                (t.refLow != null && last < t.refLow && delta < 0);
              const outNow =
                (t.refHigh != null && last > t.refHigh) || (t.refLow != null && last < t.refLow);
              return (
                <div key={analyte} className="bg-surface p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-semibold">{analyte}</span>
                    {worsening ? (
                      <Chip tone="critical">Needs attention</Chip>
                    ) : outNow ? (
                      <Chip tone="high">Out of range</Chip>
                    ) : (
                      <Chip tone="low">In range</Chip>
                    )}
                  </div>
                  <div className="mt-2 flex items-end justify-between gap-3">
                    <div>
                      <div className="mono-data text-xl font-semibold leading-none">
                        {last}
                        <span className="ml-1 text-xs font-normal text-faint">{t.unit}</span>
                      </div>
                      <div className="mono-data mt-1 text-xs text-muted">
                        {delta === 0 ? "no change" : `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(1)} from first (${first})`}
                      </div>
                    </div>
                    <Sparkline points={t.points} refLow={t.refLow} refHigh={t.refHigh} />
                  </div>
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}

      {reports.length === 0 ? (
        <SectionCard>
          <EmptyState title="No lab reports on file" />
        </SectionCard>
      ) : (
        reports.map((r) => {
          const abnormal = r.values.filter((v) => v.flag);
          return (
            <SectionCard
              key={r.id}
              eyebrow={`${r.category} · collected ${fmtDate(r.collectedAt)}`}
              title={r.title}
              action={
                abnormal.length > 0 ? (
                  <Chip tone="high">{abnormal.length} abnormal</Chip>
                ) : (
                  <Chip tone="low">All in range</Chip>
                )
              }
            >
              {r.summary && (
                <div className="mx-5 mb-3 rounded-md border border-info-line bg-info-wash px-4 py-3">
                  <div className="eyebrow mb-1">Plain-language summary</div>
                  <p className="text-[13px] leading-relaxed">{r.summary}</p>
                </div>
              )}
              <table className="table">
                <thead>
                  <tr>
                    <th>Analyte</th>
                    <th>Result</th>
                    <th>Reference</th>
                    <th>Flag</th>
                  </tr>
                </thead>
                <tbody>
                  {r.values.map((v) => (
                    <tr key={v.id}>
                      <td className="font-medium">{v.analyte}</td>
                      <td className="mono-data">
                        {v.value} <span className="text-xs text-faint">{v.unit}</span>
                      </td>
                      <td className="mono-data text-xs text-muted">
                        {v.refLow != null && v.refHigh != null ? `${v.refLow} – ${v.refHigh}` : "—"}
                      </td>
                      <td>
                        {v.flag ? (
                          <Chip tone={v.flag === "H" ? "critical" : "medium"}>
                            {v.flag === "H" ? "High" : "Low"}
                          </Chip>
                        ) : (
                          <span className="text-xs text-ok">Normal</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {r.reviewedBy && (
                <div className="border-t border-hairline px-5 py-2 font-mono text-[10px] uppercase tracking-wider text-faint">
                  Reviewed by {r.reviewedBy}
                </div>
              )}
            </SectionCard>
          );
        })
      )}
    </div>
  );
}

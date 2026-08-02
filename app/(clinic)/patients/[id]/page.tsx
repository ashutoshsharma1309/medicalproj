import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { checkMedicationSafety } from "@/lib/clinical/interactions";
import type { RiskResult } from "@/lib/clinical/risk";
import { SectionCard, Chip, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { RiskPanel } from "./RiskPanel";
import { SafetyPanel } from "./SafetyPanel";

export const dynamic = "force-dynamic";

export default async function PatientOverview(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const patient = await db.patient.findUnique({
    where: { id },
    include: {
      conditions: { orderBy: { diagnosedAt: "desc" } },
      allergies: true,
      medications: { orderBy: [{ status: "asc" }, { startedAt: "desc" }] },
      riskAssessments: { orderBy: { createdAt: "desc" } },
      labReports: { include: { values: true }, orderBy: { collectedAt: "desc" }, take: 1 },
    },
  });
  if (!patient) notFound();

  const alerts = await checkMedicationSafety(patient.medications, patient.allergies);

  // latest stored assessment per domain -> initial state for the risk panel
  const latestByDomain = new Map<string, (typeof patient.riskAssessments)[number]>();
  for (const r of patient.riskAssessments) {
    if (!latestByDomain.has(r.domain)) latestByDomain.set(r.domain, r);
  }
  const initialRisk: RiskResult[] = [...latestByDomain.values()].map((r) => ({
    domain: r.domain,
    score: r.score,
    band: r.band as RiskResult["band"],
    factors: r.factors as RiskResult["factors"],
    recommendations: [],
    narrative: r.narrative,
    engine: r.engine,
  }));

  const activeMeds = patient.medications.filter((m) => m.status === "ACTIVE");
  const stoppedMeds = patient.medications.filter((m) => m.status === "DISCONTINUED");
  const latestReport = patient.labReports[0];
  const abnormal = latestReport?.values.filter((v) => v.flag) ?? [];

  return (
    <div className="space-y-5">
      {/* Row 1: problems + medications */}
      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard eyebrow="Problem list" title="Medical conditions">
          {patient.conditions.length === 0 ? (
            <EmptyState title="No documented conditions" />
          ) : (
            <ul className="divide-y divide-hairline">
              {patient.conditions.map((c) => (
                <li key={c.id} className="flex items-start justify-between gap-4 px-5 py-3">
                  <div>
                    <div className="text-[13.5px] font-semibold">{c.name}</div>
                    <div className="mt-0.5 text-xs text-muted">
                      Diagnosed {fmtDate(c.diagnosedAt)}
                      {c.icd10 && <span className="mono-data ml-2 text-faint">{c.icd10}</span>}
                    </div>
                    {c.notes && <p className="mt-1 text-xs leading-relaxed text-muted">{c.notes}</p>}
                  </div>
                  <Chip tone={c.status === "ACTIVE" ? "high" : c.status === "MANAGED" ? "medium" : "neutral"}>
                    {c.status.toLowerCase()}
                  </Chip>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard eyebrow="Pharmacy" title="Medications">
          <div className="px-5 pb-4">
            <table className="table -mx-5 w-[calc(100%+2.5rem)]">
              <thead>
                <tr>
                  <th>Medication</th>
                  <th>Dose · frequency</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {activeMeds.map((m) => (
                  <tr key={m.id}>
                    <td className="font-medium">{m.name}</td>
                    <td className="text-muted">
                      {m.dose} · {m.frequency}
                    </td>
                    <td className="mono-data text-xs">{fmtDate(m.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {stoppedMeds.length > 0 && (
              <div className="mt-3 border-t border-hairline pt-3">
                <div className="eyebrow mb-1.5">Discontinued</div>
                {stoppedMeds.map((m) => (
                  <div key={m.id} className="text-xs text-faint">
                    {m.name} {m.dose} — stopped {m.stoppedAt ? fmtDate(m.stoppedAt) : "—"}
                  </div>
                ))}
              </div>
            )}
          </div>
        </SectionCard>
      </div>

      {/* Row 2: medication safety */}
      <SafetyPanel patientId={patient.id} initial={alerts} />

      {/* Row 3: risk analysis */}
      <RiskPanel patientId={patient.id} initial={initialRisk} />

      {/* Row 4: latest labs snapshot */}
      {latestReport && (
        <SectionCard
          eyebrow="Most recent labs"
          title={`${latestReport.title} — ${fmtDate(latestReport.collectedAt)}`}
        >
          {abnormal.length > 0 && (
            <div className="mx-5 mb-3 rounded-md border border-warn-line bg-warn-wash px-4 py-2.5 text-[13px] text-warn">
              {abnormal.length} value{abnormal.length > 1 ? "s" : ""} outside reference range:{" "}
              <strong>{abnormal.map((v) => v.analyte).join(", ")}</strong>
            </div>
          )}
          {latestReport.summary && (
            <p className="mx-5 mb-3 text-[13px] leading-relaxed text-muted">{latestReport.summary}</p>
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
              {latestReport.values.map((v) => (
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
        </SectionCard>
      )}
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, Chip, Callout } from "@/components/ui";
import { formatDate } from "@/lib/utils/format";
import { recordAudit } from "@/lib/audit/audit-service";
import { RiskPanel, type RiskPayload } from "@/app/(app)/monitoring/RiskPanel";
import { listReports } from "@/lib/care/report-service";
import { EmergencyActions } from "./EmergencyActions";
import { ReportPanel } from "./ReportPanel";
import { AssistantPanel } from "./AssistantPanel";
import { ClinicalTrends } from "./ClinicalTrends";
import type { SeriesPoint } from "@/lib/iot/series";

export const metadata = { title: "Patient" };
export const dynamic = "force-dynamic";

/**
 * One patient, for their clinician.
 *
 * Access is not checked here. RLS returns nothing for a patient this doctor is
 * not assigned to, so an unauthorised id renders a 404 rather than an error
 * page that would confirm the patient exists.
 */
export default async function ClinicalPatientPage(props: {
  params: Promise<{ patientId: string }>;
}) {
  const { patientId } = await props.params;
  const account = await requireUser();
  const supabase = await createClient();

  const { data: profile } = await supabase
    .from("patient_profiles")
    .select("id, user_id, date_of_birth, gender, blood_group, emergency_contact")
    .eq("id", patientId)
    .maybeSingle();

  if (!profile) notFound();

  const [identity, prediction, emergencies, alerts, readings, insights, reports] =
    await Promise.all([
    supabase.from("users").select("full_name").eq("id", profile.user_id).maybeSingle(),
    supabase
      .from("health_predictions")
      .select("risk_score, risk_category, confidence_score, explanation, created_at")
      .eq("patient_id", patientId)
      .eq("prediction_type", "VITAL_DETERIORATION")
      .order("created_at", { ascending: false })
      .limit(1)
      .then(({ data }) => data?.[0] ?? null),
    supabase
      .from("emergency_events")
      .select("id, event_type, severity, status, summary, created_at, acknowledged_at, resolved_at, resolution_note")
      .eq("patient_id", patientId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("alerts")
      .select("id, alert_type, severity, message, status, created_at")
      .eq("patient_id", patientId)
      .eq("status", "ACTIVE")
      .order("created_at", { ascending: false }),
    supabase
      .from("sensor_readings")
      .select("heart_rate, spo2, temperature, movement_status, recorded_at")
      .eq("patient_id", patientId)
      .order("recorded_at", { ascending: false })
      // Enough to draw a week's shape after downsampling. The table below
      // still shows only the newest rows — a clinician reading 400 lines of
      // sensor output is reading the chart, not the patient.
      .limit(400),
    supabase
      .from("ai_insights")
      .select("id, insight_type, message, severity, created_at")
      .eq("patient_id", patientId)
      .order("created_at", { ascending: false })
      .limit(8),
    listReports(supabase, patientId),
  ]);

  // Opening a chart is the auditable event. Access control decides who may
  // look; this is what makes looking accountable.
  await recordAudit(supabase, account.authUserId, {
    action: "HEALTH_SUMMARY_VIEWED",
    resourceType: "PROFILE",
    resourceId: patientId,
    metadata: { outcome: "clinical_chart_opened" },
  });

  const name = identity.data?.full_name ?? "Patient";
  const latest = readings.data?.[0] ?? null;
  const open = (emergencies.data ?? []).filter((e) =>
    ["NEW", "ACKNOWLEDGED", "IN_PROGRESS"].includes(e.status),
  );

  // Oldest first: a chart drawing left to right needs its input in draw order,
  // so the component never sorts during render.
  const series: SeriesPoint[] = (readings.data ?? [])
    .map((r) => ({
      t: new Date(r.recorded_at).getTime(),
      heartRate: r.heart_rate,
      spo2: r.spo2,
      temperature: r.temperature,
    }))
    .sort((a, b) => a.t - b.t);

  const risk: RiskPayload | null = prediction
    ? {
        risk_score: Number(prediction.risk_score),
        risk_level: prediction.risk_category as RiskPayload["risk_level"],
        confidence: Number(prediction.confidence_score ?? 0),
        ...(prediction.explanation as Omit<RiskPayload, "risk_score" | "risk_level" | "confidence">),
      }
    : null;

  return (
    <div className="space-y-7">
      <header>
        <Link href="/clinical" className="text-[13px] text-brand hover:underline">
          ← Caseload
        </Link>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">{name}</h1>
        <p className="mt-1.5 mono text-[13px] text-muted">
          {[profile.gender, profile.blood_group?.replace(/_/g, " ")].filter(Boolean).join(" · ")}
        </p>
      </header>

      {open.length > 0 && (
        <Card>
          <CardHeader
            eyebrow="Requires response"
            title="Open emergency events"
            action={<span className="mono text-[12.5px] text-muted">{open.length} open</span>}
          />
          <ul className="divide-y divide-rule">
            {open.map((event) => (
              <li key={event.id} className="px-6 py-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Chip tone={event.severity === "CRITICAL" ? "critical" : "notice"}>
                    {event.event_type.toLowerCase().replace(/_/g, " ")}
                  </Chip>
                  <Chip>{event.status.toLowerCase().replace(/_/g, " ")}</Chip>
                  <span className="mono text-[12px] text-muted">
                    {formatDate(event.created_at)}
                  </span>
                </div>
                <p className="mt-2 text-[14.5px] leading-relaxed">{event.summary}</p>
                <EmergencyActions eventId={event.id} status={event.status} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader eyebrow="Now" title="Latest vitals" />
        {latest ? (
          <dl className="grid grid-cols-2 gap-x-8 gap-y-5 px-6 py-5 sm:grid-cols-4">
            <Reading label="Heart rate" value={latest.heart_rate} unit="BPM" />
            <Reading label="Blood oxygen" value={latest.spo2} unit="%" />
            <Reading label="Temperature" value={latest.temperature} unit="°C" precision={1} />
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                Movement
              </dt>
              <dd className="mt-1.5 text-[18px] font-semibold">
                {latest.movement_status.toLowerCase().replace(/_/g, " ")}
              </dd>
              <dd className="mono mt-1 text-[11.5px] text-muted">
                {formatDate(latest.recorded_at)}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="px-6 py-6 text-[14px] text-muted">
            No readings on file. AVERIS never fills this in with placeholder values.
          </p>
        )}
      </Card>

      {risk && (
        <Card>
          <CardHeader
            eyebrow="Health Intelligence"
            title="AI risk assessment"
            action={
              <span className="mono text-[12.5px] text-muted">
                {formatDate(prediction!.created_at)}
              </span>
            }
          />
          <RiskPanel risk={risk} />
        </Card>
      )}

      {(insights.data ?? []).length > 0 && (
        <Card>
          <CardHeader eyebrow="Health Intelligence" title="AI observations" />
          <ul className="divide-y divide-rule">
            {(insights.data ?? []).map((insight) => (
              <li key={insight.id} className="px-6 py-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Chip tone={insight.severity === "CRITICAL" ? "critical" : "default"}>
                    {insight.insight_type.toLowerCase().replace(/_/g, " ")}
                  </Chip>
                  <span className="mono text-[12px] text-muted">
                    {formatDate(insight.created_at)}
                  </span>
                </div>
                <p className="mt-2 text-[14.5px] leading-relaxed">{insight.message}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(alerts.data ?? []).length > 0 && (
        <Card>
          <CardHeader eyebrow="Thresholds" title="Active alerts" />
          <ul className="divide-y divide-rule">
            {(alerts.data ?? []).map((alert) => (
              <li key={alert.id} className="px-6 py-3.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Chip tone={alert.severity === "CRITICAL" ? "critical" : "notice"}>
                    {alert.severity.toLowerCase()}
                  </Chip>
                  <span className="mono text-[12px] text-muted">
                    {formatDate(alert.created_at)}
                  </span>
                </div>
                <p className="mt-1.5 text-[14px] leading-relaxed">{alert.message}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader
          eyebrow="Trends"
          title="Health trends"
          action={
            <span className="mono text-[12.5px] text-muted">from the stored record</span>
          }
        />
        <ClinicalTrends points={series} />
      </Card>

      <Card>
        <CardHeader
          eyebrow="Assistant"
          title="Ask about this patient"
          action={
            <span className="mono text-[12.5px] text-muted">
              grounded in the last 24 hours
            </span>
          }
        />
        <AssistantPanel patientId={patientId} />
      </Card>

      <Card>
        <CardHeader eyebrow="Summary" title="Patient summary" />
        <ReportPanel patientId={patientId} reports={reports} />
      </Card>

      <Card>
        <CardHeader
          eyebrow="History"
          title="Recent readings"
          action={
            <span className="mono text-[12.5px] text-muted">
              newest 30 of {(readings.data ?? []).length}
            </span>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="border-b border-rule text-left">
                {["Time", "Heart rate", "SpO2", "Temp", "Movement"].map((h) => (
                  <th
                    key={h}
                    className="px-6 py-2.5 font-mono text-[10px] uppercase tracking-[0.13em] text-muted"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(readings.data ?? []).slice(0, 30).map((r, i) => (
                <tr key={i} className="border-b border-rule last:border-0">
                  <td className="mono px-6 py-2">{formatDate(r.recorded_at)}</td>
                  <td className="mono px-6 py-2">{r.heart_rate ?? "—"}</td>
                  <td className="mono px-6 py-2">{r.spo2 !== null ? `${r.spo2}%` : "—"}</td>
                  <td className="mono px-6 py-2">
                    {r.temperature !== null ? `${r.temperature}°C` : "—"}
                  </td>
                  <td className="px-6 py-2">
                    {r.movement_status.toLowerCase().replace(/_/g, " ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="pb-2 text-[13px] leading-relaxed text-muted">
        AVERIS reports measurements and the thresholds they crossed. It does not diagnose.
        Opening this chart has been recorded in the patient&rsquo;s access log.
      </p>
    </div>
  );
}

function Reading({
  label,
  value,
  unit,
  precision = 0,
}: {
  label: string;
  value: number | null;
  unit: string;
  precision?: number;
}) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</dt>
      <dd className="mono mt-1.5 text-[22px] font-semibold leading-none">
        {value === null ? (
          <span className="text-muted">—</span>
        ) : (
          <>
            {value.toFixed(precision)}
            <span className="ml-1 text-[12px] font-normal text-muted">{unit}</span>
          </>
        )}
      </dd>
    </div>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { listDevices, effectiveStatus } from "@/lib/iot/device-service";
import { Card, CardHeader, Chip, Callout, ButtonLink } from "@/components/ui";
import { formatDate } from "@/lib/utils/format";
import { LiveMonitor, type Vitals } from "./LiveMonitor";
import type { SeriesPoint } from "@/lib/iot/series";
import { RiskPanel, type RiskPayload } from "./RiskPanel";

export const metadata = { title: "Live Monitoring" };
export const dynamic = "force-dynamic";

const SEVERITY_TONE: Record<string, "critical" | "notice" | "default"> = {
  CRITICAL: "critical",
  WARNING: "notice",
  INFO: "default",
};

export default async function MonitoringPage() {
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const supabase = await createClient();

  const [devices, readings, latestPrediction, aiInsights, alerts] = await Promise.all([
    listDevices(supabase, account.patientProfileId),
    // History comes from the database over RLS; the socket only carries live
    // values. A dropped socket therefore costs the tiles, never the record.
    supabase
      .from("sensor_readings")
      .select("heart_rate, spo2, temperature, movement_status, battery_percentage, recorded_at, device_id")
      .eq("patient_id", account.patientProfileId)
      .order("recorded_at", { ascending: false })
      .limit(400)
      .then(({ data }) => data ?? []),
    supabase
      .from("health_predictions")
      .select("risk_score, risk_category, confidence_score, explanation, model_version, created_at")
      .eq("patient_id", account.patientProfileId)
      .eq("prediction_type", "VITAL_DETERIORATION")
      .order("created_at", { ascending: false })
      .limit(1)
      .then(({ data }) => data?.[0] ?? null),
    supabase
      .from("ai_insights")
      .select("id, insight_type, message, severity, evidence, confidence, created_at")
      .eq("patient_id", account.patientProfileId)
      .order("created_at", { ascending: false })
      .limit(8)
      .then(({ data }) => data ?? []),
    supabase
      .from("alerts")
      .select("id, alert_type, severity, message, observed_value, threshold_value, status, created_at")
      .eq("patient_id", account.patientProfileId)
      .order("created_at", { ascending: false })
      .limit(10)
      .then(({ data }) => data ?? []),
  ]);

  const active = devices.filter((d) => d.connectionStatus !== "RETIRED");
  const keyById = new Map(devices.map((d) => [d.id, d.deviceKey]));

  const latest: Vitals | null = readings[0]
    ? {
        heartRate: readings[0].heart_rate,
        spo2: readings[0].spo2,
        temperature: readings[0].temperature,
        movementStatus: readings[0].movement_status,
        batteryPercentage: readings[0].battery_percentage,
        recordedAt: readings[0].recorded_at,
        deviceKey: keyById.get(readings[0].device_id) ?? "device",
      }
    : null;

  const openAlerts = alerts.filter((a) => a.status === "ACTIVE");

  // Reconstructed from what was stored with the prediction rather than
  // recomputed: a later engine version would produce different contributions,
  // and the patient would have no way to see what they were actually shown.
  const risk: RiskPayload | null = latestPrediction
    ? {
        risk_score: Number(latestPrediction.risk_score),
        risk_level: latestPrediction.risk_category as RiskPayload["risk_level"],
        confidence: Number(latestPrediction.confidence_score ?? 0),
        ...(latestPrediction.explanation as Omit<
          RiskPayload,
          "risk_score" | "risk_level" | "confidence"
        >),
      }
    : null;

  // Seeded from the durable record so the charts are populated on first paint
  // rather than starting blank and filling in over the next ten minutes.
  const initialSeries: SeriesPoint[] = readings
    .map((r) => ({
      t: new Date(r.recorded_at).getTime(),
      heartRate: r.heart_rate,
      spo2: r.spo2,
      temperature: r.temperature,
    }))
    .sort((a, b) => a.t - b.t);

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">AVERIS Monitoring</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">Live health monitoring</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          Readings as your device reports them. AVERIS shows what was measured and the threshold
          each alert used — it does not interpret what the values mean for you.
        </p>
      </header>

      {active.length === 0 && (
        <Callout tone="brand" title="No device registered yet">
          Live monitoring needs a registered device.{" "}
          <Link href="/devices" className="font-semibold underline underline-offset-2">
            Register one
          </Link>{" "}
          to get a token.
        </Callout>
      )}

      {openAlerts.length > 0 && (
        <Card>
          <CardHeader
            eyebrow="Attention"
            title="Active alerts"
            action={
              <span className="mono text-[12.5px] text-muted">{openAlerts.length} open</span>
            }
          />
          <ul className="divide-y divide-rule">
            {openAlerts.map((alert) => (
              <li key={alert.id} className="px-6 py-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Chip tone={SEVERITY_TONE[alert.severity] ?? "default"}>
                    {alert.severity.toLowerCase()}
                  </Chip>
                  <span className="mono text-[12px] text-muted">
                    {formatDate(alert.created_at)}
                  </span>
                </div>
                <p className="mt-2 text-[14.5px] leading-relaxed">{alert.message}</p>
              </li>
            ))}
          </ul>
          <div className="border-t border-rule px-6 py-3.5">
            <p className="text-[13px] leading-relaxed text-muted">
              Each alert names the value measured and the threshold it crossed. Thresholds are
              published escalation triggers for a resting adult, not a judgement about you —
              discuss anything here with your healthcare provider.
            </p>
          </div>
        </Card>
      )}

      {risk && (
        <Card>
          <CardHeader
            eyebrow="Health Intelligence"
            title="AI risk assessment"
            action={
              <span className="mono text-[12.5px] text-muted">
                {formatDate(latestPrediction!.created_at)}
              </span>
            }
          />
          <RiskPanel risk={risk} />
        </Card>
      )}

      {aiInsights.length > 0 && (
        <Card>
          <CardHeader
            eyebrow="Health Intelligence"
            title="AI observations"
            action={
              <span className="mono text-[12.5px] text-muted">
                {aiInsights.length} recent
              </span>
            }
          />
          <ul className="divide-y divide-rule">
            {aiInsights.map((insight) => (
              <li key={insight.id} className="px-6 py-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Chip tone={SEVERITY_TONE[insight.severity] ?? "default"}>
                    {insight.insight_type.toLowerCase().replace(/_/g, " ")}
                  </Chip>
                  <span className="mono text-[12px] text-muted">
                    {formatDate(insight.created_at)}
                  </span>
                  {insight.confidence !== null && (
                    <span className="mono text-[11.5px] text-muted">
                      {Math.round(Number(insight.confidence) * 100)}% coverage
                    </span>
                  )}
                </div>
                <p className="mt-2 text-[14.5px] leading-relaxed">{insight.message}</p>
              </li>
            ))}
          </ul>
          <div className="border-t border-rule px-6 py-3.5">
            <p className="text-[13px] leading-relaxed text-muted">
              Observations describe patterns in the measurements — what changed, over what
              window, by how much. They are not a diagnosis, and AVERIS is not a medical device.
            </p>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader eyebrow="Now" title="Current vitals" />
        <LiveMonitor
          serviceUrl={process.env.NEXT_PUBLIC_IOT_WS_URL ?? null}
          initial={latest}
          initialSeries={initialSeries}
        />
      </Card>

      <Card>
        <CardHeader
          eyebrow="Devices"
          title="Reporting devices"
          action={
            <Link href="/devices" className="text-[13.5px] font-medium text-brand hover:underline">
              Manage
            </Link>
          }
        />
        {active.length === 0 ? (
          <div className="px-6 py-6 text-center">
            <ButtonLink href="/devices">Register a device</ButtonLink>
          </div>
        ) : (
          <ul className="divide-y divide-rule">
            {active.map((device) => {
              const status = effectiveStatus(device);
              return (
                <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
                  <div>
                    <span className="text-[14.5px] font-medium">{device.deviceName}</span>
                    <span className="mono ml-3 text-[12.5px] text-muted">{device.deviceKey}</span>
                  </div>
                  <Chip tone={status === "ONLINE" ? "positive" : status === "OFFLINE" ? "critical" : "default"}>
                    {status === "ONLINE"
                      ? "Reporting"
                      : status === "OFFLINE"
                        ? "Not reporting"
                        : "Awaiting first reading"}
                  </Chip>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          eyebrow="History"
          title="Recent readings"
          action={
            <span className="mono text-[12.5px] text-muted">
              {readings.length} in the last window
            </span>
          }
        />
        {readings.length === 0 ? (
          <div className="px-6 py-8 text-center">
            <p className="text-[15px] font-medium">No readings yet</p>
            <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-ink-soft">
              Nothing is shown until a device sends one. AVERIS never fills this in with
              placeholder values.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="border-b border-rule text-left">
                  <Th>Time</Th>
                  <Th>Device</Th>
                  <Th align="right">Heart rate</Th>
                  <Th align="right">SpO2</Th>
                  <Th align="right">Temp</Th>
                  <Th>Movement</Th>
                </tr>
              </thead>
              <tbody>
                {readings.slice(0, 25).map((reading, i) => (
                  <tr key={i} className="border-b border-rule last:border-0">
                    <Td mono>{formatDate(reading.recorded_at)}</Td>
                    <Td mono>{keyById.get(reading.device_id) ?? "—"}</Td>
                    <Td mono align="right">{reading.heart_rate ?? "—"}</Td>
                    <Td mono align="right">{reading.spo2 !== null ? `${reading.spo2}%` : "—"}</Td>
                    <Td mono align="right">
                      {reading.temperature !== null ? `${reading.temperature}°C` : "—"}
                    </Td>
                    <Td>{reading.movement_status.toLowerCase().replace(/_/g, " ")}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="pb-2 text-[13px] leading-relaxed text-muted">
        AVERIS records what your devices measure. It is not a medical device, does not provide
        diagnosis, and must not be relied on in an emergency — contact emergency services if you
        feel unwell.
      </p>
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={`px-6 py-2.5 font-mono text-[10px] uppercase tracking-[0.13em] text-muted ${
        align === "right" ? "text-right" : ""
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  mono = false,
  align = "left",
}: {
  children: React.ReactNode;
  mono?: boolean;
  align?: "left" | "right";
}) {
  return (
    <td
      className={`px-6 py-2.5 ${mono ? "mono" : ""} ${align === "right" ? "text-right" : ""}`}
    >
      {children}
    </td>
  );
}

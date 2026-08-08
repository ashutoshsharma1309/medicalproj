import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, Chip, Callout } from "@/components/ui";
import { StatTile, AlertBanner } from "@/components/ui/clinical";
import { HealthScoreCard } from "@/components/health/HealthScoreCard";
import { loadCommandCenter } from "@/lib/health/command-center";
import { classifyVital, STATUS_LABEL } from "@/lib/iot/vital-status";
import { EMERGENCY_LABEL, type EmergencyType } from "@/lib/care/escalation";
import { firstNameOf, formatDate } from "@/lib/utils/format";

export const metadata = { title: "Health command centre" };
export const dynamic = "force-dynamic";

/**
 * The patient's command centre.
 *
 * ── The question this page answers ─────────────────────────────────────────
 *
 * "Am I alright, and is anything watching?" — in that order, in one screen,
 * without scrolling.
 *
 * It used to be a profile summary with links to modules. That was correct for
 * Phase 1, when the product *was* a health record; it is wrong now that a band
 * is streaming vitals, because the first thing on screen was a blood group and
 * the first thing a patient wants is whether their oxygen is where it should
 * be.
 *
 * ── Order of the page, and why ─────────────────────────────────────────────
 *
 * 1. **An open emergency**, if there is one. Nothing else matters while
 *    somebody is waiting for a response.
 * 2. **A device not reporting**, if that is true. A quiet page from a band
 *    nobody is wearing must never read as good news.
 * 3. The score, the vitals, the observations, the alerts.
 *
 * Steps 1 and 2 are the two states a monitoring product must never render
 * calmly, so they are banners above everything rather than cards among it.
 */

const SEVERITY_TONE: Record<string, "critical" | "notice" | "default"> = {
  CRITICAL: "critical",
  WARNING: "notice",
  INFO: "default",
};

const VITAL_TONE = {
  NORMAL: "positive",
  WARNING: "notice",
  CRITICAL: "critical",
  UNKNOWN: "default",
} as const;

export default async function DashboardPage() {
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const supabase = await createClient();
  const centre = await loadCommandCenter(supabase, account.patientProfileId);

  const openEmergencies = centre.emergencies.filter((e) =>
    ["NEW", "ACKNOWLEDGED", "IN_PROGRESS"].includes(e.status),
  );
  const openAlerts = centre.alerts.filter((a) => a.status === "ACTIVE");

  const hrStatus = classifyVital("heartRate", centre.latest?.heartRate ?? null);
  const spo2Status = classifyVital("spo2", centre.latest?.spo2 ?? null);
  const tempStatus = classifyVital("temperature", centre.latest?.temperature ?? null);

  // Past this, the tiles are history rather than current values.
  const stale =
    centre.latest === null ||
    Date.now() - Date.parse(centre.latest.recordedAt) > 90_000;

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Health command centre</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">
          {firstNameOf(account.fullName)}
        </h1>
      </header>

      {openEmergencies.length > 0 && (
        <AlertBanner
          title={`${openEmergencies.length} emergency ${openEmergencies.length === 1 ? "event" : "events"} open`}
          timestamp={formatDate(openEmergencies[0].createdAt)}
        >
          {openEmergencies
            .map((e) => EMERGENCY_LABEL[e.eventType as EmergencyType] ?? e.eventType)
            .join(", ")}
          . Your care team has been notified. If you feel unwell now, call your doctor or
          emergency services — AVERIS is a monitoring system, not a response service.
        </AlertBanner>
      )}

      {centre.deviceCount === 0 ? (
        <AlertBanner tone="notice" title="No device registered">
          AVERIS is not monitoring anything yet.{" "}
          <Link href="/devices" className="font-semibold underline underline-offset-2">
            Register a device
          </Link>
        </AlertBanner>
      ) : (
        !centre.deviceReporting && (
          <AlertBanner
            tone="notice"
            title="Your device is not reporting"
            timestamp={
              centre.lastReadingAt ? `last reading ${formatDate(centre.lastReadingAt)}` : undefined
            }
          >
            {/* The sentence this banner exists for. A calm page produced by a
                band in a drawer is the most misleading thing this product
                could show. */}
            Nothing is being measured right now, so anything below describes the past rather
            than the present.
          </AlertBanner>
        )
      )}

      <div className="grid gap-6 lg:grid-cols-[1.15fr_1fr]">
        <Card>
          <CardHeader
            eyebrow="Current status"
            title="How your monitoring looks"
            action={
              <Link href="/monitoring" className="mono text-[12.5px] text-brand hover:underline">
                live view →
              </Link>
            }
          />
          <HealthScoreCard score={centre.score} />
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader
              eyebrow="Live vitals"
              title="Most recent reading"
              action={
                centre.latest ? (
                  <span className="mono text-[12px] text-muted">
                    {formatDate(centre.latest.recordedAt)}
                  </span>
                ) : null
              }
            />
            {centre.latest ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-5 px-6 py-5">
                <StatTile
                  label="Heart rate"
                  value={centre.latest.heartRate}
                  unit="BPM"
                  tone={VITAL_TONE[hrStatus]}
                  footnote={STATUS_LABEL[hrStatus]}
                  stale={stale}
                />
                <StatTile
                  label="Blood oxygen"
                  value={centre.latest.spo2}
                  unit="%"
                  tone={VITAL_TONE[spo2Status]}
                  footnote={STATUS_LABEL[spo2Status]}
                  stale={stale}
                />
                <StatTile
                  label="Temperature"
                  value={centre.latest.temperature}
                  unit="°C"
                  precision={1}
                  tone={VITAL_TONE[tempStatus]}
                  footnote={STATUS_LABEL[tempStatus]}
                  stale={stale}
                />
                <div className={stale ? "opacity-55" : undefined}>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                    Movement
                  </dt>
                  <dd className="mt-1.5 text-[19px] font-semibold leading-none">
                    {centre.latest.movementStatus.toLowerCase().replace(/_/g, " ")}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="px-6 py-6 text-[14px] leading-relaxed text-muted">
                No readings yet. AVERIS never fills these in with placeholder values — a number
                here always came from your device.
              </p>
            )}
          </Card>

          <Card>
            <CardHeader eyebrow="Health intelligence" title="What AVERIS noticed" />
            {centre.insights.length === 0 ? (
              <p className="px-6 py-5 text-[14px] leading-relaxed text-ink-soft">
                {centre.score.score === null
                  ? "Nothing to analyse yet."
                  : "Your measurements have stayed inside published ranges over this period, and the engine found nothing worth reporting."}
              </p>
            ) : (
              <ul className="divide-y divide-rule">
                {centre.insights.map((insight) => (
                  <li key={insight.id} className="px-6 py-3.5">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <Chip tone={SEVERITY_TONE[insight.severity] ?? "default"}>
                        {insight.severity.toLowerCase()}
                      </Chip>
                      <span className="mono text-[11.5px] text-muted">
                        {formatDate(insight.createdAt)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[14px] leading-relaxed">{insight.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader
          eyebrow="Alerts"
          title="Recent alerts"
          action={
            <span className="mono text-[12.5px] text-muted">
              {openAlerts.length} open · last {centre.score.windowHours}h
            </span>
          }
        />
        {centre.alerts.length === 0 ? (
          <p className="px-6 py-5 text-[14px] text-muted">
            No threshold alerts in this period.
          </p>
        ) : (
          <ul className="divide-y divide-rule">
            {centre.alerts.slice(0, 6).map((alert) => (
              <li key={alert.id} className="px-6 py-3.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Chip tone={SEVERITY_TONE[alert.severity] ?? "default"}>
                    {alert.severity.toLowerCase()}
                  </Chip>
                  <Chip>{alert.status.toLowerCase()}</Chip>
                  <span className="mono text-[11.5px] text-muted">
                    {formatDate(alert.createdAt)}
                  </span>
                </div>
                <p className="mt-1.5 text-[14px] leading-relaxed">{alert.message}</p>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-rule px-6 py-3.5">
          <p className="text-[12.5px] leading-relaxed text-muted">
            Each alert names the value measured and the threshold it crossed. Thresholds are
            published escalation triggers for a resting adult, not a judgement about you.
          </p>
        </div>
      </Card>

      {centre.risk === null && centre.score.score !== null && (
        <Callout tone="brand" title="No AI assessment yet">
          The risk engine runs over a window of readings. Once enough have arrived it appears
          on{" "}
          <Link href="/monitoring" className="font-semibold underline underline-offset-2">
            live monitoring
          </Link>{" "}
          with the measurements that produced it.
        </Callout>
      )}

      <p className="pb-2 text-[13px] leading-relaxed text-muted">
        AVERIS reports what your device measured and the thresholds those measurements
        crossed. It does not diagnose, and it is not a substitute for medical advice.
      </p>
    </div>
  );
}

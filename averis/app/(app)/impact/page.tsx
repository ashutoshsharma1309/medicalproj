import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { loadImpact, IMPACT_DISCLAIMER, provenanceCaption } from "@/lib/impact/impact-service";
import { Card, CardHeader, Callout, Chip } from "@/components/ui";
import type { SplitCount } from "@/lib/impact/impact-metrics";

export const metadata = { title: "Prototype metrics" };
export const dynamic = "force-dynamic";

/**
 * What this prototype has actually done.
 *
 * ── Why the page is called "Prototype metrics" and not "Impact" ────────────
 *
 * Because it is not impact. Impact would be a change in someone's health, and
 * AVERIS has never treated a patient. What this page can honestly show is the
 * system's own operation: readings ingested, alerts raised, how quickly a
 * reading became an alert.
 *
 * The temptation in a hackathon is the other page — "12,000 lives could be
 * monitored", "40% faster intervention" — and every figure on it would be
 * invented. That is the same act as inventing a clinical accuracy claim, which
 * this codebase has refused since Phase 3.
 *
 * ── Every number is split by provenance ────────────────────────────────────
 *
 * Not totalled with a footnote. Split into two columns, both shown, because in
 * a demonstration most rows are simulated and a combined total flatters by
 * construction. A judge reading this should be able to see the shape of the
 * evidence without asking a question.
 */
export default async function ImpactPage() {
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const supabase = await createClient();
  const metrics = await loadImpact(supabase, account.patientProfileId);

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">AVERIS</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">Prototype metrics</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          What this system has processed. Not what it has achieved for anyone&apos;s health —
          AVERIS has no outcome data and makes no claim about one.
        </p>
      </header>

      {/* The caveat above the numbers, not below them. A reader who stops after
          the first panel must still have seen it. */}
      <Callout tone="notice" title="What these figures are">
        <p className="text-[14px] leading-relaxed">{IMPACT_DISCLAIMER}</p>
      </Callout>

      <Callout tone="brand" title="Provenance">
        <p className="text-[14px] leading-relaxed">{provenanceCaption(metrics)}</p>
      </Callout>

      {/* ------------------------------------------------------------ counts */}
      <Card>
        <CardHeader
          eyebrow="Split by where the data came from — never combined into one total"
          title="What has been processed"
        />

        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-[14px]">
            <thead className="border-b border-line text-left text-[13px] text-ink-soft">
              <tr>
                <th className="py-2 pr-4 font-medium">Measure</th>
                <th className="py-2 pr-4 font-medium text-right">From a device</th>
                <th className="py-2 pr-4 font-medium text-right">Simulated</th>
              </tr>
            </thead>
            <tbody>
              <Row label="Accounts that have produced readings" value={metrics.accountsWithReadings} />
              <Row label="Readings ingested" value={metrics.readings} />
              <Row label="Alerts raised" value={metrics.alerts} />
              <Row label="Of those, critical" value={metrics.criticalAlerts} />
              <Row label="Emergencies opened" value={metrics.emergencies} />
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
          These are the figures for your own account. AVERIS has no deployment-wide view here,
          because producing one would need the service-role key the web application deliberately
          does not hold.
        </p>
      </Card>

      {/* ----------------------------------------------------------- latency */}
      <Card>
        <CardHeader
          eyebrow="Reading received → alert exists. Inside the system, not out in the world."
          title="Detection latency"
        />

        {metrics.detectionLatency.medianMs === null ? (
          // Never a zero. Zero milliseconds reads as an instantaneous system;
          // this says which of the two situations it actually is.
          <p className="text-[14px] leading-relaxed text-ink-soft">
            {metrics.detectionLatency.unavailableReason}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-10 gap-y-4">
              <Stat
                label="Median"
                value={`${(metrics.detectionLatency.medianMs / 1000).toFixed(2)} s`}
              />
              <Stat
                label="95th percentile"
                value={`${(metrics.detectionLatency.p95Ms! / 1000).toFixed(2)} s`}
              />
              <Stat label="Alerts measured" value={String(metrics.detectionLatency.n)} />
            </div>

            {metrics.detectionLatency.unavailableReason && (
              <p className="mt-3 text-[13px] text-ink-soft">
                {metrics.detectionLatency.unavailableReason}
              </p>
            )}
          </>
        )}

        <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">
          Median and 95th percentile rather than an average. A mean is compatible with one alert
          in twenty taking a minute, and for an alerting system the slow tail is the whole
          question. <strong>This is not clinical response time</strong> — it does not include a
          clinician reading the alert or reaching the patient, and AVERIS cannot measure that.
        </p>
      </Card>

      {/* -------------------------------------------------------- follow-up */}
      <Card>
        <CardHeader eyebrow="What happened after an emergency was opened" title="Follow-up" />

        <div className="flex flex-wrap gap-x-10 gap-y-4">
          <Stat
            label="Emergencies acknowledged by a person"
            value={String(metrics.emergenciesAcknowledged)}
          />
          <Stat label="Days of data" value={String(metrics.daysOfData)} />
        </div>

        <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">
          Acknowledgement is a human action recorded in the database. It is the closest thing here
          to evidence that the system reached somebody — and it says the notice was opened, not
          that anyone was helped.
        </p>
      </Card>

      <Callout tone="notice" title="What would make these into real impact figures">
        <p className="text-[14px] leading-relaxed">
          A deployment, a defined cohort, and outcome data — whether the patients AVERIS flagged
          actually deteriorated, and whether the flag changed what happened to them. None of that
          exists. Until it does, no number on this page should appear in a sentence containing the
          word &ldquo;lives&rdquo;.
        </p>
      </Callout>
    </div>
  );
}

function Row({ label, value }: { label: string; value: SplitCount }) {
  return (
    <tr className="border-b border-line last:border-0">
      <td className="py-2.5 pr-4">{label}</td>
      <td className="py-2.5 pr-4 text-right tabular-nums font-semibold">
        {value.measured.toLocaleString()}
      </td>
      <td className="py-2.5 pr-4 text-right tabular-nums text-ink-soft">
        {value.simulated.toLocaleString()}
        {value.simulated > 0 && (
          <Chip tone="default">
            <span className="ml-2">demo</span>
          </Chip>
        )}
      </td>
    </tr>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[13px] text-ink-soft">{label}</p>
      <p className="mt-0.5 text-[22px] font-semibold tabular-nums">{value}</p>
    </div>
  );
}

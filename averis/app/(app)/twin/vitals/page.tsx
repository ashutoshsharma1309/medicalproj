import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, Chip, Callout } from "@/components/ui";
import { AlertBanner, Meter } from "@/components/ui/clinical";
import { BaselineComparison } from "@/components/health/BaselineComparison";
import { RiskTimeline } from "@/components/health/RiskTimeline";
import { loadVitalsTwin } from "@/lib/health/twin-service";
import { CHANNEL_LABEL, CHANNEL_UNIT } from "@/lib/health/baseline";
import { formatDate } from "@/lib/utils/format";

export const metadata = { title: "Health Twin — vitals" };
export const dynamic = "force-dynamic";

/**
 * The vitals Health Twin.
 *
 * ── The question this page exists to answer ────────────────────────────────
 *
 * "Is this normal **for me**?" — which no page built on published ranges can
 * answer. A heart rate of 105 is inside every published range and raises no
 * alert; for a patient who sits at 72 it is the most interesting number on
 * their chart that day.
 *
 * ── Two twins, and why they are separate pages ─────────────────────────────
 *
 * `/twin` is the records twin: conditions, medications, documents — assembled
 * from what the patient confirmed. This is the vitals twin: what their body
 * usually does, learned from the sensor stream. They describe the same person
 * from different evidence, and a page that blended them could not tell a
 * reader which kind of claim it was making.
 *
 * ── What it says when it knows nothing ─────────────────────────────────────
 *
 * The most important state on this page is the one with no baseline. It says
 * so plainly and explains what is missing, because a personalisation feature
 * that quietly renders defaults teaches people to trust a normal nobody
 * learned.
 */
export default async function VitalsTwinPage() {
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const supabase = await createClient();
  const twin = await loadVitalsTwin(supabase, account.patientProfileId);

  const concerning = twin.trends.filter((t) => t.concerning);

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Health Twin · vitals</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">
          What is normal for you
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          AVERIS learns your own usual range from your readings, so it can tell you when
          something is unusual <em>for you</em> — not only when it crosses a threshold set for
          everybody.
        </p>
      </header>

      {twin.deviations.length > 0 && (
        <AlertBanner
          tone={twin.deviations[0].severity === "MARKED" ? "critical" : "notice"}
          title="Different from your usual"
          timestamp={twin.current ? formatDate(twin.current.recordedAt) : undefined}
        >
          <ul className="space-y-1">
            {twin.deviations.map((finding) => (
              <li key={finding.channel}>{finding.message}</li>
            ))}
          </ul>
        </AlertBanner>
      )}

      {twin.deteriorations.length > 0 && (
        <AlertBanner
          tone={twin.deteriorations.some((d) => d.severity === "CONCERNING") ? "critical" : "notice"}
          title="Your usual level has shifted"
        >
          <ul className="space-y-1">
            {twin.deteriorations.map((finding) => (
              <li key={finding.channel}>{finding.message}</li>
            ))}
          </ul>
        </AlertBanner>
      )}

      <Card>
        <CardHeader
          eyebrow="Baseline"
          title="Your normal, and where you are now"
          action={
            twin.baseline ? (
              <span className="mono text-[12.5px] text-muted">
                learned from {twin.baseline.daysCovered} days
              </span>
            ) : null
          }
        />

        {twin.baseline ? (
          <>
            <BaselineComparison
              baseline={twin.baseline}
              current={{
                heartRate: twin.current?.heartRate ?? null,
                spo2: twin.current?.spo2 ?? null,
                temperature: twin.current?.temperature ?? null,
              }}
            />
            <div className="border-t border-rule px-6 py-4">
              <Meter
                value={twin.baseline.confidence * 100}
                tone={twin.baseline.confidence >= 0.7 ? "positive" : "notice"}
                label="How well AVERIS knows you"
                valueLabel={`${Math.round(twin.baseline.confidence * 100)}%`}
                compact
              />
              <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
                {twin.baseline.confidence >= 0.7
                  ? "Enough days of monitoring to describe your usual with confidence."
                  : "Still learning. The more days you wear the band, the better AVERIS knows what is normal for you."}
              </p>
            </div>
          </>
        ) : (
          <div className="px-6 py-5">
            <p className="text-[14.5px] leading-relaxed">{twin.baselineUnavailable}</p>
            <p className="mt-3 text-[13px] leading-relaxed text-muted">
              Until then AVERIS still monitors you against published thresholds — those apply
              to everybody and do not need a baseline.{" "}
              <Link href="/monitoring" className="text-brand hover:underline">
                Live monitoring
              </Link>
            </p>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          eyebrow="Trends"
          title="Which way things are moving"
          action={
            <span className="mono text-[12.5px] text-muted">
              {concerning.length > 0 ? `${concerning.length} worth watching` : "all steady"}
            </span>
          }
        />
        {twin.trends.length === 0 ? (
          <p className="px-6 py-5 text-[14px] leading-relaxed text-muted">
            No trends yet. AVERIS needs at least four days with enough readings in each before
            it will describe a direction — a line through two points is not a trend.
          </p>
        ) : (
          <ul className="divide-y divide-rule">
            {twin.trends.map((trend) => (
              <li key={trend.channel} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-6 py-3.5">
                <span className="flex items-center gap-2.5">
                  <span aria-hidden="true" className="mono text-[13px]">
                    {trend.direction === "RISING" ? "↗" : trend.direction === "FALLING" ? "↘" : "→"}
                  </span>
                  <span className="text-[14px]">{CHANNEL_LABEL[trend.channel]}</span>
                  {trend.concerning && <Chip tone="notice">worth watching</Chip>}
                </span>

                <span className="mono text-[12.5px] tabular-nums text-muted">
                  {trend.direction === "STEADY"
                    ? "steady"
                    : `${trend.slopePerDay > 0 ? "+" : ""}${trend.slopePerDay}${CHANNEL_UNIT[trend.channel]} per day`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          eyebrow="History"
          title="Your health timeline"
          action={
            <span className="mono text-[12.5px] text-muted">{twin.timeline.length} entries</span>
          }
        />
        <RiskTimeline entries={twin.timeline} />
      </Card>

      <Callout tone="brand" title="How your baseline is learned">
        From up to 30 days of readings, ending 48 hours ago. The gap matters: if AVERIS
        learned from today, a change happening today would become part of your normal and
        there would be nothing to notice. Readings taken during alerts or emergencies are left
        out, so your baseline describes you well rather than unwell.
      </Callout>

      <p className="pb-2 text-[13px] leading-relaxed text-muted">
        A personal baseline never raises a safety threshold. If a reading crosses a published
        escalation line it is treated as critical whatever your usual is — personalisation
        adds findings, it never removes them.
      </p>
    </div>
  );
}

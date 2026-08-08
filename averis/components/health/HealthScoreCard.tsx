import Link from "next/link";
import { Meter } from "@/components/ui/clinical";
import {
  BAND_LABEL,
  BAND_MEANING,
  type HealthScore,
  type HealthScoreBand,
} from "@/lib/health/health-score";

/**
 * The health score, and everything that stops it being a black box.
 *
 * ── Why the caption is not decoration ──────────────────────────────────────
 *
 * "82/100" reads as a clinical assessment whatever is written around it, so
 * the framing does as much work as it can: the label is "Monitoring score",
 * the period is stated on the same line, and the factors are expanded
 * underneath rather than hidden behind a toggle.
 *
 * The component also refuses to render a number when the score module returns
 * null. A dash with an explanation is the honest output for a band nobody
 * wore — the failure this whole feature has to avoid is "nobody measured
 * anything" and "everything is fine" looking identical on screen.
 */

const BAND_TONE: Record<HealthScoreBand, "positive" | "notice" | "critical"> = {
  STABLE: "positive",
  WATCH: "notice",
  ELEVATED: "notice",
  CRITICAL: "critical",
};

const BAND_GLYPH: Record<HealthScoreBand, string> = {
  STABLE: "●",
  WATCH: "▲",
  ELEVATED: "▲",
  CRITICAL: "■",
};

export function HealthScoreCard({ score }: { score: HealthScore }) {
  if (score.score === null) {
    return (
      <div className="px-6 py-5">
        <div className="flex items-baseline gap-3">
          <span className="mono text-[38px] font-semibold leading-none text-muted">—</span>
          <span className="text-[15px] text-ink-soft">No score for this period</span>
        </div>
        <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-ink-soft">
          {score.unavailableReason}
        </p>
        <p className="mt-3 text-[13px] leading-relaxed text-muted">
          AVERIS does not estimate a score from too little data.{" "}
          <Link href="/devices" className="text-brand hover:underline">
            Check your device
          </Link>
        </p>
      </div>
    );
  }

  const tone = BAND_TONE[score.band];

  return (
    <div className="px-6 py-5">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            Monitoring score · last {score.windowHours} hours
          </p>
          <p className="mono mt-1.5 text-[46px] font-semibold leading-none tabular-nums">
            {score.score}
            <span className="ml-1.5 text-[18px] font-normal text-muted">/100</span>
          </p>
        </div>

        <div className="flex-1">
          <p
            className={`flex items-center gap-2 text-[17px] font-semibold ${
              tone === "critical"
                ? "text-[var(--color-critical)]"
                : tone === "notice"
                  ? "text-[var(--color-notice)]"
                  : "text-[var(--color-positive)]"
            }`}
          >
            {/* Shape as well as colour — the amber and red tokens are
                indistinguishable under deuteranopia. */}
            <span aria-hidden="true">{BAND_GLYPH[score.band]}</span>
            {BAND_LABEL[score.band]}
          </p>
          <p className="mt-1 max-w-lg text-[13.5px] leading-relaxed text-ink-soft">
            {BAND_MEANING[score.band]}
          </p>
        </div>
      </div>

      <p className="eyebrow mb-3 mt-6">What this is made of</p>

      <ul className="space-y-3">
        {score.factors.map((factor) => (
          <li key={factor.key}>
            <Meter
              value={factor.points}
              max={factor.weight * 100}
              tone={factor.attained >= 0.85 ? "positive" : factor.attained >= 0.6 ? "notice" : "critical"}
              label={factor.label}
              valueLabel={`${Math.round(factor.points)} of ${Math.round(factor.weight * 100)}`}
              compact
            />
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{factor.detail}</p>
          </li>
        ))}
      </ul>

      <p className="mt-5 border-t border-rule pt-4 text-[13px] leading-relaxed text-muted">
        This is a summary of what AVERIS <em>measured</em> — how much of the period was
        monitored, whether readings sat inside published ranges, and what the risk engine
        found. It is not a clinical assessment, it knows nothing about your medical history,
        and nothing in your care is decided by it.
      </p>
    </div>
  );
}

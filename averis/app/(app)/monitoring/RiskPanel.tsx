import { Chip } from "@/components/ui";

/**
 * The AI risk assessment.
 *
 * Two things this panel refuses to do.
 *
 * **It never shows a risk score without its contributions.** A number on its
 * own is an assertion; the same number with "SpO2 88% contributed 62% of this"
 * beside it is a claim someone can check and disagree with. The whole reason
 * the engine is additive rather than boosted is so this list can be exact, and
 * hiding it behind a disclosure would waste that.
 *
 * **It never presents confidence as accuracy.** The engine's confidence is how
 * much measured data the score rested on, not how often it is right — there is
 * no outcome data here to have measured that against. The label says so.
 */

export type RiskContribution = {
  feature: string;
  label: string;
  points: number;
  share_percent: number;
  observed: number | null;
  threshold: number | null;
  coverage: number;
  detail: string;
};

export type RiskPayload = {
  risk_score: number;
  risk_level: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  confidence: number;
  explanation: string[];
  contributions: RiskContribution[];
  disclaimer: string;
  data_quality?: { retained_fraction: number; kept: number };
};

const LEVEL_TONE: Record<RiskPayload["risk_level"], "positive" | "notice" | "critical"> = {
  LOW: "positive",
  MODERATE: "notice",
  HIGH: "critical",
  CRITICAL: "critical",
};

// Shape as well as colour, for the same reason as the vital cards: AVERIS's
// amber and red are indistinguishable under deuteranopia.
const LEVEL_GLYPH: Record<RiskPayload["risk_level"], string> = {
  LOW: "●",
  MODERATE: "▲",
  HIGH: "■",
  CRITICAL: "■",
};

export function RiskPanel({ risk }: { risk: RiskPayload }) {
  const percent = Math.round(risk.risk_score * 100);

  return (
    <div className="px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            Health risk indicator
          </p>
          <p className="mono mt-2 text-[34px] font-semibold leading-none">
            {percent}
            <span className="ml-1 text-[16px] font-normal text-muted">%</span>
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-[13.5px] font-medium">
            <span aria-hidden="true">{LEVEL_GLYPH[risk.risk_level]}</span>
            <Chip tone={LEVEL_TONE[risk.risk_level]}>{risk.risk_level.toLowerCase()}</Chip>
          </p>
        </div>

        <div className="text-right">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            Data confidence
          </p>
          <p className="mono mt-2 text-[20px] font-semibold leading-none">
            {Math.round(risk.confidence * 100)}%
          </p>
          <p className="mt-2 max-w-[15rem] text-[11.5px] leading-relaxed text-muted">
            How much measured data this rested on — not how often AVERIS is right.
          </p>
        </div>
      </div>

      {risk.contributions.length > 0 ? (
        <div className="mt-6 border-t border-rule pt-5">
          <p className="eyebrow mb-3">What contributed</p>

          <ul className="space-y-3">
            {risk.contributions.map((c) => (
              <li key={c.feature}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="text-[13.5px] font-medium">{c.label}</span>
                  <span className="mono text-[12.5px] text-muted">
                    {c.share_percent.toFixed(0)}% of this score
                  </span>
                </div>

                {/* A thin bar, not a filled block. The share is the number
                    beside it; the bar only makes the ordering scannable. */}
                <div
                  className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-sunken"
                  role="presentation"
                >
                  <div
                    className="h-full rounded-full bg-brand"
                    style={{ width: `${Math.min(100, c.share_percent)}%` }}
                  />
                </div>

                <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">{c.detail}</p>

                {c.coverage < 0.5 && (
                  <p className="mt-1 text-[11.5px] text-muted">
                    Based on limited data — {Math.round(c.coverage * 100)}% of the window
                    carried readings.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="mt-6 border-t border-rule pt-5">
          <p className="text-[14px] leading-relaxed text-ink-soft">
            {risk.explanation[0] ??
              "All monitored vital signs are within their usual ranges."}
          </p>
        </div>
      )}

      <p className="mt-5 border-t border-rule pt-4 text-[12.5px] leading-relaxed text-muted">
        {risk.disclaimer}
      </p>
    </div>
  );
}

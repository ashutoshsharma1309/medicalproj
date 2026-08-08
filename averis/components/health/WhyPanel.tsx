import { Meter, TONE_GLYPH, type Tone } from "@/components/ui/clinical";

/**
 * "Why did AVERIS detect this?"
 *
 * The panel the product's whole position rests on. AVERIS is not claiming to
 * be more accurate than anything else — it is claiming that every number it
 * shows can be taken apart, and this is where that claim is either honoured or
 * exposed as marketing.
 *
 * ── Three decisions, each of which costs something ─────────────────────────
 *
 * **Contributions are shown expanded, never behind a disclosure.** A "details"
 * toggle is where explanations go to be ignored: the reader has already
 * accepted the number by the time they decide whether to click. The cost is a
 * taller panel, which is the correct thing to spend space on here.
 *
 * **Each row carries the measurement, not just the weight.** "SpO₂ decreasing
 * +35%" is a claim about the model. "SpO₂ 88%, below the 90% threshold —
 * contributed 35%" is a claim about the patient, and a clinician can disagree
 * with the second one. Disagreement is the point.
 *
 * **The shares are exact, not attributed.** The engine is additive precisely so
 * these numbers are arithmetic rather than an estimate of what a model might
 * have been doing. A boosted model with SHAP approximations would score
 * marginally better and would make this panel a guess about a guess.
 */

export type WhyFactor = {
  /** What moved. */
  label: string;
  /** Percentage of the total this accounted for, 0–100. */
  sharePercent: number;
  /** The measurement behind it, in the patient's own units. */
  observed?: string;
  /** The line the measurement crossed, if it crossed one. */
  threshold?: string;
  /** How much measured data backed this factor, 0–1. */
  coverage?: number;
  /** One sentence someone can check. */
  detail?: string;
};

export function WhyPanel({
  headline,
  score,
  scoreLabel,
  tone = "notice",
  factors,
  confidence,
  confidenceCaption,
  footnote,
}: {
  /** "Why is this patient high risk?" — phrased as the reader's question. */
  headline: string;
  /** 0–100. */
  score: number;
  scoreLabel: string;
  tone?: Tone;
  factors: WhyFactor[];
  /** 0–1, or null when the engine did not report one. */
  confidence?: number | null;
  confidenceCaption?: string;
  footnote?: string;
}) {
  const ranked = [...factors].sort((a, b) => b.sharePercent - a.sharePercent);
  const accounted = ranked.reduce((sum, f) => sum + f.sharePercent, 0);

  return (
    <div className="px-6 py-5">
      <p className="text-[15px] font-semibold leading-tight">{headline}</p>

      <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            {scoreLabel}
          </p>
          <p className="mono mt-1 text-[38px] font-semibold leading-none tabular-nums">
            {score}
            <span className="ml-1 text-[16px] font-normal text-muted">%</span>
          </p>
        </div>

        {confidence !== null && confidence !== undefined && (
          <div className="min-w-[180px] flex-1">
            <Meter
              value={confidence * 100}
              tone="default"
              label="Confidence"
              valueLabel={`${Math.round(confidence * 100)}%`}
              compact
            />
            {/* Never presented as accuracy. The engine's confidence is how much
                measured data the score rested on — there is no outcome data
                here against which anyone could have measured how often it is
                right. */}
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
              {confidenceCaption ??
                "How much measured data this rested on — not how often AVERIS is right."}
            </p>
          </div>
        )}
      </div>

      <p className="eyebrow mb-3 mt-6">What produced this</p>

      {ranked.length === 0 ? (
        <p className="text-[14px] text-muted">
          The engine recorded no individual contributing factors for this
          assessment.
        </p>
      ) : (
        <ul className="space-y-3.5">
          {ranked.map((factor) => (
            <li key={factor.label}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="flex items-center gap-2 text-[14px]">
                  <span aria-hidden="true" className="text-muted">
                    {TONE_GLYPH[tone]}
                  </span>
                  {factor.label}
                </span>
                <span className="mono text-[13px] font-semibold tabular-nums">
                  +{Math.round(factor.sharePercent)}%
                </span>
              </div>

              <div className="mt-1.5">
                <Meter value={factor.sharePercent} tone={tone} compact />
              </div>

              {(factor.observed || factor.threshold || factor.detail) && (
                <p className="mono mt-1.5 text-[11.5px] leading-relaxed text-muted">
                  {factor.observed && <>measured {factor.observed}</>}
                  {factor.observed && factor.threshold && " · "}
                  {factor.threshold && <>threshold {factor.threshold}</>}
                  {(factor.observed || factor.threshold) && factor.detail && " · "}
                  {factor.detail}
                </p>
              )}

              {/* Coverage below 60% means the factor rested on very little
                  data. Saying so is what keeps a thin signal from reading like
                  a strong one purely because it has a bar next to it. */}
              {factor.coverage !== undefined && factor.coverage < 0.6 && (
                <p className="mt-1 text-[11.5px] text-[var(--color-notice)]">
                  Based on limited data — {Math.round(factor.coverage * 100)}% coverage.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Contributions that do not sum to the whole are stated, not hidden.
          The remainder is baseline, and a reader adding the bars up and
          finding 88% deserves to know why rather than to wonder. */}
      {ranked.length > 0 && accounted < 97 && (
        <p className="mt-4 text-[12.5px] leading-relaxed text-muted">
          These account for {Math.round(accounted)}% of the score. The remainder is
          the engine&rsquo;s baseline, which every assessment carries.
        </p>
      )}

      <p className="mt-5 border-t border-rule pt-4 text-[13px] leading-relaxed text-muted">
        {footnote ??
          "AVERIS reports measurements and the thresholds they crossed. It does not diagnose, and this score is not a clinical assessment."}
      </p>
    </div>
  );
}

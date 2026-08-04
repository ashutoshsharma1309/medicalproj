import type { RiskCategory } from "@/lib/ml/types";

/**
 * A risk figure.
 *
 * Deliberately restrained. The temptation with a percentage is a large
 * coloured dial, and a large red dial tells a patient they are sick — which is
 * exactly the reading this number cannot support. The figure is set in the
 * same weight as the rest of the page, the band is named in words as well as
 * colour, and the confidence sits directly beneath rather than in a footnote.
 */

const TONE: Record<RiskCategory, { colour: string; wash: string }> = {
  LOW: { colour: "var(--color-brand)", wash: "var(--color-wash)" },
  MODERATE: { colour: "var(--color-notice)", wash: "var(--color-notice-wash)" },
  HIGH: { colour: "var(--color-critical)", wash: "var(--color-critical-wash)" },
};

export function RiskGauge({
  percent,
  category,
  categoryLabel,
  confidence,
}: {
  percent: number;
  category: RiskCategory;
  categoryLabel: string;
  confidence: number;
}) {
  const tone = TONE[category];

  return (
    <div>
      <div className="flex items-baseline gap-3">
        <span className="mono text-[34px] font-semibold leading-none" style={{ color: tone.colour }}>
          {percent}%
        </span>
        <span
          className="rounded-full px-2.5 py-1 text-[12px] font-semibold"
          style={{ background: tone.wash, color: tone.colour }}
        >
          {categoryLabel} range
        </span>
      </div>

      <div
        className="mt-3.5 h-1.5 w-full overflow-hidden rounded-full bg-sunken"
        role="meter"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Model estimate: ${percent} percent, ${categoryLabel} range`}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(2, percent)}%`, background: tone.colour }}
        />
      </div>

      <p className="mt-2.5 text-[12.5px] text-muted">
        <span className="mono">{Math.round(confidence * 100)}%</span> of this estimate rests on
        your own measurements
      </p>
    </div>
  );
}

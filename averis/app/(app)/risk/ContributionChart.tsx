import type { FeatureContribution } from "@/lib/ml/types";

/**
 * SHAP contributions as a diverging bar chart.
 *
 * A horizontal axis with a zero line down the middle: bars to the right raised
 * the estimate, bars to the left lowered it, and length is proportional to the
 * Shapley value. This is the standard SHAP force layout, drawn in CSS rather
 * than pulled from a charting library — it is two divs and a percentage, and a
 * chart dependency would be more code than the chart.
 *
 * Imputed features are hatched and labelled, because a bar that looks like
 * measured data but came from a population average is the most misleading
 * thing this chart could render.
 */
export function ContributionChart({
  contributions,
}: {
  contributions: FeatureContribution[];
}) {
  if (contributions.length === 0) {
    return (
      <p className="px-6 py-8 text-center text-[14px] text-muted">
        No input moved this estimate enough to be worth showing.
      </p>
    );
  }

  const widest = Math.max(...contributions.map((c) => Math.abs(c.share)));

  return (
    <div className="px-6 py-5">
      <div className="mb-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
        <span>← lowers estimate</span>
        <span>raises estimate →</span>
      </div>

      <ul className="space-y-3">
        {contributions.map((contribution) => {
          const magnitude = widest === 0 ? 0 : (Math.abs(contribution.share) / widest) * 50;
          const raises = contribution.direction === "increases";
          const colour = raises ? "var(--color-critical)" : "var(--color-brand)";

          return (
            <li key={contribution.name}>
              <div className="flex items-baseline justify-between gap-4 text-[13.5px]">
                <span className="font-medium">
                  {contribution.label}
                  {contribution.imputed && (
                    <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                      averaged
                    </span>
                  )}
                </span>
                <span className="mono shrink-0 text-[13px]" style={{ color: colour }}>
                  {raises ? "+" : "−"}
                  {Math.abs(Math.round(contribution.share * 100))}%
                </span>
              </div>

              {/* Zero line at 50%; bars grow outward from it. */}
              <div className="relative mt-1.5 h-2.5 w-full rounded-sm bg-sunken">
                <div className="absolute inset-y-0 left-1/2 w-px bg-rule-strong" aria-hidden="true" />
                <div
                  className="absolute inset-y-0 rounded-sm"
                  style={{
                    background: colour,
                    opacity: contribution.imputed ? 0.4 : 1,
                    left: raises ? "50%" : `${50 - magnitude}%`,
                    width: `${magnitude}%`,
                  }}
                  aria-hidden="true"
                />
              </div>

              <p className="mt-1 text-[12px] text-muted">
                {contribution.imputed
                  ? "Population average — your records did not supply this."
                  : `Your value: ${formatValue(contribution.value)}${
                      contribution.unit ? ` ${contribution.unit}` : ""
                    }`}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

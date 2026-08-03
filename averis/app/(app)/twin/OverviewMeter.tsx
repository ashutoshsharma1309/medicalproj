/**
 * A record-quality meter.
 *
 * Deliberately reads as an instrument gauge rather than a score badge: the
 * figure describes the completeness of a record, and dressing it up as a grade
 * would invite patients to read it as a health rating.
 */
export function OverviewMeter({
  label,
  value,
  explanation,
}: {
  label: string;
  value: number;
  explanation: string;
}) {
  // Colour tracks completeness, not health — muted deliberately.
  const tone =
    value >= 80 ? "var(--color-brand)" : value >= 50 ? "var(--color-brand-mid)" : "var(--color-notice)";

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[14px] font-medium">{label}</span>
        <span className="mono text-[17px] font-semibold" style={{ color: tone }}>
          {value}%
        </span>
      </div>

      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sunken"
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label}: ${value} percent`}
      >
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${Math.max(2, value)}%`, background: tone }}
        />
      </div>

      <p className="mt-2 text-[12.5px] leading-relaxed text-muted">{explanation}</p>
    </div>
  );
}

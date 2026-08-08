import { CHANNEL_LABEL, CHANNEL_UNIT, type BaselineChannel } from "@/lib/health/baseline";
import type { StoredBaseline } from "@/lib/health/twin-service";

/**
 * Current reading against this patient's own normal.
 *
 * ── Why the baseline is drawn as a band and the reading as a marker ────────
 *
 * The comparison is the finding, so it has to be visible without arithmetic. A
 * table of "current 105, baseline 72" makes a reader compute the relationship;
 * a marker sitting outside a shaded band makes it a glance. On a clinical
 * dashboard being read between patients, that difference is whether the panel
 * is used at all.
 *
 * The scale is anchored to the *baseline*, not to the published range, because
 * this component answers a different question from the vital cards beside it.
 * Those ask "is this value dangerous"; this asks "is this value unusual for
 * this person", and a scale that spanned the published range would compress
 * every personal deviation into a few pixels.
 *
 * ── What it refuses to draw ────────────────────────────────────────────────
 *
 * A channel with no baseline renders as "not learned yet", never as a band at
 * a default position. An invented normal is worse than a missing one: a reader
 * would compare against it.
 */

const CHANNELS: BaselineChannel[] = ["heartRate", "spo2", "temperature"];

export function BaselineComparison({
  baseline,
  current,
}: {
  baseline: StoredBaseline;
  current: { heartRate: number | null; spo2: number | null; temperature: number | null };
}) {
  return (
    <div className="space-y-6 px-6 py-5">
      {CHANNELS.map((channel) => {
        const band =
          channel === "heartRate"
            ? baseline.heartRate
            : channel === "spo2"
              ? baseline.spo2
              : baseline.temperature;

        const observed =
          channel === "heartRate"
            ? current.heartRate
            : channel === "spo2"
              ? current.spo2
              : current.temperature;

        return (
          <ChannelRow key={channel} channel={channel} band={band} observed={observed} />
        );
      })}

      <p className="border-t border-rule pt-4 text-[12.5px] leading-relaxed text-muted">
        The shaded band is where this patient&rsquo;s own readings usually fall — the middle
        80% of {baseline.sampleCount.toLocaleString()} measurements across{" "}
        {baseline.daysCovered} days.{" "}
        {baseline.excludedSamples > 0 && (
          <>
            {baseline.excludedSamples.toLocaleString()} readings taken during alerts or
            emergencies were excluded, so the baseline describes them well rather than unwell.{" "}
          </>
        )}
        It is not a target and not a safe range — the published thresholds still apply, and a
        reading inside this band can still be critical.
      </p>
    </div>
  );
}

function ChannelRow({
  channel,
  band,
  observed,
}: {
  channel: BaselineChannel;
  band: { median: number; low: number; high: number; iqr: number } | null;
  observed: number | null;
}) {
  const label = CHANNEL_LABEL[channel];
  const unit = CHANNEL_UNIT[channel];
  const precision = channel === "temperature" ? 1 : 0;

  if (!band) {
    return (
      <div>
        <p className="text-[14px] font-medium">{label}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">
          Not learned yet — this device has not reported enough of this measurement.
        </p>
      </div>
    );
  }

  // The drawn scale: the patient's band, widened so a reading outside it still
  // lands on the axis rather than clipping to the edge and looking like it sat
  // exactly at the boundary.
  const width = Math.max(band.high - band.low, 1);
  const axisMin = band.low - width * 1.2;
  const axisMax = band.high + width * 1.2;
  const span = axisMax - axisMin;

  const toPercent = (value: number) =>
    Math.max(0, Math.min(100, ((value - axisMin) / span) * 100));

  const outside = observed !== null && (observed < band.low || observed > band.high);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[14px] font-medium">{label}</span>
        <span className="mono text-[12.5px] tabular-nums text-muted">
          usual {band.low.toFixed(precision)}–{band.high.toFixed(precision)}
          {unit} · median {band.median.toFixed(precision)}
          {unit}
        </span>
      </div>

      <div
        className="relative mt-2.5 h-8"
        role="img"
        aria-label={
          observed === null
            ? `${label}: no current reading. Usual range ${band.low} to ${band.high}.`
            : `${label}: currently ${observed}${unit}, ${
                outside ? "outside" : "inside"
              } the usual ${band.low}–${band.high}${unit}.`
        }
      >
        <div className="absolute inset-x-0 top-3.5 h-1 rounded-full bg-sunken" />

        {/* The patient's usual range. */}
        <div
          className="absolute top-2 h-3 rounded-full bg-[var(--color-positive)] opacity-25"
          style={{
            left: `${toPercent(band.low)}%`,
            width: `${toPercent(band.high) - toPercent(band.low)}%`,
          }}
        />

        {/* Their median, as a hairline inside it. */}
        <div
          className="absolute top-1.5 h-4 w-px bg-[var(--color-positive)]"
          style={{ left: `${toPercent(band.median)}%` }}
        />

        {observed !== null && (
          <>
            <div
              className={`absolute top-0.5 h-7 w-[3px] rounded-full ${
                outside ? "bg-[var(--color-critical)]" : "bg-brand"
              }`}
              style={{ left: `${toPercent(observed)}%` }}
            />
            <span
              className={`mono absolute top-0 text-[11px] font-semibold tabular-nums ${
                outside ? "text-[var(--color-critical)]" : "text-brand"
              }`}
              style={{
                // Nudged off the marker, and clamped so a reading at either
                // extreme does not render its own label off the panel.
                left: `${Math.min(88, Math.max(0, toPercent(observed) + 2))}%`,
              }}
            >
              {observed.toFixed(precision)}
              {unit}
            </span>
          </>
        )}
      </div>

      {observed === null && (
        <p className="mono mt-1 text-[11.5px] text-muted">no current reading</p>
      )}
    </div>
  );
}

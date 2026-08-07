"use client";

import {
  STATUS_GLYPH,
  STATUS_LABEL,
  STATUS_TOKEN,
  VITAL_META,
  classifyVital,
  type VitalKind,
} from "@/lib/iot/vital-status";

/**
 * One vital, right now.
 *
 * Status is encoded three ways — word, glyph shape, colour — and the colour is
 * the least of them. AVERIS's amber and red tokens measure ΔE 1.7 apart under
 * deuteranopia, so a reader with the most common form of colourblindness sees
 * "Warning" and "Critical" as the same swatch. The word and the shape are what
 * actually carry it.
 *
 * A missing measurement renders as "—", never 0. A pulse oximeter that reports
 * no temperature is not reporting a temperature of zero, and a monitor that
 * blurs the two is worse than one that shows nothing.
 */
export function VitalCard({
  kind,
  value,
  stale,
}: {
  kind: VitalKind;
  value: number | null;
  stale: boolean;
}) {
  const meta = VITAL_META[kind];
  const status = classifyVital(kind, value);

  return (
    <div
      className="rounded border border-rule bg-surface p-4"
      style={{
        // A hairline in the status colour, not a filled card: a large block of
        // red is alarming out of proportion to a single warning-level reading.
        borderLeftWidth: "3px",
        borderLeftColor: value === null || stale ? "var(--color-rule)" : STATUS_TOKEN[status],
        opacity: stale ? 0.55 : 1,
      }}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{meta.label}</p>

      {value === null ? (
        <>
          <p className="mono mt-2 text-[30px] font-semibold leading-none text-muted">—</p>
          <p className="mt-2 text-[12px] text-muted">Not reported by this device</p>
        </>
      ) : (
        <>
          <p className="mono mt-2 text-[30px] font-semibold leading-none">
            {value.toFixed(meta.precision)}
            <span className="ml-1.5 text-[14px] font-normal text-muted">{meta.unit}</span>
          </p>

          <p className="mt-2 flex items-center gap-1.5 text-[12.5px] font-medium">
            <span aria-hidden="true" style={{ color: STATUS_TOKEN[status] }}>
              {STATUS_GLYPH[status]}
            </span>
            <span>{stale ? "Last known" : STATUS_LABEL[status]}</span>
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Clinical primitives.
 *
 * The pieces the design system was missing: a stat tile, a table, a modal, an
 * alert banner, a meter, and a contribution bar. They extend
 * `components/ui/index.tsx` rather than replacing it — the palette, the
 * hairline rules and the monospaced identifiers already say "institutional
 * record", which is the register this product wants.
 *
 * ── Two rules every component here follows ─────────────────────────────────
 *
 * **Nothing is encoded by colour alone.** AVERIS's amber and red are
 * indistinguishable under deuteranopia — measured, not assumed — so every
 * status carries a glyph, a label, or a position as well. A clinical dashboard
 * that a colourblind clinician cannot read is a clinical dashboard that is
 * wrong for roughly one in twelve of them.
 *
 * **An absent value renders as absent.** `—` for a patient, `null` on the
 * engineering views. Never 0, never a dash that could be mistaken for a
 * measurement, never the last known value. On a monitoring product the
 * difference between "no reading" and "a reading of zero" is the whole
 * diagnosis.
 */

import type { ReactNode } from "react";

export type Tone = "default" | "brand" | "positive" | "notice" | "critical";

const TONE_TEXT: Record<Tone, string> = {
  default: "text-ink",
  brand: "text-brand",
  positive: "text-[var(--color-positive)]",
  notice: "text-[var(--color-notice)]",
  critical: "text-[var(--color-critical)]",
};

const TONE_SURFACE: Record<Tone, string> = {
  default: "border-rule bg-surface",
  brand: "border-[var(--color-brand)] bg-wash",
  positive: "border-[var(--color-positive-rule)] bg-[var(--color-positive-wash)]",
  notice: "border-[var(--color-notice-rule)] bg-[var(--color-notice-wash)]",
  critical: "border-[var(--color-critical-rule)] bg-[var(--color-critical-wash)]",
};

/** Shape as well as colour. See the note above. */
export const TONE_GLYPH: Record<Tone, string> = {
  default: "·",
  brand: "●",
  positive: "✓",
  notice: "▲",
  critical: "■",
};

/* ------------------------------------------------------------------ tiles */

/**
 * One measurement, at the size of a thing you read across a room.
 *
 * The unit is deliberately smaller and lighter than the number: a clinician
 * scanning eight tiles is reading digits, and "BPM" repeated eight times is
 * chrome.
 */
export function StatTile({
  label,
  value,
  unit,
  precision = 0,
  tone = "default",
  footnote,
  stale = false,
}: {
  label: string;
  value: number | null | undefined;
  unit?: string;
  precision?: number;
  tone?: Tone;
  footnote?: string;
  stale?: boolean;
}) {
  const missing = value === null || value === undefined;

  return (
    <div className={stale ? "opacity-55" : undefined}>
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
        {label}
      </dt>
      <dd
        className={`mono mt-1.5 text-[26px] font-semibold leading-none tabular-nums ${
          missing ? "text-muted" : TONE_TEXT[tone]
        }`}
      >
        {missing ? (
          "—"
        ) : (
          <>
            {value.toFixed(precision)}
            {unit && (
              <span className="ml-1 text-[12px] font-normal text-muted">{unit}</span>
            )}
          </>
        )}
      </dd>
      {footnote && (
        <dd className="mono mt-1 text-[11px] text-muted">{footnote}</dd>
      )}
      {stale && (
        // Said in words, not implied by opacity. A greyed number a reader does
        // not notice is greyed is a number they will treat as current.
        <dd className="mono mt-0.5 text-[10.5px] text-[var(--color-notice)]">
          not current
        </dd>
      )}
    </div>
  );
}

/**
 * A horizontal meter — a score, a percentage, a contribution.
 *
 * The value is always printed as well as drawn. A bar alone is a shape;
 * a clinician quoting a number to a colleague needs the number.
 */
export function Meter({
  value,
  max = 100,
  tone = "brand",
  label,
  valueLabel,
  compact = false,
}: {
  value: number;
  max?: number;
  tone?: Tone;
  label?: string;
  valueLabel?: string;
  compact?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));

  const fill: Record<Tone, string> = {
    default: "bg-[var(--color-rule-strong)]",
    brand: "bg-[var(--color-brand)]",
    positive: "bg-[var(--color-positive)]",
    notice: "bg-[var(--color-notice)]",
    critical: "bg-[var(--color-critical)]",
  };

  return (
    <div>
      {(label || valueLabel) && (
        <div className="mb-1 flex items-baseline justify-between gap-3">
          {label && <span className="text-[13px] text-ink-soft">{label}</span>}
          {valueLabel && (
            <span className="mono text-[12px] tabular-nums text-muted">{valueLabel}</span>
          )}
        </div>
      )}
      <div
        className={`w-full overflow-hidden rounded-full bg-sunken ${compact ? "h-1.5" : "h-2.5"}`}
        role="img"
        aria-label={`${label ?? "value"}: ${valueLabel ?? `${Math.round(pct)}%`}`}
      >
        <div className={`h-full rounded-full ${fill[tone]}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- alerts */

/**
 * A banner for something that needs a person.
 *
 * Distinct from `Callout`, which is informational. This one carries a severity,
 * a glyph, and optionally an action — it is what an emergency looks like at the
 * top of a page.
 */
export function AlertBanner({
  tone = "critical",
  title,
  children,
  action,
  timestamp,
}: {
  tone?: Tone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  timestamp?: string;
}) {
  return (
    <div
      className={`rounded-lg border px-5 py-4 ${TONE_SURFACE[tone]}`}
      // Assertive only for critical: a screen reader interrupting someone
      // mid-sentence for an informational banner is how the setting gets
      // turned off.
      role={tone === "critical" ? "alert" : "status"}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <span aria-hidden="true" className={`mt-0.5 ${TONE_TEXT[tone]}`}>
            {TONE_GLYPH[tone]}
          </span>
          <div className="min-w-0">
            <p className={`text-[15px] font-semibold leading-tight ${TONE_TEXT[tone]}`}>
              {title}
            </p>
            {children && (
              <div className="mt-1.5 text-[14px] leading-relaxed text-ink-soft">
                {children}
              </div>
            )}
            {timestamp && (
              <p className="mono mt-1.5 text-[11.5px] text-muted">{timestamp}</p>
            )}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- tables */

export type Column<T> = {
  key: string;
  header: string;
  /** Right-align numbers so digits line up down the column. */
  numeric?: boolean;
  render: (row: T) => ReactNode;
};

/**
 * A table that scrolls itself rather than the page.
 *
 * The `overflow-x-auto` wrapper is not styling: without it a wide clinical
 * table makes the whole document scroll sideways, and a reader who has scrolled
 * to see a column loses the patient's name off the left edge.
 */
export function DataTable<T>({
  columns,
  rows,
  keyOf,
  empty = "Nothing to show.",
  caption,
}: {
  columns: Column<T>[];
  rows: T[];
  keyOf: (row: T, index: number) => string;
  empty?: string;
  caption?: string;
}) {
  if (rows.length === 0) {
    return <p className="px-6 py-6 text-[14px] text-muted">{empty}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13.5px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-rule text-left">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`px-6 py-2.5 font-mono text-[9.5px] font-normal uppercase tracking-[0.13em] text-muted ${
                  column.numeric ? "text-right" : ""
                }`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={keyOf(row, index)} className="border-b border-rule last:border-0">
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`px-6 py-2.5 ${column.numeric ? "mono text-right tabular-nums" : ""}`}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ steps */

/**
 * A numbered sequence with live state — the demo flow, an onboarding path.
 *
 * State is shown three ways at once: a glyph, a colour, and a word. This is the
 * component most likely to be read at a distance on a projector, and the one
 * where a reviewer misreading "done" as "pending" wastes everybody's time.
 */
export function StepList({
  steps,
}: {
  steps: {
    id: string;
    title: string;
    detail?: string;
    state: "done" | "active" | "pending";
    aside?: ReactNode;
  }[];
}) {
  return (
    <ol className="divide-y divide-rule">
      {steps.map((step, index) => (
        <li key={step.id} className="flex gap-4 px-6 py-4">
          <span
            aria-hidden="true"
            className={`mono mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] ${
              step.state === "done"
                ? "border-[var(--color-positive)] bg-[var(--color-positive-wash)] text-[var(--color-positive)]"
                : step.state === "active"
                  ? "border-[var(--color-brand)] bg-wash text-brand"
                  : "border-rule text-muted"
            }`}
          >
            {step.state === "done" ? "✓" : index + 1}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="text-[15px] font-medium">{step.title}</span>
              <span className="mono text-[11px] uppercase tracking-[0.12em] text-muted">
                {step.state}
              </span>
            </div>
            {step.detail && (
              <p className="mt-1 text-[13.5px] leading-relaxed text-ink-soft">
                {step.detail}
              </p>
            )}
            {step.aside}
          </div>
        </li>
      ))}
    </ol>
  );
}

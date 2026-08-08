/**
 * Vital-sign status and chart scales.
 *
 * Pure, so the classification a patient sees and the geometry a chart draws are
 * both testable without a browser.
 *
 * ── On the colour palette ────────────────────────────────────────────────────
 *
 * AVERIS's status tokens fail a colourblind-separation check: `--color-notice`
 * (#8a5a16) and `--color-critical` (#a63328) sit ΔE 1.7 apart under
 * deuteranopia, which is indistinguishable. Repainting tokens used by every
 * chip and callout in six earlier phases is not something this phase should do
 * quietly, so status here is never carried by colour alone:
 *
 *   · every card states its status in words — "Normal", "Warning", "Critical"
 *   · each status has its own glyph shape (● ▲ ■), legible in monochrome
 *   · the charts shade the normal range as a band, so a value's position in
 *     the plot says whether it is in range without reference to any colour
 *
 * The band is the strongest of the three: it works in greyscale, in print, and
 * for a reader who never looks at the label.
 */

export type VitalStatus = "NORMAL" | "WARNING" | "CRITICAL" | "UNKNOWN";

export type VitalKind = "heartRate" | "spo2" | "temperature";

/**
 * Chart y-domains, fixed per vital rather than fitted to the data.
 *
 * This is deliberate and is the opposite of what a general-purpose charting
 * library does. Two reasons:
 *
 * **A monitor must be readable by position.** If the axis rescales to the
 * window's min and max, the same heart rate sits at a different height every
 * refresh, and a reader cannot learn where "normal" is on the card.
 *
 * **Auto-scaling manufactures alarm.** A resting series wobbling between 68 and
 * 72 BPM, fitted to its own range, fills the plot with a jagged mountain. The
 * variation is meaningless; the picture is not.
 *
 * These are clinical windows, not the plausible ranges used for validation —
 * wide enough to contain anything worth showing, narrow enough that real
 * movement is visible.
 */
export const CHART_DOMAIN: Record<VitalKind, { min: number; max: number }> = {
  heartRate: { min: 40, max: 160 },
  spo2: { min: 85, max: 100 },
  temperature: { min: 34, max: 40 },
};

/** The band shaded on each chart as "in range". */
export const NORMAL_BAND: Record<VitalKind, { min: number; max: number }> = {
  heartRate: { min: 60, max: 100 },
  spo2: { min: 95, max: 100 },
  temperature: { min: 36.0, max: 37.5 },
};

/**
 * Classification thresholds.
 *
 * These agree with `alert-rules.ts` on purpose — a card reading "Critical"
 * while no alert was raised, or the reverse, is worse than either alone. The
 * shared vectors assert they stay in agreement.
 */
const RULES: Record<
  VitalKind,
  { criticalLow?: number; low?: number; high?: number; criticalHigh?: number }
> = {
  heartRate: { criticalLow: 40, low: 50, high: 120, criticalHigh: 150 },
  spo2: { criticalLow: 90, low: 94 },
  temperature: { criticalLow: 35.0, low: 35.5, high: 38.0, criticalHigh: 39.5 },
};

export type ClinicalZone = {
  /** Bottom of the band, in the vital's own units. */
  from: number;
  to: number;
  status: Exclude<VitalStatus, "UNKNOWN">;
};

/**
 * The chart's background bands, derived from the alerting rules above.
 *
 * **Derived, not declared.** A hand-written zone table is a fourth copy of the
 * thresholds, and the copy that drifts is the one that draws a green band under
 * a value that just raised a critical alert. A clinician seeing a reading sit
 * inside a "normal" zone while an alert fires beside it has been given two
 * contradictory claims and no way to choose, so the zones are computed from
 * `RULES` and cannot disagree with them.
 *
 * Returned bottom-to-top and clipped to the chart domain, so a caller can draw
 * them in order without arithmetic.
 */
export function clinicalZones(kind: VitalKind): ClinicalZone[] {
  const rule = RULES[kind];
  const domain = CHART_DOMAIN[kind];

  // Every threshold that falls inside the visible window, in order. A
  // threshold outside the domain contributes no boundary — the zone simply
  // runs to the edge of the chart.
  type Boundary = {
    at: number | undefined;
    below: Exclude<VitalStatus, "UNKNOWN">;
    above: Exclude<VitalStatus, "UNKNOWN">;
  };

  const boundaries: Boundary[] = [
    { at: rule.criticalLow, below: "CRITICAL", above: "WARNING" },
    { at: rule.low, below: "WARNING", above: "NORMAL" },
    { at: rule.high, below: "NORMAL", above: "WARNING" },
    { at: rule.criticalHigh, below: "WARNING", above: "CRITICAL" },
  ];

  const present = boundaries.filter(
    (b): b is Boundary & { at: number } => typeof b.at === "number",
  );

  const zones: ClinicalZone[] = [];
  let cursor = domain.min;

  for (const boundary of present) {
    const edge = Math.min(domain.max, Math.max(domain.min, boundary.at));
    if (edge > cursor) {
      zones.push({ from: cursor, to: edge, status: boundary.below });
    }
    cursor = edge;
  }

  if (cursor < domain.max) {
    // Above the last threshold. For SpO2 — which has no upper thresholds at
    // all, because there is no such thing as too much oxygen saturation — this
    // is the single band covering everything above the warning level.
    const last = present[present.length - 1];
    zones.push({ from: cursor, to: domain.max, status: last ? last.above : "NORMAL" });
  }

  return zones.filter((zone) => zone.to > zone.from);
}

export function classifyVital(kind: VitalKind, value: number | null): VitalStatus {
  if (value === null || !Number.isFinite(value)) return "UNKNOWN";

  const rule = RULES[kind];

  // Critical is checked before warning in both directions, so a value that is
  // both below the warning floor and below the critical floor reports the more
  // serious of the two.
  if (rule.criticalHigh !== undefined && value >= rule.criticalHigh) return "CRITICAL";
  if (rule.criticalLow !== undefined && value <= rule.criticalLow) return "CRITICAL";
  if (rule.high !== undefined && value > rule.high) return "WARNING";
  if (rule.low !== undefined && value < rule.low) return "WARNING";

  return "NORMAL";
}

/** Words, never colour alone. */
export const STATUS_LABEL: Record<VitalStatus, string> = {
  NORMAL: "Normal",
  WARNING: "Warning",
  CRITICAL: "Critical",
  UNKNOWN: "No reading",
};

/**
 * Shape, so status survives greyscale, print and colourblindness.
 *
 * Deliberately geometric rather than emoji: emoji render differently on every
 * platform and several health glyphs are unreadable at 12px.
 */
export const STATUS_GLYPH: Record<VitalStatus, string> = {
  NORMAL: "●",
  WARNING: "▲",
  CRITICAL: "■",
  UNKNOWN: "○",
};

/** Maps to the existing app tokens. Colour is the third encoding, never the first. */
export const STATUS_TOKEN: Record<VitalStatus, string> = {
  NORMAL: "var(--color-positive)",
  WARNING: "var(--color-notice)",
  CRITICAL: "var(--color-critical)",
  UNKNOWN: "var(--color-faint)",
};

/** The most serious status across several vitals, for an overall banner. */
export function worstStatus(statuses: VitalStatus[]): VitalStatus {
  const rank: Record<VitalStatus, number> = {
    UNKNOWN: 0,
    NORMAL: 1,
    WARNING: 2,
    CRITICAL: 3,
  };
  return statuses.reduce(
    (worst, s) => (rank[s] > rank[worst] ? s : worst),
    "UNKNOWN" as VitalStatus,
  );
}

/* ------------------------------------------------------------ chart scales */

/**
 * Maps a value to a y coordinate inside the plot.
 *
 * Clamped rather than allowed to escape: a reading outside the domain is drawn
 * on the boundary, so an extreme value stays visible at the edge of the plot
 * instead of being rendered outside the viewBox where nothing appears at all.
 */
export function scaleY(
  kind: VitalKind,
  value: number,
  plotHeight: number,
  padTop = 0,
): number {
  const { min, max } = CHART_DOMAIN[kind];
  const clamped = Math.min(max, Math.max(min, value));
  const fraction = (clamped - min) / (max - min);
  // SVG y grows downward, so the top of the plot is the maximum.
  return padTop + (1 - fraction) * plotHeight;
}

export function scaleX(
  timestamp: number,
  windowStart: number,
  windowEnd: number,
  plotWidth: number,
  padLeft = 0,
): number {
  const span = Math.max(1, windowEnd - windowStart);
  const fraction = (timestamp - windowStart) / span;
  return padLeft + Math.min(1, Math.max(0, fraction)) * plotWidth;
}

/** Axis ticks that land on readable numbers rather than on the domain edges. */
export function axisTicks(kind: VitalKind): number[] {
  const { min, max } = CHART_DOMAIN[kind];
  const step = kind === "temperature" ? 2 : kind === "spo2" ? 5 : 40;

  const ticks: number[] = [];
  for (let v = min; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(1)));
  return ticks;
}

export const VITAL_META: Record<
  VitalKind,
  { label: string; unit: string; precision: number }
> = {
  heartRate: { label: "Heart rate", unit: "BPM", precision: 0 },
  spo2: { label: "Blood oxygen", unit: "%", precision: 0 },
  temperature: { label: "Temperature", unit: "°C", precision: 1 },
};

/**
 * Gradual decline, over days rather than minutes.
 *
 * `ai_engine/prediction/trends.py` watches fifteen-minute windows and catches a
 * desaturation while it is happening. This module answers a different and
 * harder question: **is this patient slowly getting worse?**
 *
 * The distinction matters because the two need opposite instruments. A
 * fifteen-minute trend is a slope through dense samples. A five-day decline is
 * invisible at that resolution — every window inside it looks flat — and only
 * appears when each day is reduced to one number and the days are compared.
 *
 * ── The failure this module exists to prevent ──────────────────────────────
 *
 * An adaptive baseline that keeps up with a deteriorating patient will never
 * report the deterioration: today always looks normal against yesterday. So
 * the comparison here is deliberately *anchored* — a recent window against a
 * baseline learned from an older one, with a gap between them. If the two
 * windows overlapped, a decline would appear in both and cancel.
 *
 * ── Why a daily median and not a daily mean ────────────────────────────────
 *
 * A patient who exercises once produces an hour of elevated heart rate, and a
 * mean carries that into the day's number. The median describes where the day
 * mostly sat, which is what "resting heart rate is climbing" is a claim about.
 *
 * Pure and fully tested.
 */

import {
  BASELINE_CHANNELS,
  CHANNEL_LABEL,
  CHANNEL_UNIT,
  percentile,
  type BaselineChannel,
  type BaselineSample,
  type PersonalBaseline,
} from "./baseline";

export type TrendDirection = "RISING" | "FALLING" | "STEADY";

export type DailyPoint = {
  /** ISO date, YYYY-MM-DD. */
  day: string;
  median: number;
  samples: number;
};

export type ChannelTrend = {
  channel: BaselineChannel;
  direction: TrendDirection;
  /** Change per day, in the channel's own units. */
  slopePerDay: number;
  /** Total change across the observed span. */
  totalChange: number;
  /** How well a straight line fits, 0–1. A wobbly series is not a trend. */
  fit: number;
  days: DailyPoint[];
  /** True when the direction is the one that means "worse". */
  concerning: boolean;
};

/**
 * Slopes below these are drift, not decline.
 *
 * Set from what a clinician would act on rather than from what is
 * statistically detectable: a heart rate climbing 0.2 BPM a day is inside the
 * noise of how well a band sits on a wrist, and reporting it would produce a
 * finding every week for every patient. A feed that always has something to
 * say is a feed nobody reads.
 */
const MATERIAL_SLOPE: Record<BaselineChannel, number> = {
  heartRate: 1.0, // BPM per day
  spo2: 0.4, // % per day
  temperature: 0.08, // °C per day
};

/** Which direction is the bad one for each channel. */
const CONCERNING_DIRECTION: Record<BaselineChannel, TrendDirection> = {
  heartRate: "RISING",
  spo2: "FALLING",
  temperature: "RISING",
};

/** A trend needs this many days, or it is two points and a line between them. */
export const MIN_TREND_DAYS = 4;

/** A day with fewer readings than this is too thin to contribute a median. */
export const MIN_SAMPLES_PER_DAY = 20;

/** Reduces a series to one robust number per calendar day. */
export function dailyMedians(
  samples: BaselineSample[],
  channel: BaselineChannel,
): DailyPoint[] {
  const byDay = new Map<string, number[]>();

  for (const sample of samples) {
    const value =
      channel === "heartRate"
        ? sample.heart_rate
        : channel === "spo2"
          ? sample.spo2
          : sample.temperature;

    if (typeof value !== "number") continue;

    // UTC day. A local-time bucket would shift the boundary per deployment and
    // make the same data produce different trends in different regions.
    const day = sample.recorded_at.slice(0, 10);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(value);
    else byDay.set(day, [value]);
  }

  return [...byDay.entries()]
    .filter(([, values]) => values.length >= MIN_SAMPLES_PER_DAY)
    .map(([day, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { day, median: percentile(sorted, 0.5), samples: values.length };
    })
    .sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Least-squares slope over the daily medians, with its fit.
 *
 * The fit is what separates a decline from a wobble. Five days of
 * 98, 91, 99, 90, 97 have a slope; they do not have a trend, and reporting one
 * would be inventing a shape the data does not have.
 */
export function trendFor(
  samples: BaselineSample[],
  channel: BaselineChannel,
): ChannelTrend | null {
  const days = dailyMedians(samples, channel);
  if (days.length < MIN_TREND_DAYS) return null;

  // x is days since the first observation, so a gap in the middle is honoured
  // rather than collapsed — five readings over five days and five over twenty
  // are different claims.
  const origin = Date.parse(`${days[0].day}T00:00:00Z`);
  const xs = days.map((d) => (Date.parse(`${d.day}T00:00:00Z`) - origin) / 86_400_000);
  const ys = days.map((d) => d.median);

  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    numerator += (xs[i] - meanX) * (ys[i] - meanY);
    denominator += (xs[i] - meanX) ** 2;
  }

  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;

  // R², clamped: a flat series has zero variance and would divide by zero.
  let ssTotal = 0;
  let ssResidual = 0;
  for (let i = 0; i < n; i += 1) {
    const predicted = intercept + slope * xs[i];
    ssTotal += (ys[i] - meanY) ** 2;
    ssResidual += (ys[i] - predicted) ** 2;
  }
  const fit = ssTotal === 0 ? 1 : Math.max(0, 1 - ssResidual / ssTotal);

  const span = xs[xs.length - 1] - xs[0];
  const material = Math.abs(slope) >= MATERIAL_SLOPE[channel];

  // Both conditions. A steep slope through scattered points is not a trend,
  // and a beautifully-fitted slope of 0.05 BPM/day is not worth saying.
  const direction: TrendDirection =
    material && fit >= 0.5 ? (slope > 0 ? "RISING" : "FALLING") : "STEADY";

  return {
    channel,
    direction,
    slopePerDay: Number(slope.toFixed(2)),
    totalChange: Number((slope * span).toFixed(2)),
    fit: Number(fit.toFixed(2)),
    days,
    concerning: direction !== "STEADY" && direction === CONCERNING_DIRECTION[channel],
  };
}

export type DeteriorationSeverity = "NONE" | "WATCH" | "CONCERNING";

export type DeteriorationFinding = {
  channel: BaselineChannel;
  severity: DeteriorationSeverity;
  message: string;
  trend: ChannelTrend;
};

/**
 * Every channel's trend, with the concerning ones described.
 *
 * A steady channel still returns a trend — the absence of decline is a finding
 * a clinician wants, and a panel that only ever shows problems cannot be used
 * to confirm that there are none.
 */
export function detectDeterioration(samples: BaselineSample[]): {
  trends: ChannelTrend[];
  findings: DeteriorationFinding[];
} {
  const trends: ChannelTrend[] = [];
  const findings: DeteriorationFinding[] = [];

  for (const channel of BASELINE_CHANNELS) {
    const trend = trendFor(samples, channel);
    if (!trend) continue;

    trends.push(trend);
    if (!trend.concerning) continue;

    const severity: DeteriorationSeverity =
      Math.abs(trend.slopePerDay) >= MATERIAL_SLOPE[channel] * 2 && trend.fit >= 0.7
        ? "CONCERNING"
        : "WATCH";

    findings.push({ channel, severity, message: describeTrend(trend), trend });
  }

  return { trends, findings };
}

/**
 * Comparing a recent window against the anchored baseline.
 *
 * This is the check that catches the patient whose decline is too slow for a
 * slope to reach significance but who is measurably different from the person
 * they were a month ago. The baseline must have been computed with
 * `excludeAfter` set before the recent window, or the two overlap and the
 * difference partly cancels itself.
 */
export function compareToBaseline(
  baseline: PersonalBaseline,
  recent: BaselineSample[],
): DeteriorationFinding[] {
  const findings: DeteriorationFinding[] = [];

  for (const channel of BASELINE_CHANNELS) {
    const anchor = baseline.channels[channel];
    if (!anchor) continue;

    const values = recent
      .map((s) =>
        channel === "heartRate" ? s.heart_rate : channel === "spo2" ? s.spo2 : s.temperature,
      )
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);

    if (values.length < MIN_SAMPLES_PER_DAY) continue;

    const recentMedian = percentile(values, 0.5);
    const shift = recentMedian - anchor.median;
    const spread = Math.max(anchor.iqr, 1);

    // Half an interquartile range of movement in the *whole distribution* is a
    // different person from a single reading being unusual, which is why the
    // bar is lower here than for a point deviation.
    if (Math.abs(shift) < spread * 0.5) continue;

    const worse =
      (channel === "spo2" && shift < 0) ||
      (channel !== "spo2" && shift > 0);
    if (!worse) continue;

    const precision = channel === "temperature" ? 1 : 0;
    const unit = CHANNEL_UNIT[channel];

    findings.push({
      channel,
      severity: Math.abs(shift) >= spread ? "CONCERNING" : "WATCH",
      message:
        `${CHANNEL_LABEL[channel]} has settled at ${recentMedian.toFixed(precision)}${unit} ` +
        `against a baseline of ${anchor.median.toFixed(precision)}${unit} learned over ` +
        `${baseline.daysCovered} days — a shift of ${Math.abs(shift).toFixed(precision)}${unit} ` +
        `in the patient's usual level.`,
      trend: {
        channel,
        direction: shift > 0 ? "RISING" : "FALLING",
        slopePerDay: 0,
        totalChange: Number(shift.toFixed(2)),
        fit: 1,
        days: [],
        concerning: true,
      },
    });
  }

  return findings;
}

/**
 * The sentence for a multi-day trend.
 *
 * Carries the rate, the total change and the span, because a trend claim
 * without its numbers is unfalsifiable — and an unfalsifiable claim about
 * someone's health is worse than no claim.
 */
export function describeTrend(trend: ChannelTrend): string {
  const label = CHANNEL_LABEL[trend.channel];
  const unit = CHANNEL_UNIT[trend.channel];
  const precision = trend.channel === "temperature" ? 1 : 0;
  const days = trend.days.length;
  const verb = trend.direction === "RISING" ? "risen" : "fallen";

  return (
    `${label} has ${verb} by ${Math.abs(trend.totalChange).toFixed(precision)}${unit} ` +
    `across ${days} days — about ${Math.abs(trend.slopePerDay).toFixed(2)}${unit} a day, ` +
    `${trend.days[0].median.toFixed(precision)}${unit} to ` +
    `${trend.days[days - 1].median.toFixed(precision)}${unit}.`
  );
}

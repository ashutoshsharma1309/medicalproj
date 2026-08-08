/**
 * Personal baselines — what is normal *for this patient*.
 *
 * The intellectual claim of the whole platform lives in this file. A published
 * range says a resting adult's heart rate is 50–120; a personal baseline says
 * this patient sits at 62–74 and is currently at 105, which is a finding the
 * published range cannot produce.
 *
 * ── The invariant that must never be broken ────────────────────────────────
 *
 * **Personalisation may only ADD findings. It may never suppress one.**
 *
 * A patient whose personal range runs high does not get a higher escalation
 * threshold. SpO₂ of 86% is critical for everybody, and an adaptive system that
 * learned to tolerate it would be a system that quietly stops alerting on the
 * patient who needs it most — the one whose readings have been drifting for
 * weeks. `personalFindings()` therefore returns findings *alongside* the
 * threshold rules and has no path that cancels one. The tests assert this
 * directly, because it is the property that makes personalisation safe rather
 * than merely clever.
 *
 * ── Three ways a personal baseline goes wrong, and what is done about each ─
 *
 * **1. Contamination.** If the window used to learn "normal" contains the
 * patient's illness, the baseline encodes the illness and the system goes
 * quiet exactly when it should not. Callers pass `exclude` ranges — periods
 * with open emergencies or critical alerts — and those samples are dropped.
 *
 * **2. Drift absorption.** A resting heart rate rising 1 BPM a day is the
 * signal a monitoring platform exists to catch, and a baseline that keeps up
 * with it will never report it: every day looks normal relative to the day
 * before. So the baseline is computed over a *long anchor window that excludes
 * the recent past*, and `lib/health/deterioration.ts` compares recent against
 * anchor. A baseline that adapts fast is a baseline that cannot see decline.
 *
 * **3. Too little data.** Six readings produce a confident-looking range that
 * means nothing. The module returns `null` rather than a baseline it does not
 * believe, exactly as the health score refuses a number.
 *
 * ── Why median and percentiles rather than mean and standard deviation ─────
 *
 * Vital-sign distributions are not normal — they are skewed, and they contain
 * artefacts that survive the device-side filter. One 180 BPM sample from a
 * shifted sensor moves a mean; it moves a median by nothing. And an interval
 * built from percentiles describes where the patient's readings actually fell,
 * which is a checkable claim, rather than where a Gaussian says they should
 * have.
 *
 * Pure. No database, no clock beyond what callers pass in.
 */

export type BaselineChannel = "heartRate" | "spo2" | "temperature";

export const BASELINE_CHANNELS: BaselineChannel[] = ["heartRate", "spo2", "temperature"];

export type ChannelBaseline = {
  channel: BaselineChannel;
  /** The patient's central value. Median, not mean — see the module note. */
  median: number;
  /** Where the middle 80% of their readings fell. */
  low: number;
  high: number;
  /** Interquartile range, as a spread measure robust to artefacts. */
  iqr: number;
  samples: number;
};

export type PersonalBaseline = {
  channels: Partial<Record<BaselineChannel, ChannelBaseline>>;
  /** Start and end of the window the baseline was learned from. */
  windowStart: string;
  windowEnd: string;
  /** Distinct calendar days containing at least one reading. */
  daysCovered: number;
  totalSamples: number;
  /** Samples dropped because they fell inside an excluded period. */
  excludedSamples: number;
  /** How much this baseline should be trusted, 0–1. */
  confidence: number;
};

export type BaselineSample = {
  heart_rate: number | null;
  spo2: number | null;
  temperature: number | null;
  recorded_at: string;
};

/** A period to leave out — an illness, an open emergency, a critical alert. */
export type ExcludedPeriod = { from: string; to: string; reason: string };

export type BaselineOptions = {
  /** Periods whose samples must not teach the baseline anything. */
  exclude?: ExcludedPeriod[];
  /**
   * Samples newer than this are ignored.
   *
   * The anchoring control. Learning "normal" from data that includes today
   * means today can never look abnormal.
   */
  excludeAfter?: string;
  now?: number;
};

/**
 * Minimum evidence before a baseline exists at all.
 *
 * Both must be met. 500 readings inside two hours is a dense sample of one
 * afternoon, not a description of a person — a baseline needs to have seen the
 * patient asleep and awake, resting and moving, which is what the day count is
 * a proxy for.
 */
export const MIN_SAMPLES = 200;
export const MIN_DAYS = 3;

/** Below this the baseline is reported but flagged as provisional. */
export const CONFIDENT_DAYS = 7;

export function computeBaseline(
  samples: BaselineSample[],
  options: BaselineOptions = {},
): PersonalBaseline | null {
  const excluded = options.exclude ?? [];
  const cutoff = options.excludeAfter ? Date.parse(options.excludeAfter) : Infinity;

  let excludedSamples = 0;

  const usable = samples.filter((sample) => {
    const at = Date.parse(sample.recorded_at);
    if (!Number.isFinite(at)) return false;
    if (at > cutoff) return false;

    for (const period of excluded) {
      const from = Date.parse(period.from);
      const to = Date.parse(period.to);
      if (Number.isFinite(from) && Number.isFinite(to) && at >= from && at <= to) {
        excludedSamples += 1;
        return false;
      }
    }

    return true;
  });

  if (usable.length < MIN_SAMPLES) return null;

  const days = new Set(usable.map((s) => s.recorded_at.slice(0, 10)));
  if (days.size < MIN_DAYS) return null;

  const timestamps = usable
    .map((s) => Date.parse(s.recorded_at))
    .sort((a, b) => a - b);

  const channels: Partial<Record<BaselineChannel, ChannelBaseline>> = {};

  for (const channel of BASELINE_CHANNELS) {
    const values = usable
      .map((s) => valueOf(s, channel))
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);

    // A channel the device does not report contributes nothing rather than a
    // fabricated range. A chest strap has no thermometer.
    if (values.length < MIN_SAMPLES / 2) continue;

    const q1 = percentile(values, 0.25);
    const q3 = percentile(values, 0.75);

    channels[channel] = {
      channel,
      median: round(percentile(values, 0.5), channel),
      // The 10th and 90th percentiles: where this patient's readings actually
      // fell, rather than where a Gaussian says they should have.
      low: round(percentile(values, 0.1), channel),
      high: round(percentile(values, 0.9), channel),
      iqr: round(q3 - q1, channel),
      samples: values.length,
    };
  }

  if (Object.keys(channels).length === 0) return null;

  return {
    channels,
    windowStart: new Date(timestamps[0]).toISOString(),
    windowEnd: new Date(timestamps[timestamps.length - 1]).toISOString(),
    daysCovered: days.size,
    totalSamples: usable.length,
    excludedSamples,
    confidence: confidenceFor(days.size, usable.length),
  };
}

/**
 * How much to trust this baseline.
 *
 * Days dominate samples, and deliberately: a baseline built from three days of
 * dense data has seen three of the patient's daily cycles, however many
 * readings that came to. Capped below 1 until a full week, because seven days
 * is the shortest window that contains a weekend.
 */
function confidenceFor(days: number, samples: number): number {
  const dayScore = Math.min(1, days / CONFIDENT_DAYS);
  const sampleScore = Math.min(1, samples / (MIN_SAMPLES * 5));
  return Number((dayScore * 0.7 + sampleScore * 0.3).toFixed(2));
}

export type DeviationSeverity = "NONE" | "MILD" | "NOTABLE" | "MARKED";

export type PersonalDeviation = {
  channel: BaselineChannel;
  observed: number;
  baselineMedian: number;
  /** Signed difference from the patient's own median, in their own units. */
  delta: number;
  /** As a percentage of the baseline median. */
  percentDelta: number;
  /**
   * How many interquartile ranges outside the patient's usual spread.
   *
   * Scale-free, so a patient with a very steady heart rate registers a
   * deviation at a smaller absolute change than one whose readings swing —
   * which is the entire point of personalisation.
   */
  iqrDistance: number;
  direction: "above" | "below";
  severity: DeviationSeverity;
};

/**
 * How far a reading sits from this patient's own normal.
 *
 * Returns null when the channel has no baseline. Absence of a baseline is not
 * evidence of normality, and callers must not be able to mistake it for one.
 */
export function deviationFrom(
  baseline: PersonalBaseline,
  channel: BaselineChannel,
  observed: number | null,
): PersonalDeviation | null {
  const channelBaseline = baseline.channels[channel];
  if (!channelBaseline || observed === null) return null;

  const delta = observed - channelBaseline.median;

  // A floor on the spread, because a patient whose readings barely move would
  // otherwise register a marked deviation from ordinary noise. An IQR of zero
  // is a real possibility on an integer channel like SpO₂.
  const spread = Math.max(channelBaseline.iqr, minimumSpread(channel));
  const iqrDistance = Math.abs(delta) / spread;

  return {
    channel,
    observed,
    baselineMedian: channelBaseline.median,
    delta: round(delta, channel),
    percentDelta:
      channelBaseline.median === 0
        ? 0
        : Number(((delta / channelBaseline.median) * 100).toFixed(1)),
    iqrDistance: Number(iqrDistance.toFixed(2)),
    direction: delta >= 0 ? "above" : "below",
    severity: severityFor(iqrDistance),
  };
}

/**
 * Thresholds on the scale-free distance.
 *
 * 1.5 IQRs is the conventional outlier fence and is a reasonable place for
 * "worth mentioning"; 3 is clearly outside the patient's habit. These decide
 * what is *said*, never what is escalated — escalation belongs to the
 * published thresholds, which do not move.
 */
function severityFor(iqrDistance: number): DeviationSeverity {
  if (iqrDistance >= 4) return "MARKED";
  if (iqrDistance >= 2.5) return "NOTABLE";
  if (iqrDistance >= 1.5) return "MILD";
  return "NONE";
}

/**
 * The smallest spread a channel is allowed to have.
 *
 * Without this, a patient whose SpO₂ reads 98 every time has an IQR of 0, and
 * a single reading of 97 becomes an infinite deviation. These are roughly the
 * measurement resolution of each sensor: below it, a difference is the
 * instrument rather than the person.
 */
function minimumSpread(channel: BaselineChannel): number {
  return channel === "heartRate" ? 4 : channel === "spo2" ? 1.5 : 0.3;
}

export type PersonalFinding = {
  channel: BaselineChannel;
  severity: DeviationSeverity;
  /** One sentence a clinician can check against the numbers beside it. */
  message: string;
  deviation: PersonalDeviation;
};

/**
 * Findings from comparing current readings against this patient's own normal.
 *
 * **Additive only.** Nothing here can cancel a threshold alert, and there is no
 * return value that means "ignore the rule engine". A reading can be perfectly
 * normal for a patient and still be critical for a human being; both statements
 * are made, and the published one always wins on escalation.
 *
 * Deviations in the *reassuring* direction are dropped: a heart rate well below
 * a patient's baseline is worth surfacing, but SpO₂ above their baseline is
 * not a finding — there is no such thing as too much oxygen saturation, and
 * reporting it would train readers to skim.
 */
export function personalFindings(
  baseline: PersonalBaseline,
  current: { heartRate: number | null; spo2: number | null; temperature: number | null },
): PersonalFinding[] {
  const findings: PersonalFinding[] = [];

  for (const channel of BASELINE_CHANNELS) {
    const observed =
      channel === "heartRate"
        ? current.heartRate
        : channel === "spo2"
          ? current.spo2
          : current.temperature;

    const deviation = deviationFrom(baseline, channel, observed);
    if (!deviation || deviation.severity === "NONE") continue;

    // Higher-than-usual oxygen saturation is not a finding.
    if (channel === "spo2" && deviation.direction === "above") continue;

    findings.push({
      channel,
      severity: deviation.severity,
      message: describeDeviation(deviation, baseline),
      deviation,
    });
  }

  return findings.sort((a, b) => rank(b.severity) - rank(a.severity));
}

function rank(severity: DeviationSeverity): number {
  return { NONE: 0, MILD: 1, NOTABLE: 2, MARKED: 3 }[severity];
}

export const CHANNEL_LABEL: Record<BaselineChannel, string> = {
  heartRate: "Heart rate",
  spo2: "Blood oxygen",
  temperature: "Temperature",
};

export const CHANNEL_UNIT: Record<BaselineChannel, string> = {
  heartRate: " BPM",
  spo2: "%",
  temperature: "°C",
};

/**
 * The sentence a person reads.
 *
 * Always carries both numbers and the window the baseline came from. "Heart
 * rate is high for this patient" is unfalsifiable; "105 BPM against a personal
 * baseline of 72, learned over 14 days" is something a clinician can disagree
 * with — and disagreement is what makes the claim worth making.
 */
export function describeDeviation(
  deviation: PersonalDeviation,
  baseline: PersonalBaseline,
): string {
  const label = CHANNEL_LABEL[deviation.channel];
  const unit = CHANNEL_UNIT[deviation.channel];
  const precision = deviation.channel === "temperature" ? 1 : 0;

  const magnitude = Math.abs(deviation.percentDelta) >= 5
    ? `${Math.abs(Math.round(deviation.percentDelta))}% ${deviation.direction}`
    : `${Math.abs(deviation.delta).toFixed(precision)}${unit} ${deviation.direction}`;

  return (
    `${label} is ${deviation.observed.toFixed(precision)}${unit}, ${magnitude} ` +
    `this patient's usual ${deviation.baselineMedian.toFixed(precision)}${unit} ` +
    `(learned from ${baseline.daysCovered} days).`
  );
}

/* -------------------------------------------------------------- utilities */

function valueOf(sample: BaselineSample, channel: BaselineChannel): number | null {
  return channel === "heartRate"
    ? sample.heart_rate
    : channel === "spo2"
      ? sample.spo2
      : sample.temperature;
}

/** Linear-interpolated percentile over a sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];

  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function round(value: number, channel: BaselineChannel): number {
  return channel === "temperature"
    ? Number(value.toFixed(1))
    : Number(value.toFixed(0));
}

/**
 * Method comparison — how closely the band agrees with a reference instrument.
 *
 * ── The mistake this module exists to avoid ────────────────────────────────
 *
 * The obvious way to check a sensor against a reference is to correlate them
 * and report r or R². It is also wrong, and wrong in the direction that
 * flatters the device.
 *
 * Correlation measures whether two things move together, not whether they
 * agree. A pulse oximeter reading a consistent 8 percentage points below a
 * reference correlates at r = 0.99 — perfectly, beautifully, and while telling
 * a clinician that a patient at 92% is at 84%. Correlation also rises with the
 * *range* of the data, so measuring a few volunteers across a wide spread of
 * heart rates produces a better-looking number than measuring the resting range
 * the band will actually spend its life in.
 *
 * The right analysis for "do these two methods measure the same thing" is
 * Bland–Altman: plot the difference against the mean, and report the **bias**
 * (mean difference — systematic offset) and the **limits of agreement** (bias ±
 * 1.96 SD — the interval containing 95% of disagreements). That answers the
 * question a clinician actually has, which is not "are they correlated" but
 * "if the band says 94%, what range could the truth be in?"
 *
 * Reference: Bland JM, Altman DG. *Statistical methods for assessing agreement
 * between two methods of clinical measurement.* Lancet, 1986.
 *
 * ── What this module will not do ───────────────────────────────────────────
 *
 * It will not produce a number from too few pairs. Limits of agreement from six
 * measurements are arithmetic, not evidence, and the confidence interval around
 * them is wider than the limits themselves. Below `MIN_PAIRS` the result is an
 * explicit "not enough data" rather than a figure somebody will quote.
 *
 * It also does not call anything "accurate". The reference instrument has its
 * own error, so this measures *agreement between two imperfect devices*, and
 * the word for that is agreement.
 */

/** One simultaneous measurement from the band and the reference. */
export type CalibrationPair = {
  /** What the AVERIS band reported. */
  device: number;
  /** What the reference instrument reported at the same moment. */
  reference: number;
  /** Free-text conditions — movement, poor perfusion, cold hands. */
  conditions?: string | null;
};

/**
 * The minimum number of pairs before agreement statistics are reported.
 *
 * Twenty is not a standard — it is the point below which the 95% confidence
 * interval around the limits of agreement is so wide that the limits carry no
 * information. Real regulatory studies need far more; see `REGULATORY_NOTE`.
 */
export const MIN_PAIRS = 20;

/**
 * What a real pulse-oximeter validation requires, stated so nobody mistakes
 * this module's output for one.
 *
 * ISO 80601-2-61 requires a controlled desaturation study: healthy volunteers
 * brought down to roughly 70% arterial saturation in stages, with arterial
 * blood gas samples as the reference, at least 200 paired data points across at
 * least 10 subjects with a range of skin pigmentation. The pass criterion is
 * A_rms ≤ 4% (≤ 3% for transmittance oximeters in some classes).
 *
 * AVERIS cannot run that study. It needs ethics approval, a hypoxia laboratory,
 * and arterial line access. Everything this module produces is a bench
 * comparison against a consumer fingertip oximeter at normal saturation — which
 * is worth doing, tells you about systematic offset and gross malfunction, and
 * is not a validation.
 */
export const REGULATORY_NOTE =
  "ISO 80601-2-61 requires a controlled desaturation study with arterial blood gas " +
  "reference, ≥200 paired points across ≥10 subjects spanning 70–100% saturation. " +
  "AVERIS has not performed one and cannot. Bench comparison at normal saturation " +
  "detects systematic offset and gross malfunction; it does not establish accuracy " +
  "in the hypoxic range, which is the range that matters clinically.";

export type AgreementResult = {
  /** How many pairs the statistics are computed from. */
  n: number;

  /**
   * Mean difference, device minus reference.
   *
   * Positive means the band reads high. This is the systematic part — the part
   * that could in principle be corrected by an offset, and the part correlation
   * is blind to.
   */
  bias: number;

  /** Standard deviation of the differences. The random part. */
  sd: number;

  /**
   * Bias ± 1.96·SD — the interval containing 95% of disagreements.
   *
   * The number to quote. "The band agrees with the reference to within
   * −3.1 to +4.7 percentage points" is a statement a clinician can use.
   */
  limitsOfAgreement: { lower: number; upper: number };

  /**
   * Root-mean-square difference.
   *
   * The metric ISO 80601-2-61 uses for pulse oximeters (as A_rms). Combines
   * bias and scatter into one number, which is why it is the regulatory
   * headline — and why it should never be reported without the bias beside it,
   * since a device with zero bias and a device with a large offset can share an
   * A_rms.
   */
  rms: number;

  /** Largest single disagreement observed. The one that would hurt. */
  maxAbsoluteDifference: number;

  /**
   * Whether the disagreement grows with the magnitude of the measurement.
   *
   * Computed as the slope of difference against mean. A device that agrees at
   * 98% SpO₂ and diverges at 90% has proportional bias, and reporting a single
   * bias figure for it is misleading — the average hides the part that matters,
   * because 90% is where the clinical decision lives.
   */
  proportionalBias: { slope: number; present: boolean };

  /** True when there were not enough pairs. Everything above is then zero. */
  insufficient: boolean;

  /** A sentence for the screen. Never omits the caveat. */
  summary: string;
};

/**
 * Computes agreement between the band and a reference.
 *
 * Pure. Takes pairs, returns statistics — no database, no configuration, so
 * every branch including the insufficient-data one is reachable in a test.
 */
export function agreement(pairs: CalibrationPair[], unit = ""): AgreementResult {
  const n = pairs.length;

  if (n < MIN_PAIRS) {
    return {
      n,
      bias: 0,
      sd: 0,
      limitsOfAgreement: { lower: 0, upper: 0 },
      rms: 0,
      maxAbsoluteDifference: 0,
      proportionalBias: { slope: 0, present: false },
      insufficient: true,
      summary:
        `${n} paired measurement${n === 1 ? "" : "s"} recorded. At least ${MIN_PAIRS} are ` +
        `needed before agreement can be reported — limits of agreement from fewer pairs ` +
        `have a confidence interval wider than the limits themselves.`,
    };
  }

  const differences = pairs.map((p) => p.device - p.reference);
  const means = pairs.map((p) => (p.device + p.reference) / 2);

  const bias = mean(differences);

  // Sample standard deviation, n−1. The population form understates the spread,
  // and understating the spread narrows the limits of agreement — an error in
  // the direction that makes the device look better than it is.
  const sd = Math.sqrt(
    differences.reduce((total, d) => total + (d - bias) ** 2, 0) / (n - 1),
  );

  const rms = Math.sqrt(differences.reduce((total, d) => total + d * d, 0) / n);
  const maxAbsoluteDifference = Math.max(...differences.map(Math.abs));

  const slope = regressionSlope(means, differences);

  // The threshold is judgement, not a standard: a slope steep enough that the
  // bias at one end of the observed range differs from the other end by more
  // than the SD of the differences is a slope that a single bias figure hides.
  const observedRange = Math.max(...means) - Math.min(...means);
  const present = observedRange > 0 && Math.abs(slope) * observedRange > sd;

  const suffix = unit ? ` ${unit}` : "";
  const sign = bias >= 0 ? "above" : "below";

  return {
    n,
    bias,
    sd,
    limitsOfAgreement: { lower: bias - 1.96 * sd, upper: bias + 1.96 * sd },
    rms,
    maxAbsoluteDifference,
    proportionalBias: { slope, present },
    insufficient: false,
    summary:
      `Across ${n} paired measurements the band read ${Math.abs(bias).toFixed(1)}${suffix} ` +
      `${sign} the reference on average, and 95% of readings fell between ` +
      `${(bias - 1.96 * sd).toFixed(1)} and ${(bias + 1.96 * sd).toFixed(1)}${suffix} of it.` +
      (present
        ? ` The disagreement grows across the measured range, so this single figure ` +
          `understates the error at one end.`
        : ""),
  };
}

function mean(values: number[]): number {
  return values.reduce((total, v) => total + v, 0) / values.length;
}

/** Least-squares slope of y on x. Zero when x has no spread. */
function regressionSlope(x: number[], y: number[]): number {
  const mx = mean(x);
  const my = mean(y);

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < x.length; i += 1) {
    numerator += (x[i] - mx) * (y[i] - my);
    denominator += (x[i] - mx) ** 2;
  }

  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Whether a calibration result is good enough to rely on for a given channel.
 *
 * These are **usability thresholds, not clinical ones**, and the distinction
 * matters. They answer "is this band working correctly" — is it broken, is it
 * misassembled, is this unit worse than the others. They do not answer "may a
 * clinician act on this reading", which is a question a bench comparison cannot
 * reach at all.
 */
export const ACCEPTABLE: Record<string, { maxAbsBias: number; maxRms: number; unit: string }> = {
  // ±2 bpm bias against a fingertip reference is what a correctly-seated
  // MAX30102 achieves at rest. Worse than that at rest usually means the
  // sensor is loose or the ambient light shield is missing.
  heart_rate: { maxAbsBias: 2, maxRms: 5, unit: "bpm" },

  // Deliberately looser than the ISO 4% A_rms, because this is a bench
  // comparison at normal saturation against a consumer device that is itself
  // only specified to ±2%. Meeting this says the band is not broken. It says
  // nothing about the hypoxic range.
  spo2: { maxAbsBias: 2, maxRms: 4, unit: "%" },

  // The MLX90614 measures skin, and skin is not core temperature — it runs
  // 1–2 °C cooler and tracks ambient. The bias here is expected to be large and
  // negative against an oral or tympanic reference; what matters is that it is
  // *consistent*, which is why the RMS bound is tighter than the bias bound.
  temperature: { maxAbsBias: 2.0, maxRms: 1.0, unit: "°C" },
};

export type CalibrationVerdict = {
  channel: string;
  acceptable: boolean;
  /** Why, in a sentence somebody can act on. */
  reason: string;
};

export function verdict(channel: string, result: AgreementResult): CalibrationVerdict {
  const bounds = ACCEPTABLE[channel];

  if (!bounds) {
    return {
      channel,
      acceptable: false,
      reason: `No acceptance bounds are defined for ${channel}, so this cannot be judged.`,
    };
  }

  if (result.insufficient) {
    // Not a pass and not a fail. Reporting insufficient data as either is how a
    // calibration record becomes a claim nobody checked.
    return {
      channel,
      acceptable: false,
      reason: result.summary,
    };
  }

  const biasOk = Math.abs(result.bias) <= bounds.maxAbsBias;
  const rmsOk = result.rms <= bounds.maxRms;

  if (biasOk && rmsOk) {
    return {
      channel,
      acceptable: true,
      reason:
        `Within the bench-comparison bounds for ${channel} ` +
        `(bias ${result.bias.toFixed(1)}${bounds.unit}, RMS ${result.rms.toFixed(1)}${bounds.unit}). ` +
        `This indicates the sensor is working, not that the reading is clinically accurate.`,
    };
  }

  const failures: string[] = [];
  if (!biasOk) {
    failures.push(
      `a systematic offset of ${result.bias.toFixed(1)}${bounds.unit} ` +
        `(bound ±${bounds.maxAbsBias}${bounds.unit})`,
    );
  }
  if (!rmsOk) {
    failures.push(`RMS difference ${result.rms.toFixed(1)}${bounds.unit} (bound ${bounds.maxRms}${bounds.unit})`);
  }

  return {
    channel,
    acceptable: false,
    reason: `This unit shows ${failures.join(" and ")}. Check sensor seating and shielding before using it.`,
  };
}

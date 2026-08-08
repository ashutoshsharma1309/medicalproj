/**
 * Model drift — noticing when the world stops matching the training set.
 *
 * ── What can and cannot be measured here ───────────────────────────────────
 *
 * There are two kinds of drift, and AVERIS can honestly measure exactly one.
 *
 * **Data drift** — the inputs have moved. The population being monitored is
 * older, or sicker, or wearing a different sensor revision than the one the
 * model was fitted on. This is measurable without knowing whether any
 * prediction was right, because it compares distributions of *inputs*.
 *
 * **Concept drift** — the relationship between inputs and outcomes has moved.
 * Measuring it requires outcomes: which patients actually deteriorated. AVERIS
 * has no outcome data, and nothing in this file pretends otherwise. A
 * `driftReport` returns data drift and a null concept score, and the UI says
 * so.
 *
 * Reporting only the measurable one is the point. A drift dashboard that
 * invented an accuracy trend would be worse than no dashboard, because it
 * would be believed.
 *
 * ── Population Stability Index ─────────────────────────────────────────────
 *
 * PSI over binned distributions, which is the standard instrument for this and
 * is chosen here for a specific reason: it is *interpretable*. A KL divergence
 * of 0.12 means nothing to anyone; PSI has conventional bands that a reviewer
 * can act on, and the bands are printed beside the number.
 *
 *   PSI < 0.10   no meaningful shift
 *   0.10 – 0.25  moderate — worth watching
 *   PSI > 0.25   significant — investigate before trusting the model
 *
 * Those bands are industry convention rather than anything AVERIS established,
 * and `DRIFT_BANDS` says so.
 *
 * Pure and fully tested.
 */

export type DriftSeverity = "NONE" | "MODERATE" | "SIGNIFICANT" | "UNKNOWN";

export const DRIFT_BANDS = {
  moderate: 0.1,
  significant: 0.25,
  /** Where these came from, so nobody mistakes them for a clinical finding. */
  provenance:
    "Conventional PSI bands used in model monitoring. Not established by AVERIS and not clinically validated.",
} as const;

export type FeatureDrift = {
  feature: string;
  psi: number;
  severity: DriftSeverity;
  /** Bin-by-bin comparison, so a reviewer can see *where* it moved. */
  bins: { range: string; baselineShare: number; currentShare: number }[];
  baselineCount: number;
  currentCount: number;
};

export type DriftReport = {
  modelName: string;
  modelVersion: string;
  features: FeatureDrift[];
  /** The worst feature's severity. */
  overall: DriftSeverity;
  /**
   * Always null, and deliberately.
   *
   * Concept drift needs outcomes — which patients actually deteriorated — and
   * AVERIS has none. A number here would be invented.
   */
  conceptDrift: null;
  conceptDriftUnavailable: string;
  /** Predictions that failed outright, which is a different signal from drift. */
  failureRate: number | null;
  evaluatedAt: string;
  /** Why the report is empty, when it is. */
  unavailableReason: string | null;
};

/** Below this, a comparison is noise rather than a distribution. */
export const MIN_SAMPLES_FOR_DRIFT = 100;

/**
 * Population Stability Index between two samples of one feature.
 *
 * Bin edges come from the *baseline*, not from the combined data. Using
 * combined edges would let the current distribution move its own goalposts:
 * a shifted population would redraw the bins around itself and report less
 * drift than there is.
 */
export function populationStabilityIndex(
  baseline: number[],
  current: number[],
  binCount = 10,
): { psi: number; bins: FeatureDrift["bins"] } {
  if (baseline.length === 0 || current.length === 0) {
    return { psi: 0, bins: [] };
  }

  const sorted = [...baseline].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  // A baseline with no spread cannot produce bins. Reported as zero drift
  // rather than as an error: every value being identical is a fact about the
  // baseline, not a failure to measure.
  if (max === min) return { psi: 0, bins: [] };

  const width = (max - min) / binCount;
  const edges = Array.from({ length: binCount + 1 }, (_, i) => min + i * width);

  const bins: FeatureDrift["bins"] = [];
  let psi = 0;

  for (let i = 0; i < binCount; i += 1) {
    const low = edges[i];
    const high = edges[i + 1];
    // The last bin is closed on both sides, so the maximum value lands
    // somewhere rather than falling off the end.
    const last = i === binCount - 1;

    const inBin = (values: number[]) =>
      values.filter((v) => (last ? v >= low && v <= high : v >= low && v < high)).length;

    // Values outside the baseline's range go into the nearest bin rather than
    // being dropped — an excursion beyond anything seen in training is the
    // most interesting kind of drift, and discarding it would hide exactly the
    // signal worth having.
    let baselineInBin = inBin(baseline);
    let currentInBin = inBin(current);

    if (i === 0) {
      baselineInBin += baseline.filter((v) => v < low).length;
      currentInBin += current.filter((v) => v < low).length;
    }
    if (last) {
      baselineInBin += baseline.filter((v) => v > high).length;
      currentInBin += current.filter((v) => v > high).length;
    }

    // Laplace-style floor. A bin the current sample never hits would produce
    // log(0) and an infinite PSI, which is a division artefact rather than
    // infinite drift.
    const baselineShare = Math.max(baselineInBin / baseline.length, 0.0001);
    const currentShare = Math.max(currentInBin / current.length, 0.0001);

    psi += (currentShare - baselineShare) * Math.log(currentShare / baselineShare);

    bins.push({
      range: `${low.toFixed(1)}–${high.toFixed(1)}`,
      baselineShare: Number((baselineInBin / baseline.length).toFixed(4)),
      currentShare: Number((currentInBin / current.length).toFixed(4)),
    });
  }

  return { psi: Number(psi.toFixed(4)), bins };
}

export function severityFor(psi: number): DriftSeverity {
  if (psi >= DRIFT_BANDS.significant) return "SIGNIFICANT";
  if (psi >= DRIFT_BANDS.moderate) return "MODERATE";
  return "NONE";
}

export type DriftInput = {
  modelName: string;
  modelVersion: string;
  /** Feature values from the period the model was fitted on. */
  baseline: Record<string, number[]>;
  /** The same features, observed recently. */
  current: Record<string, number[]>;
  /** Inference attempts and how many failed, if known. */
  inference?: { attempts: number; failures: number };
  now?: string;
};

/**
 * Compares recent inputs against the training distribution.
 *
 * Refuses rather than reporting when either sample is too small. A PSI over
 * forty readings is a number with error bars wider than its own bands, and
 * presenting it beside a real one would make both unreadable.
 */
export function driftReport(input: DriftInput): DriftReport {
  const evaluatedAt = input.now ?? new Date().toISOString();

  const conceptDriftUnavailable =
    "Concept drift cannot be measured. It requires knowing which patients actually " +
    "deteriorated, and AVERIS has no outcome data — so no accuracy trend is reported.";

  const failureRate =
    input.inference && input.inference.attempts > 0
      ? Number((input.inference.failures / input.inference.attempts).toFixed(4))
      : null;

  const features: FeatureDrift[] = [];

  for (const [feature, baselineValues] of Object.entries(input.baseline)) {
    const currentValues = input.current[feature] ?? [];

    if (
      baselineValues.length < MIN_SAMPLES_FOR_DRIFT ||
      currentValues.length < MIN_SAMPLES_FOR_DRIFT
    ) {
      features.push({
        feature,
        psi: 0,
        severity: "UNKNOWN",
        bins: [],
        baselineCount: baselineValues.length,
        currentCount: currentValues.length,
      });
      continue;
    }

    const { psi, bins } = populationStabilityIndex(baselineValues, currentValues);

    features.push({
      feature,
      psi,
      severity: severityFor(psi),
      bins,
      baselineCount: baselineValues.length,
      currentCount: currentValues.length,
    });
  }

  const measurable = features.filter((f) => f.severity !== "UNKNOWN");

  return {
    modelName: input.modelName,
    modelVersion: input.modelVersion,
    features,
    overall:
      measurable.length === 0
        ? "UNKNOWN"
        : measurable.some((f) => f.severity === "SIGNIFICANT")
          ? "SIGNIFICANT"
          : measurable.some((f) => f.severity === "MODERATE")
            ? "MODERATE"
            : "NONE",
    conceptDrift: null,
    conceptDriftUnavailable,
    failureRate,
    evaluatedAt,
    unavailableReason:
      measurable.length === 0
        ? `Not enough data to compare. Each feature needs at least ${MIN_SAMPLES_FOR_DRIFT} values in both periods.`
        : null,
  };
}

/**
 * What a reviewer should do about a report.
 *
 * Deliberately stops short of "retrain automatically". A model that retrains
 * itself on drifted data learns the drift, and in a clinical setting the
 * question "should this model still be used" is one a person answers.
 */
export function driftRecommendation(report: DriftReport): string {
  if (report.unavailableReason) return report.unavailableReason;

  switch (report.overall) {
    case "SIGNIFICANT":
      return (
        "The population being monitored has moved significantly from the one this model " +
        "was fitted on. Review whether it should still be serving before its predictions " +
        "are relied on — AVERIS does not retrain automatically, because a model retrained " +
        "on drifted data learns the drift."
      );
    case "MODERATE":
      return (
        "Inputs have shifted moderately from the training distribution. Worth watching; " +
        "not on its own a reason to stop using the model."
      );
    default:
      return "Recent inputs match the distribution this model was fitted on.";
  }
}

/**
 * Risk model types.
 *
 * These mirror the artifact written by `ml/prediction/export.py`. The Python
 * side is the source of truth for the shape; anything added there has to be
 * added here before the scorer can see it.
 */

export type RiskModel = "diabetes" | "cardiovascular";

export type RiskCategory = "LOW" | "MODERATE" | "HIGH";

/** A feature definition, exported verbatim from `ml/preprocessing/schema.py`. */
export type FeatureSpec = {
  name: string;
  label: string;
  unit: string | null;
  /** Clinical sanity range. A value outside this is a transcription error. */
  plausible: [number, number];
  higher_is_riskier: boolean | null;
  /** Whether AVERIS can read this from the patient's own confirmed records. */
  derivable: boolean;
};

export type ModelMetrics = {
  accuracy: number;
  precision: number;
  recall: number;
  f1_score: number;
  roc_auc: number;
  cv_roc_auc_mean: number;
  cv_roc_auc_std: number;
};

export type DatasetProvenance = {
  name: string;
  source: string;
  rows: number;
  cohort: string;
  /** The reason this model must never be read as a statement about a person. */
  caveat: string;
};

export type ModelArtifact = {
  model: RiskModel;
  version: string;
  trained_at: string;
  algorithm: string;
  dataset: DatasetProvenance;
  cleaning: Record<string, unknown>;
  positive_rate: number;
  features: FeatureSpec[];
  scaler: { mean: number[]; scale: number[] };
  coefficients: number[];
  intercept: number;
  scaled_means: number[];
  base_value: number;
  training_means: number[];
  /** Features whose fitted sign contradicts clinical expectation. */
  direction_disagreements: string[];
  metrics: Record<string, ModelMetrics>;
  served_algorithm: string;
  fixtures: ArtifactFixture[];
};

/** A held-out row with its reference SHAP values, used for parity testing. */
export type ArtifactFixture = {
  input: Record<string, number>;
  shap: number[];
  logit: number;
  probability: number;
};

/* ------------------------------------------------------------- inference */

/** One feature's value as it entered the model. */
export type FeatureInput = {
  name: string;
  label: string;
  unit: string | null;
  value: number;
  /**
   * True when the patient's record did not supply this and the training mean
   * was substituted. Every substitution lowers the reported confidence, and
   * the dashboard says which ones were guessed.
   */
  imputed: boolean;
  /** Where a derived value came from, so the patient can check it. */
  sourceLabel?: string;
};

/** A feature's contribution, in the units a patient can read. */
export type FeatureContribution = {
  name: string;
  label: string;
  unit: string | null;
  value: number;
  imputed: boolean;
  /** Exact Shapley value in log-odds space. */
  shap: number;
  /**
   * The same contribution expressed as a share of the total movement away
   * from the baseline, signed. This is the "+35%" a patient sees.
   */
  share: number;
  direction: "increases" | "decreases";
};

export type RiskPrediction = {
  model: RiskModel;
  modelVersion: string;
  /** Probability in [0, 1]. */
  riskScore: number;
  category: RiskCategory;
  /**
   * How much of this prediction rests on measured data rather than
   * substituted averages. Not the model's accuracy — see confidence.ts.
   */
  confidence: number;
  confidenceReason: string;
  baseValue: number;
  logit: number;
  inputs: FeatureInput[];
  contributions: FeatureContribution[];
  /** Always present. Never rendered as optional. */
  disclaimer: string;
};

import { categorize } from "./categories";
import { computeConfidence } from "./confidence";
import { contributionShares, logit, shapValues, sigmoid } from "./inference";
import type {
  FeatureContribution,
  FeatureInput,
  ModelArtifact,
  RiskPrediction,
} from "./types";

/**
 * Assembles a complete, explained prediction.
 *
 * Pure: artifact plus values in, prediction out. No database, no network, no
 * clock. Every number a patient is shown originates here, which means the
 * whole user-visible surface of the ML feature is testable offline.
 */

/** A value AVERIS read from the patient's record, plus where it came from. */
export type DerivedValue = { value: number; sourceLabel?: string };

export const DISCLAIMER =
  "This is a statistical estimate from a model trained on a public research " +
  "dataset, not a diagnosis and not a prediction of what will happen to you. " +
  "Discuss it with your healthcare provider.";

export function predict(
  artifact: ModelArtifact,
  derived: Record<string, DerivedValue | undefined>,
): RiskPrediction {
  const inputs: FeatureInput[] = artifact.features.map((feature, i) => {
    const supplied = derived[feature.name];
    return {
      name: feature.name,
      label: feature.label,
      unit: feature.unit,
      value: supplied?.value ?? artifact.training_means[i],
      imputed: supplied === undefined,
      sourceLabel: supplied?.sourceLabel,
    };
  });

  const values = inputs.map((input) => input.value);
  const rawLogit = logit(artifact, values);
  const riskScore = sigmoid(rawLogit);

  const shap = shapValues(artifact, values);
  const shares = contributionShares(shap);

  const contributions: FeatureContribution[] = inputs
    .map((input, i) => ({
      name: input.name,
      label: input.label,
      unit: input.unit,
      value: input.value,
      imputed: input.imputed,
      shap: shap[i],
      share: shares[i],
      direction: (shap[i] >= 0 ? "increases" : "decreases") as "increases" | "decreases",
    }))
    // Strongest influence first, regardless of direction: a patient asking
    // "why?" wants what moved the number most, not what raised it most.
    .sort((a, b) => Math.abs(b.shap) - Math.abs(a.shap));

  const { confidence, reason } = computeConfidence(artifact, inputs);

  return {
    model: artifact.model,
    modelVersion: artifact.version,
    riskScore,
    category: categorize(riskScore),
    confidence,
    confidenceReason: reason,
    baseValue: artifact.base_value,
    logit: rawLogit,
    inputs,
    contributions,
    disclaimer: DISCLAIMER,
  };
}

/** The contributions worth putting in front of a patient. */
export function topContributions(
  prediction: RiskPrediction,
  limit = 4,
): FeatureContribution[] {
  return prediction.contributions
    // A contribution under one percent of total movement is noise, and listing
    // it invites a patient to act on something the model barely noticed.
    .filter((c) => Math.abs(c.share) >= 0.01)
    .slice(0, limit);
}

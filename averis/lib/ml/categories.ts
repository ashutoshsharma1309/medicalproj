import type { RiskCategory } from "./types";

/**
 * Risk banding.
 *
 * Three bands, because a patient cannot act on more granularity than that and
 * a ten-point scale would imply a precision these models do not have.
 *
 * The thresholds are product decisions, not statistical ones. They are set
 * here rather than in the artifact so that changing how a number is *described*
 * never requires retraining a model.
 */

const HIGH = 0.7;
const MODERATE = 0.3;

export function categorize(riskScore: number): RiskCategory {
  if (riskScore >= HIGH) return "HIGH";
  if (riskScore >= MODERATE) return "MODERATE";
  return "LOW";
}

/**
 * What each band means, phrased as an observation about the model rather than
 * a statement about the patient.
 *
 * "You are at high risk" is a claim about a person. "This model placed your
 * inputs in its higher-risk range" is a claim about a computation, which is
 * the only thing AVERIS is entitled to say.
 */
export const CATEGORY_MEANING: Record<RiskCategory, string> = {
  LOW: "Your values sit in the model's lower-risk range.",
  MODERATE: "Your values sit in the model's middle range.",
  HIGH: "Your values sit in the model's higher-risk range.",
};

export const CATEGORY_LABEL: Record<RiskCategory, string> = {
  LOW: "Lower",
  MODERATE: "Moderate",
  HIGH: "Higher",
};

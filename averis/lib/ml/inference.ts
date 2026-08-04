import type { ArtifactFixture, ModelArtifact } from "./types";

/**
 * Scoring and exact SHAP.
 *
 * A logistic regression wrapped in a StandardScaler is arithmetic:
 *
 *     z_i   = (x_i - mean_i) / scale_i
 *     logit = intercept + Σ coef_i · z_i
 *     risk  = sigmoid(logit)
 *
 * and the Shapley value of a feature in a linear model has a closed form:
 *
 *     φ_i   = coef_i · (z_i - z̄_i)
 *     base  = intercept + Σ coef_i · z̄_i
 *
 * These are not approximations. There is no background sample, no Monte Carlo
 * step, and no run-to-run variance — the same input always yields the same
 * explanation, and `logit === base + Σ φ` holds to floating-point precision.
 *
 * That identity is the whole point. When AVERIS tells a patient glucose
 * contributed +35% of their risk, the contributions it shows necessarily
 * reconstruct the score it showed them. The parity tests assert both the
 * identity and agreement with Python's `shap` library on every exported
 * fixture.
 */

/** Feature values in the artifact's own order. */
export function scale(artifact: ModelArtifact, values: number[]): number[] {
  return values.map((value, i) => (value - artifact.scaler.mean[i]) / artifact.scaler.scale[i]);
}

export function logit(artifact: ModelArtifact, values: number[]): number {
  const z = scale(artifact, values);
  let total = artifact.intercept;
  for (let i = 0; i < z.length; i += 1) total += artifact.coefficients[i] * z[i];
  return total;
}

export function sigmoid(x: number): number {
  // Split on the sign so neither branch can overflow: exp(1000) is Infinity,
  // and Infinity/Infinity is NaN, which would surface as a blank risk score.
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

export function predictProbability(artifact: ModelArtifact, values: number[]): number {
  return sigmoid(logit(artifact, values));
}

/** Exact Shapley values in log-odds space, in the artifact's feature order. */
export function shapValues(artifact: ModelArtifact, values: number[]): number[] {
  const z = scale(artifact, values);
  return z.map((zi, i) => artifact.coefficients[i] * (zi - artifact.scaled_means[i]));
}

/**
 * Turns Shapley values into the signed percentages a patient reads.
 *
 * Normalised by the total absolute movement rather than by the logit, because
 * the logit can sit near zero while individual features pull hard in opposite
 * directions — dividing by it would produce contributions of several hundred
 * percent.
 */
export function contributionShares(shap: number[]): number[] {
  const magnitude = shap.reduce((sum, value) => sum + Math.abs(value), 0);
  if (magnitude === 0) return shap.map(() => 0);
  return shap.map((value) => value / magnitude);
}

/** Reconstruction check used by the tests and by the artifact self-check. */
export function verifyFixture(
  artifact: ModelArtifact,
  fixture: ArtifactFixture,
  tolerance = 1e-6,
): { logitOk: boolean; probabilityOk: boolean; shapOk: boolean; identityOk: boolean } {
  const values = artifact.features.map((f) => fixture.input[f.name]);

  const ourLogit = logit(artifact, values);
  const ourProbability = predictProbability(artifact, values);
  const ourShap = shapValues(artifact, values);

  const sum = ourShap.reduce((a, b) => a + b, 0);

  return {
    logitOk: Math.abs(ourLogit - fixture.logit) < tolerance,
    probabilityOk: Math.abs(ourProbability - fixture.probability) < tolerance,
    shapOk: ourShap.every((value, i) => Math.abs(value - fixture.shap[i]) < tolerance),
    identityOk: Math.abs(artifact.base_value + sum - ourLogit) < tolerance,
  };
}

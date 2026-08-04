import type { FeatureInput, ModelArtifact } from "./types";

/**
 * Prediction confidence.
 *
 * This is **not** the model's accuracy. It answers a narrower and more useful
 * question: how much of *this particular* prediction rests on the patient's
 * own measurements rather than on population averages substituted for data
 * AVERIS does not have.
 *
 * A patient with one confirmed glucose reading and nothing else gets a number
 * that is mostly an average of the Pima cohort. Reporting that at the same
 * confidence as a fully-measured patient would be the single most misleading
 * thing this feature could do.
 *
 * Substitutions are weighted by |coefficient|, so missing the feature the
 * model leans on hardest costs more than missing one it barely uses. Missing
 * glucose in the diabetes model should hurt; missing skinfold thickness
 * should barely register.
 */

/** Confidence can never read as certainty, however complete the inputs. */
const CEILING = 0.95;

/** Nor as worthless — the model still ran, on a real cohort. */
const FLOOR = 0.1;

export function computeConfidence(
  artifact: ModelArtifact,
  inputs: FeatureInput[],
): { confidence: number; reason: string } {
  const weights = artifact.coefficients.map(Math.abs);
  const total = weights.reduce((a, b) => a + b, 0);

  if (total === 0) {
    return { confidence: FLOOR, reason: "This model has no fitted signal." };
  }

  let measuredWeight = 0;
  const imputed: string[] = [];

  inputs.forEach((input, i) => {
    if (input.imputed) imputed.push(input.label.toLowerCase());
    else measuredWeight += weights[i];
  });

  const confidence = Math.max(FLOOR, Math.min(CEILING, measuredWeight / total));

  return { confidence, reason: explain(inputs.length, imputed) };
}

function explain(featureCount: number, imputed: string[]): string {
  if (imputed.length === 0) {
    return `All ${featureCount} inputs came from your own records.`;
  }

  const measured = featureCount - imputed.length;

  if (measured === 0) {
    return (
      `None of the ${featureCount} inputs could be read from your records, so ` +
      `this is a population average rather than an assessment of you. Add a ` +
      `recent report to make it yours.`
    );
  }

  const listed =
    imputed.length <= 3
      ? imputed.join(", ")
      : `${imputed.slice(0, 3).join(", ")} and ${imputed.length - 3} more`;

  return (
    `${measured} of ${featureCount} inputs came from your records. ` +
    `Population averages were used for ${listed}.`
  );
}

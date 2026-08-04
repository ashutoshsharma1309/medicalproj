import type { HealthInsight } from "@/lib/services/twin/types";
import { CATEGORY_LABEL } from "./categories";
import { topContributions } from "./predict";
import type { RiskModel, RiskPrediction } from "./types";

/**
 * Surfacing risk assessments inside the Digital Twin.
 *
 * Pure, and deliberately kept out of `twin/assemble.ts`. The twin's own
 * insight engine describes what is *in* the record; these describe what a
 * model *inferred from* it. Merging the two engines would blur a distinction
 * the patient needs: one is arithmetic over their own confirmed data, the
 * other is a statistical estimate from a public research cohort.
 *
 * So they share a type and a rendering, but not a code path — and every
 * risk-derived insight names the model and its version.
 */

const TITLES: Record<RiskModel, string> = {
  diabetes: "diabetes",
  cardiovascular: "cardiovascular",
};

/** Converts risk assessments into insights the Health Twin can render. */
export function riskInsights(
  predictions: { prediction: RiskPrediction }[],
): HealthInsight[] {
  return predictions.map(({ prediction }) => {
    const percent = Math.round(prediction.riskScore * 100);
    const band = CATEGORY_LABEL[prediction.category].toLowerCase();
    const drivers = topContributions(prediction, 2);

    const measuredDrivers = drivers.filter((d) => !d.imputed);
    const driverText =
      measuredDrivers.length > 0
        ? ` The inputs that moved it most were ${measuredDrivers
            .map((d) => d.label.toLowerCase())
            .join(" and ")}.`
        : " No input came from your own records, so this reflects the cohort rather than you.";

    return {
      insightType: "TREND",
      // Phrased as a statement about a model, not about the patient. "You are
      // at higher risk" is a claim AVERIS is not entitled to make.
      insightText:
        `The ${TITLES[prediction.model]} risk model placed your inputs at ${percent}%, ` +
        `in its ${band} range.${driverText}`,
      importanceLevel: prediction.category === "HIGH" ? "HIGH" : "MEDIUM",
      evidence: [
        ...drivers.map((driver) => ({
          label: driver.label,
          value: driver.imputed
            ? "population average"
            : `${formatValue(driver.value)}${driver.unit ? ` ${driver.unit}` : ""}`,
        })),
        {
          label: "Model",
          value: `logistic regression ${prediction.modelVersion}`,
        },
      ],
      // The twin shows this as the insight's confidence, so it must be the
      // input-completeness figure rather than the model's accuracy — the
      // patient is being told how much of this is about them.
      confidenceScore: prediction.confidence,
    };
  });
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

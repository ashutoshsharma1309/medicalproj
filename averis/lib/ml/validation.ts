import { z } from "zod";
import { loadArtifact } from "./artifact";
import type { RiskModel } from "./types";

/**
 * Input validation.
 *
 * Built from the artifact's own plausible ranges, so the API cannot accept a
 * value the model was never trained near. This is a safety control, not a
 * convenience: a glucose of 1600 is a misplaced decimal, and scoring it would
 * hand a patient a confident 99% that reflects a typo.
 *
 * Every field is optional. A caller supplying only what it has is the normal
 * case — the risk service substitutes training means for the rest and reports
 * a lower confidence, rather than refusing to answer.
 */

const schemas = new Map<RiskModel, z.ZodType>();

export function riskInputSchema(model: RiskModel): z.ZodType {
  const cached = schemas.get(model);
  if (cached) return cached;

  const artifact = loadArtifact(model);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const feature of artifact.features) {
    const [min, max] = feature.plausible;
    shape[feature.name] = z
      .number({ message: `${feature.label} must be a number.` })
      .finite(`${feature.label} must be a real number.`)
      .min(min, `${feature.label} must be at least ${min}${suffix(feature.unit)}.`)
      .max(max, `${feature.label} must be at most ${max}${suffix(feature.unit)}.`)
      .optional();
  }

  // strict(): an unrecognised key is a client bug or a probe, and silently
  // dropping it would hide both.
  const schema = z.object(shape).strict();
  schemas.set(model, schema);
  return schema;
}

function suffix(unit: string | null): string {
  return unit ? ` ${unit}` : "";
}

export function isRiskModel(value: string): value is RiskModel {
  return value === "diabetes" || value === "cardiovascular";
}

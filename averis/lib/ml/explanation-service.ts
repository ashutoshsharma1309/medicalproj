import { enforceNoDiagnosis } from "@/lib/services/documents/review";
import type { CompletionFn } from "@/lib/services/documents/extraction-service";
import { CATEGORY_MEANING } from "./categories";
import { topContributions } from "./predict";
import type { ModelArtifact, RiskPrediction } from "./types";

/**
 * Narrating a prediction.
 *
 * The division of labour is the same one used everywhere else in AVERIS, and
 * it matters more here than anywhere: **the model predicts, the LLM only
 * phrases**. Every number in the prompt below was computed by the logistic
 * regression and its closed-form SHAP. The model is asked to turn those into
 * sentences, and it is given nothing it could use to invent a different score.
 *
 * A language model asked "how likely is this patient to develop diabetes"
 * will answer, fluently and without any basis. That is precisely the failure
 * this architecture exists to prevent.
 */

const SYSTEM_PROMPT = `You explain a statistical risk estimate to a patient inside AVERIS, a personal health record platform.

A machine learning model has already computed the risk score and the exact contribution of each input. Your only job is to restate those numbers in plain language.

Hard rules:
- Use ONLY the figures provided. Never state a number that is not in the input.
- This is a risk estimate from a model trained on a public research dataset. It is NOT a diagnosis, NOT a prediction of what will happen, and NOT a statement that the patient has or will get any condition.
- NEVER diagnose, assess severity, predict an outcome, or recommend a treatment, drug or dose.
- Do not tell the patient what their values mean clinically. Restating a recorded number is allowed; judging it is not.
  ALLOWED:     "Glucose was the largest single contributor, accounting for about 35% of the movement in your score."
  NOT ALLOWED: "Your glucose is dangerously high and needs to be brought under control."
- If inputs were substituted with population averages, say so plainly — the patient needs to know the estimate is partly generic.
- Address the patient as "you". Calm and factual. No alarm, no reassurance — neither is yours to give.
- 3 to 5 sentences of plain prose. No headings, no bullets, no markdown.`;

export type RiskExplanation = {
  narrative: string;
  awareness: string[];
  model: string;
  fallback: boolean;
  guardrailTriggered: boolean;
};

export async function explainPrediction(
  prediction: RiskPrediction,
  artifact: ModelArtifact,
  options: { complete?: CompletionFn; model?: string } = {},
): Promise<RiskExplanation> {
  const awareness = awarenessPoints(prediction);
  const deterministic = deterministicNarrative(prediction, artifact);

  let complete = options.complete;
  let model = options.model;

  // Imported lazily and only when no client was injected, so the `server-only`
  // chain never enters the module graph during testing.
  if (!complete) {
    try {
      const provider = await import("@/lib/ai/provider");
      complete = provider.aiComplete as CompletionFn;
      // Provenance must name the model that actually ran, not a default guess.
      model ??= provider.resolveProvider().model;
    } catch {
      return { narrative: deterministic, awareness, model: "deterministic", fallback: true, guardrailTriggered: false };
    }
  }

  try {
    const raw = await complete({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: describePrediction(prediction, artifact) },
      ],
      maxTokens: 400,
    });

    const checked = enforceNoDiagnosis(raw.trim());
    return {
      narrative: checked.rewritten ? deterministic : checked.summary,
      awareness,
      model: model ?? "unknown",
      fallback: false,
      guardrailTriggered: checked.rewritten,
    };
  } catch {
    return { narrative: deterministic, awareness, model: "deterministic", fallback: true, guardrailTriggered: false };
  }
}

/** Everything the model is allowed to know. Facts only, all pre-computed. */
export function describePrediction(prediction: RiskPrediction, artifact: ModelArtifact): string {
  const lines: string[] = [
    `Risk type: ${prediction.model}`,
    `Risk score: ${(prediction.riskScore * 100).toFixed(0)}%`,
    `Band: ${prediction.category} — ${CATEGORY_MEANING[prediction.category]}`,
    `Model: logistic regression, version ${prediction.modelVersion}, trained on ${artifact.dataset.name} (${artifact.dataset.rows} rows).`,
    `Model ROC-AUC on held-out data: ${artifact.metrics[artifact.served_algorithm]?.roc_auc ?? "unknown"}`,
    `Confidence in these inputs: ${(prediction.confidence * 100).toFixed(0)}% — ${prediction.confidenceReason}`,
    "",
    "Contributions (already computed; do not recalculate):",
  ];

  for (const contribution of topContributions(prediction, 6)) {
    const share = `${contribution.share >= 0 ? "+" : ""}${(contribution.share * 100).toFixed(0)}%`;
    const unit = contribution.unit ? ` ${contribution.unit}` : "";
    const provenance = contribution.imputed ? " (population average, not measured)" : "";
    lines.push(
      `- ${contribution.label}: ${round(contribution.value)}${unit}${provenance} → ${share} ${contribution.direction} the score`,
    );
  }

  const imputed = prediction.inputs.filter((i) => i.imputed);
  if (imputed.length > 0) {
    lines.push("", `Substituted with population averages: ${imputed.map((i) => i.label).join(", ")}.`);
  }

  return lines.join("\n");
}

/**
 * Used when no model is configured or the call fails — and when the guardrail
 * catches the model drifting into clinical judgement.
 *
 * Assembled from the same numbers, so the page is never empty and never says
 * anything the prediction did not already contain.
 */
export function deterministicNarrative(
  prediction: RiskPrediction,
  artifact: ModelArtifact,
): string {
  const percent = Math.round(prediction.riskScore * 100);
  const parts: string[] = [
    `This model placed your inputs at ${percent}%. ${CATEGORY_MEANING[prediction.category]}`,
  ];

  const top = topContributions(prediction, 3);
  if (top.length > 0) {
    const described = top.map(
      (c) =>
        `${c.label.toLowerCase()} (${c.share >= 0 ? "+" : ""}${Math.round(c.share * 100)}%)`,
    );
    parts.push(`The inputs that moved it most were ${joinList(described)}.`);
  }

  parts.push(prediction.confidenceReason);
  parts.push(
    `The model was fitted on ${artifact.dataset.name}: ${artifact.dataset.cohort.toLowerCase()}. ${artifact.dataset.caveat}`,
  );

  return parts.join(" ");
}

/**
 * General awareness points.
 *
 * Deliberately not "recommendations". Every one of these is either an
 * observation about the record or a prompt to talk to a clinician — never an
 * instruction about diet, exercise, medication or dose.
 */
export function awarenessPoints(prediction: RiskPrediction): string[] {
  const points: string[] = [];

  const measuredDrivers = prediction.contributions.filter(
    (c) => !c.imputed && c.direction === "increases" && c.share >= 0.1,
  );

  for (const driver of measuredDrivers.slice(0, 2)) {
    points.push(
      `${driver.label} was among the largest contributors to this estimate. It is worth raising with your healthcare provider at your next appointment.`,
    );
  }

  const imputed = prediction.inputs.filter((i) => i.imputed);
  if (imputed.length > 0) {
    points.push(
      `This estimate used population averages for ${imputed.length} of ${prediction.inputs.length} inputs. Adding a recent report would make it reflect you rather than the cohort.`,
    );
  }

  if (prediction.category === "HIGH") {
    points.push(
      "A higher-range result is a prompt to have a conversation, not a finding. Bring this to a clinician who can order the tests that actually settle the question.",
    );
  }

  points.push(
    "AVERIS does not provide medical advice. Nothing here replaces an assessment by a qualified clinician.",
  );

  return points;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

import { enforceNoDiagnosis } from "@/lib/services/documents/review";
import type { CompletionFn } from "@/lib/services/documents/extraction-service";
import type { DigitalTwin } from "./types";

/**
 * Health summary service.
 *
 * The model's job here is *phrasing*, not deciding. Every fact in the prompt
 * has already been derived deterministically by the timeline, insight and
 * overview services — the summary restates them in plain language.
 *
 * This split matters: a language model asked to compute a trend can invent a
 * direction. Asked only to narrate one it was handed, it cannot.
 *
 * Output passes through the same enforceNoDiagnosis guardrail used on document
 * summaries, so a drift into clinical judgement is caught rather than shown.
 */

const SYSTEM_PROMPT = `You write health summaries for patients inside AVERIS, a personal health record platform.

You are given facts already extracted and verified from the patient's own record. Restate them clearly. You are NOT analysing anything.

Hard rules:
- Use ONLY the facts provided. Never add a condition, medication, value or date that is not in the input.
- NEVER diagnose, assess severity, predict outcomes, or recommend treatment.
- Do not draw conclusions from values. Restating a recorded number is allowed; judging what it means is not.
  ALLOWED:     "Your record shows HbA1c rising from 6.8% to 8.2% across three reports."
  NOT ALLOWED: "Your diabetes is poorly controlled and needs attention."
- Address the patient as "you". Warm, calm, factual. No alarm, no reassurance — neither is yours to give.
- 3 to 5 sentences, plain prose. No headings, no bullet points, no markdown.
- Close by directing the patient to their healthcare provider for interpretation.`;

export type HealthSummaryResult = {
  summary: string;
  /** True when the guardrail had to replace drifting output. */
  guardrailTriggered: boolean;
  model: string;
  /** Set when the model was unavailable and a deterministic summary was used. */
  fallback: boolean;
};

export async function generateHealthSummary(
  twin: DigitalTwin,
  opts?: { complete?: CompletionFn; model?: string },
): Promise<HealthSummaryResult> {
  const facts = describeTwin(twin);

  let complete = opts?.complete;
  let model = opts?.model;

  if (!complete) {
    try {
      const provider = await import("@/lib/ai/provider");
      if (!provider.isAiConfigured()) {
        return { ...deterministicSummary(twin), model: "deterministic", fallback: true };
      }
      complete = provider.aiComplete as CompletionFn;
      model ??= provider.resolveProvider().model;
    } catch {
      return { ...deterministicSummary(twin), model: "deterministic", fallback: true };
    }
  }
  model ??= "injected-client";

  try {
    const raw = await complete({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Write this patient's health summary using only these facts.\n\n${facts}`,
        },
      ],
      maxTokens: 700,
    });

    const guarded = enforceNoDiagnosis(raw.trim());
    return {
      summary: guarded.summary,
      guardrailTriggered: guarded.rewritten,
      model,
      fallback: false,
    };
  } catch {
    // A summary is a convenience; the twin itself is the product. Never fail
    // the page because the model was unreachable.
    return { ...deterministicSummary(twin), model: "deterministic", fallback: true };
  }
}

/** Flattens the twin into the fact sheet handed to the model. */
export function describeTwin(twin: DigitalTwin): string {
  const lines: string[] = [];

  lines.push(`Age: ${twin.age ?? "not recorded"}`);
  lines.push(`Blood group: ${twin.profile.bloodGroup ?? "not recorded"}`);

  lines.push(
    `Recorded conditions: ${
      twin.conditions.length
        ? twin.conditions
            .map((c) => `${c.conditionName}${c.firstDetected ? ` (first recorded ${c.firstDetected})` : ""}`)
            .join("; ")
        : "none recorded"
    }`,
  );

  const current = twin.medications.filter((m) => m.endDate === null);
  lines.push(
    `Current medications: ${
      current.length
        ? current.map((m) => [m.medicineName, m.dosage, m.frequency].filter(Boolean).join(" ")).join("; ")
        : "none recorded"
    }`,
  );

  lines.push(
    `Allergies: ${twin.profile.allergies.length ? twin.profile.allergies.join("; ") : "none recorded"}`,
  );

  if (twin.insights.length > 0) {
    lines.push("Observations already computed from the record:");
    for (const insight of twin.insights.slice(0, 6)) {
      lines.push(`  - ${insight.insightText}`);
    }
  }

  if (twin.timeline.length > 0) {
    lines.push("Most recent events:");
    for (const event of twin.timeline.slice(0, 6)) {
      lines.push(`  - ${event.eventDate}: ${event.eventTitle}`);
    }
  }

  lines.push(`Documents on file: ${twin.documentCount}`);
  return lines.join("\n");
}

/**
 * Used when no model is configured or the call fails. Assembled from the same
 * facts, so the page is never empty and never invents anything.
 */
export function deterministicSummary(twin: DigitalTwin): {
  summary: string;
  guardrailTriggered: boolean;
} {
  const parts: string[] = [];

  if (twin.conditions.length > 0) {
    parts.push(
      `Your record lists ${twin.conditions.length} condition${
        twin.conditions.length > 1 ? "s" : ""
      }: ${twin.conditions.map((c) => c.conditionName).join(", ")}.`,
    );
  } else {
    parts.push("Your record does not list any conditions yet.");
  }

  const current = twin.medications.filter((m) => m.endDate === null);
  if (current.length > 0) {
    parts.push(
      `Your record shows ${current.length} current medication${current.length > 1 ? "s" : ""}: ${current
        .map((m) => m.medicineName)
        .join(", ")}.`,
    );
  }

  if (twin.profile.allergies.length > 0) {
    parts.push(`Recorded allergies: ${twin.profile.allergies.join(", ")}.`);
  }

  const trend = twin.insights.find((i) => i.insightType === "TREND");
  if (trend) parts.push(trend.insightText);

  parts.push(
    `AVERIS has ${twin.documentCount} document${twin.documentCount === 1 ? "" : "s"} on file. Discuss anything in your record with your healthcare provider — AVERIS organizes your information and does not provide medical advice.`,
  );

  return { summary: parts.join(" "), guardrailTriggered: false };
}

import { enforceNoDiagnosis } from "@/lib/services/documents/review";
import type { CompletionFn } from "@/lib/services/documents/extraction-service";
import type { BuiltContext } from "./context-builder";
import { DISCLAIMER, type GroundedAnswer } from "./types";

/**
 * Grounded answer generation.
 *
 * The model is given retrieved context and a question, and is forbidden from
 * using anything else. That constraint is what separates this from a medical
 * chatbot: asked "is 8.2 bad?", a general assistant answers from its training
 * data; AVERIS answers from the patient's report and a cited reference range,
 * or it says it does not have the information.
 *
 * Abstention is a feature. An empty retrieval means the honest answer is "I
 * cannot find that in your records" — which is useful, and far better than a
 * fluent paragraph assembled from nothing.
 */

const SYSTEM_PROMPT = `You help a patient understand their own medical records inside AVERIS, a personal health record platform.

You will be given CONTEXT drawn from two kinds of source, each labelled:
- PATIENT RECORD — information from this patient's own uploaded documents.
- MEDICAL REFERENCE — general educational material.

Hard rules:
- Answer ONLY from the CONTEXT. If it does not contain the answer, say so plainly and stop. Never fill a gap from general knowledge.
- Never state a number, date, medication or result that does not appear in the CONTEXT.
- NEVER diagnose, assess severity, predict an outcome, or recommend a treatment, drug or dose.
- Never present a MEDICAL REFERENCE range as something measured about this patient. Reference material describes populations; the patient's own values come only from PATIENT RECORD.
- Explaining what a term means is allowed. Judging what the patient's value means clinically is not.
  ALLOWED:     "HbA1c reflects average blood sugar over about three months. Your record shows 8.2%, and the reference range on the report is 4.0-5.6%."
  NOT ALLOWED: "Your HbA1c of 8.2% means your diabetes is poorly controlled and needs treatment."
- Address the patient as "you". Calm, plain, factual. No alarm and no reassurance.
- 2 to 5 sentences of prose. No headings, no bullets, no markdown.
- Where it is natural, say which document the information came from.`;

const ABSTENTION =
  "I could not find anything in your records or the reference material that answers this. " +
  "If the information should be there, adding the relevant report would let AVERIS use it.";

export async function generateAnswer(
  question: string,
  context: BuiltContext,
  options: { complete?: CompletionFn; model?: string } = {},
): Promise<GroundedAnswer> {
  if (context.empty) {
    return {
      question,
      answer: ABSTENTION,
      sources: [],
      abstained: true,
      guardrailTriggered: false,
      generatedBy: "deterministic",
      disclaimer: DISCLAIMER,
    };
  }

  const fallback = deterministicAnswer(question, context);

  let complete = options.complete;
  let model = options.model;

  // Imported lazily and only when nothing was injected, so the `server-only`
  // chain stays out of the module graph during testing.
  if (!complete) {
    try {
      const provider = await import("@/lib/ai/provider");
      complete = provider.aiComplete as CompletionFn;
      model ??= provider.resolveProvider().model;
    } catch {
      return fallback;
    }
  }

  try {
    const raw = await complete({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(question, context) },
      ],
      maxTokens: 500,
    });

    const checked = enforceNoDiagnosis(raw.trim());

    return {
      question,
      answer: checked.rewritten ? fallback.answer : checked.summary,
      sources: context.sources,
      abstained: false,
      guardrailTriggered: checked.rewritten,
      generatedBy: checked.rewritten ? "deterministic" : model ?? "unknown",
      disclaimer: DISCLAIMER,
    };
  } catch {
    return fallback;
  }
}

export function buildUserPrompt(question: string, context: BuiltContext): string {
  return [
    "CONTEXT:",
    context.context,
    "",
    "QUESTION:",
    question,
    "",
    "Answer using only the CONTEXT above.",
  ].join("\n");
}

/**
 * Used when no model is configured, when the call fails, and when the
 * guardrail catches a drift into clinical judgement.
 *
 * It quotes the retrieved material rather than interpreting it. That is a
 * genuinely worse answer than a good generated one — and a much better
 * failure than a fluent wrong one.
 */
export function deterministicAnswer(
  question: string,
  context: BuiltContext,
): GroundedAnswer {
  const patient = context.chunks.filter((c) => c.sourceType === "PATIENT_DOCUMENT");
  const reference = context.chunks.filter((c) => c.sourceType === "MEDICAL_KNOWLEDGE");

  const parts: string[] = [];

  if (patient.length > 0) {
    parts.push(
      `Here is what your records contain on this. ${excerpt(patient[0].content)}`,
    );
  }
  if (reference.length > 0) {
    parts.push(`From the reference material: ${excerpt(reference[0].content)}`);
  }

  parts.push("Your healthcare provider can tell you what this means for you specifically.");

  return {
    question,
    answer: parts.join(" "),
    sources: context.sources,
    abstained: false,
    guardrailTriggered: false,
    generatedBy: "deterministic",
    disclaimer: DISCLAIMER,
  };
}

function excerpt(content: string, limit = 320): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit).replace(/\s+\S*$/, "")}…`;
}

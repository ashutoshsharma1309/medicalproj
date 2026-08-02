import Anthropic from "@anthropic-ai/sdk";

/**
 * Thin wrapper around the Anthropic SDK.
 *
 * The platform is designed so every clinical computation (risk, triage,
 * interactions) is produced by deterministic, auditable rule engines.
 * The LLM layer adds extraction from unstructured text, clinician-facing
 * narratives, documentation drafting and evidence synthesis. When no API
 * key is configured the callers fall back to structured template output,
 * so the product remains fully demoable offline.
 */

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

let _client: Anthropic | null = null;

export function aiAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function client(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

export class AiRefusalError extends Error {
  constructor(public category: string | null) {
    super("The model declined this request for safety reasons.");
  }
}

/** stop_details is newer than the installed SDK's typings — read defensively. */
function refusalCategory(response: unknown): string | null {
  const details = (response as { stop_details?: { category?: string | null } }).stop_details;
  return details?.category ?? null;
}

/** Plain-text completion. */
export async function complete(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  const response = await client().messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
  });
  if (response.stop_reason === "refusal") {
    throw new AiRefusalError(refusalCategory(response));
  }
  const text = response.content.find((b) => b.type === "text");
  return text?.text ?? "";
}

/** JSON completion constrained by a JSON schema (structured outputs). */
export async function completeJson<T>(opts: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T> {
  // `output_config` postdates the installed SDK typings; it passes through on the wire.
  const params = {
    model: MODEL,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    output_config: { format: { type: "json_schema", schema: opts.schema } },
    messages: [{ role: "user", content: opts.prompt }],
  } as unknown as Anthropic.MessageCreateParamsNonStreaming;
  const response = await client().messages.create(params);
  if (response.stop_reason === "refusal") {
    throw new AiRefusalError(refusalCategory(response));
  }
  const text = response.content.find((b) => b.type === "text");
  if (!text) throw new Error("Empty model response");
  return JSON.parse(text.text) as T;
}

export const CLINICAL_SYSTEM = `You are the clinical language engine inside Meridian, a clinical intelligence platform used by licensed physicians in hospitals. Your output is always reviewed by a clinician before any action is taken; it is decision support, never a diagnosis or an order.

Rules:
- Be precise, sober and specific. Use standard clinical terminology plus plain-language glosses.
- Never invent values, medications or history that are not present in the supplied data.
- When evidence is insufficient, say so explicitly.
- Prefer structured, scannable prose over long paragraphs.`;

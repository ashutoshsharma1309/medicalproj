import "server-only";

/**
 * AVERIS AI provider client.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Groq vs Grok — these are different companies with near-identical names, and
 * mixing them up is the single most likely configuration mistake here:
 *
 *   Groq  (groq.com) — inference provider. Keys begin `gsk_`.
 *                      Base URL https://api.groq.com/openai/v1
 *                      Serves open models: Llama, GPT-OSS, Qwen.
 *   Grok  (x.ai)     — xAI's own model family. Keys begin `xai-`.
 *                      Base URL https://api.x.ai/v1
 *
 * Both expose the same OpenAI-compatible chat-completions shape, so one client
 * serves either. The provider is inferred from the key prefix unless
 * AI_BASE_URL is set explicitly.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `server-only` guarantees a build error if this module is ever imported from
 * a Client Component, so the API key cannot leak into the browser bundle.
 */

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const XAI_BASE_URL = "https://api.x.ai/v1";

/**
 * Default model per provider.
 *
 * On Groq this is gpt-oss-120b, chosen after comparing candidates on a real
 * lab report: Llama 3.3 70B and Qwen 3.6 27B both returned a flat confidence
 * of 1.0 for every field, which would make AVERIS's low-confidence review
 * flagging decorative. gpt-oss-120b produced genuinely varied scores, so the
 * confidence a patient sees actually means something.
 */
const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";
const XAI_DEFAULT_MODEL = "grok-4";

export type AiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AiCompletionOptions = {
  messages: AiMessage[];
  maxTokens?: number;
  /** Ask the provider to guarantee syntactically valid JSON. */
  json?: boolean;
  signal?: AbortSignal;
};

export class AiNotConfiguredError extends Error {
  constructor() {
    super("No AI API key is configured. Document extraction is unavailable.");
    this.name = "AiNotConfiguredError";
  }
}

export class AiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AiRequestError";
  }
}

function apiKey(): string | undefined {
  // GROQ_API_KEY is checked first; GROK_API_KEY is accepted as an alias so an
  // existing xAI configuration keeps working.
  return process.env.GROQ_API_KEY || process.env.GROK_API_KEY;
}

export function isAiConfigured(): boolean {
  return Boolean(apiKey());
}

export function resolveProvider(): {
  baseUrl: string;
  model: string;
  provider: "groq" | "xai";
} {
  const key = apiKey() ?? "";
  const isGroq = key.startsWith("gsk_");

  const baseUrl =
    process.env.AI_BASE_URL ||
    process.env.GROK_BASE_URL ||
    (isGroq ? GROQ_BASE_URL : XAI_BASE_URL);

  const model =
    process.env.AI_MODEL ||
    process.env.GROK_MODEL ||
    (isGroq ? GROQ_DEFAULT_MODEL : XAI_DEFAULT_MODEL);

  return { baseUrl, model, provider: isGroq ? "groq" : "xai" };
}

/** Single chat completion. Returns the assistant's text content. */
export async function aiComplete(options: AiCompletionOptions): Promise<string> {
  const key = apiKey();
  if (!key) throw new AiNotConfiguredError();

  const { baseUrl, model } = resolveProvider();

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: options.messages,
      max_tokens: options.maxTokens ?? 4096,
      // JSON mode removes an entire class of failure: the model can no longer
      // wrap its answer in prose or a markdown fence.
      ...(options.json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new AiRequestError(
      `AI request failed (${response.status}): ${detail.slice(0, 300)}`,
      response.status,
    );
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };

  return payload.choices?.[0]?.message?.content ?? "";
}

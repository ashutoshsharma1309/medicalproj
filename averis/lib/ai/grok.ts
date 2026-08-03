import "server-only";

/**
 * Grok (xAI) client — Phase 2 groundwork.
 *
 * Deliberately NOT wired to any user-facing feature. Phase 1 ships a patient
 * identity and health profile platform; presenting generated output as
 * clinical insight before the extraction and review workflow exists would be
 * dishonest to patients.
 *
 * Phase 2 consumers: medical document analysis, health-timeline construction,
 * and explainable risk signals — each behind a patient review step.
 *
 * `server-only` guarantees a build error if this module is ever imported from
 * a Client Component, so GROK_API_KEY cannot leak into the browser bundle.
 */

const DEFAULT_BASE_URL = "https://api.x.ai/v1";

export type GrokMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type GrokCompletionOptions = {
  messages: GrokMessage[];
  /** Defaults to GROK_MODEL, then "grok-4". */
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
};

export class GrokNotConfiguredError extends Error {
  constructor() {
    super("GROK_API_KEY is not configured. AI features are unavailable.");
    this.name = "GrokNotConfiguredError";
  }
}

export class GrokRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GrokRequestError";
  }
}

export function isGrokConfigured(): boolean {
  return Boolean(process.env.GROK_API_KEY);
}

/**
 * Single completion against the xAI chat-completions endpoint.
 * Returns the assistant's text content.
 */
export async function grokComplete(options: GrokCompletionOptions): Promise<string> {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) throw new GrokNotConfiguredError();

  const baseUrl = process.env.GROK_BASE_URL || DEFAULT_BASE_URL;
  const model = options.model ?? process.env.GROK_MODEL ?? "grok-4";

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: options.messages,
      max_tokens: options.maxTokens ?? 4096,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GrokRequestError(
      `Grok request failed (${response.status}): ${detail.slice(0, 300)}`,
      response.status,
    );
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };

  return payload.choices?.[0]?.message?.content ?? "";
}

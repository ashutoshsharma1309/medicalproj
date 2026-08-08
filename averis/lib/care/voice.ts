/**
 * Voice — the foundation, and only the foundation.
 *
 * Speech-to-text happens in the browser via the Web Speech API. Nothing here
 * records, uploads or stores audio, and that is a design decision rather than
 * an unfinished feature: a health platform that ships a microphone stream to a
 * server has acquired a recording of a patient's home, and no amount of
 * transcription accuracy is worth owning that. The transcript is text the user
 * can see and edit before anything is asked.
 *
 * What this module owns is the layer *after* transcription:
 *
 *     speech → transcript → normalise → route → (navigate | ask the assistant)
 *
 * Routing matters because spoken questions split into two kinds. "Show me
 * critical patients" is a *command* — the answer is a screen, and paying a
 * model to describe a list the user is about to look at is slower and worse
 * than showing it. "Why is this patient high risk" is a *question*, and goes
 * to the assistant with the same grounding as a typed one.
 *
 * Pure and browser-free, so the routing is testable without a microphone.
 */

import { classifyIntent, type Intent } from "./assistant";

export type VoiceRoute =
  | { kind: "NAVIGATE"; href: string; spoken: string }
  | { kind: "ASK"; question: string; intent: Intent }
  | { kind: "UNCLEAR"; spoken: string };

/**
 * Transcripts arrive with filler, punctuation and inconsistent case.
 *
 * "Um, show me the critical patients." and "show critical patients" are the
 * same instruction, and a router that treats them differently is one people
 * stop speaking to.
 */
export function normaliseTranscript(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,!?;:]/g, " ")
    .replace(/\b(?:um+|uh+|er+|hmm+|please|hey averis|averis)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const COMMANDS: { pattern: RegExp; href: string; spoken: string }[] = [
  {
    pattern: /\b(?:show|open|list|who are|which are).{0,20}\b(?:critical|urgent|high risk|worst)\b.{0,20}\bpatients?\b/,
    href: "/clinical",
    spoken: "Opening your caseload, most urgent first.",
  },
  {
    pattern: /\b(?:show|open|go to)\b.{0,20}\b(?:caseload|my patients|patient list|clinical)\b/,
    href: "/clinical",
    spoken: "Opening your caseload.",
  },
  {
    pattern: /\b(?:show|open|go to)\b.{0,20}\b(?:monitoring|live|vitals dashboard)\b/,
    href: "/monitoring",
    spoken: "Opening live monitoring.",
  },
  {
    pattern: /\b(?:show|open|go to)\b.{0,20}\b(?:care team|who can see)\b/,
    href: "/care-team",
    spoken: "Opening your care team.",
  },
  {
    pattern: /\b(?:show|open|go to)\b.{0,20}\b(?:devices?|my band)\b/,
    href: "/devices",
    spoken: "Opening your devices.",
  },
];

/**
 * Where a spoken utterance goes.
 *
 * Commands are checked before questions, because "show me critical patients"
 * also matches the alerts pattern — and the screen is the better answer.
 *
 * An unrecognised utterance returns UNCLEAR rather than being forwarded to the
 * assistant as a question. Speech recognition mishears, and sending a
 * misheard sentence to a model produces a fluent answer to a question nobody
 * asked, which is worse than saying "I did not catch that".
 */
export function routeVoiceCommand(raw: string): VoiceRoute {
  const text = normaliseTranscript(raw);
  if (text.length < 3) return { kind: "UNCLEAR", spoken: text };

  for (const command of COMMANDS) {
    if (command.pattern.test(text)) {
      return { kind: "NAVIGATE", href: command.href, spoken: command.spoken };
    }
  }

  const intent = classifyIntent(text);
  if (intent === "UNSUPPORTED") return { kind: "UNCLEAR", spoken: text };

  // OUT_OF_SCOPE is deliberately forwarded: the assistant's refusal is written
  // and consistent, and a user who asks a spoken question about medication
  // deserves that answer rather than "I did not catch that".
  return { kind: "ASK", question: raw.trim(), intent };
}

/**
 * What the browser should say back, when it says anything.
 *
 * Kept short on purpose. Synthesised speech reading four sentences of vital
 * signs is slower than reading them, and a patient who asked "do I have any
 * alerts" wants the first clause.
 */
export function spokenReply(answer: string): string {
  const firstSentence = answer.split(/(?<=[.!?])\s/)[0] ?? answer;
  return firstSentence.length > 220 ? `${firstSentence.slice(0, 217)}…` : firstSentence;
}

/** Examples shown under the microphone, since nobody guesses what to say. */
export const VOICE_EXAMPLES: Record<"CLINICIAN" | "PATIENT", string[]> = {
  CLINICIAN: [
    "Show critical patients",
    "Why is this patient high risk?",
    "What alerts were raised?",
  ],
  PATIENT: ["How is my health today?", "Do I have any alerts?", "Has anything changed?"],
};

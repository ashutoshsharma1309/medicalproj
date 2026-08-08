/**
 * The health assistant's reasoning, without the model.
 *
 * **This is not a chatbot with a health record bolted on.** The distinction is
 * structural, not a matter of prompt wording:
 *
 *   · the question is classified into one of a small set of things AVERIS can
 *     actually answer from monitoring data
 *   · the context handed to the model is assembled arithmetic — the same
 *     `ReportSections` the summary uses
 *   · every intent has a deterministic answer, so the assistant works with no
 *     model configured and degrades to plainer language rather than to nothing
 *   · anything asking for a diagnosis, a prescription or a prognosis is
 *     refused *before* a model sees it, because a refusal produced by asking
 *     a model nicely is a refusal that can be argued out of
 *
 * The last point is the one that matters. A generic assistant given a health
 * record will answer "should I go to hospital?" — and the honest answer from a
 * monitoring platform is that it cannot know.
 *
 * Pure. No database, no model, no clock beyond what callers pass in.
 */

import type { ReportSections } from "./report";
import { EMERGENCY_LABEL, type EmergencyType } from "./escalation";

export type Audience = "CLINICIAN" | "PATIENT" | "CAREGIVER";

export type Intent =
  /** "Why is this patient high risk?" */
  | "RISK_EXPLANATION"
  /** "How is my health today?" / "What's happening with them?" */
  | "CURRENT_STATUS"
  /** "Do I have any alerts?" */
  | "ALERTS"
  /** "Has anything changed?" / "What's the trend?" */
  | "TREND"
  /** "Is the device working?" */
  | "MONITORING_COVERAGE"
  /** Asks AVERIS to practise medicine. */
  | "OUT_OF_SCOPE"
  /** Understood as a question, but not one monitoring data can answer. */
  | "UNSUPPORTED";

/**
 * Requests AVERIS must refuse, checked first.
 *
 * Ordered before every other pattern deliberately: "why is my risk high and
 * what should I take for it" is one question containing two, and the part that
 * asks for a prescription decides how the whole thing is handled.
 */
const OUT_OF_SCOPE = [
  /\b(?:should|shall|do|must)\s+(?:i|we|they|he|she|the patient)\b[^?]*\b(?:take|start|stop|increase|decrease|go to|call|admit|be admitted)\b/i,
  /\b(?:what|which)\s+(?:medication|drug|dose|dosage|treatment|antibiotic)\b/i,
  /\b(?:diagnos(?:e|is|ed)|what(?:'s| is) wrong with|what do i have|do i have (?:covid|cancer|diabetes|pneumonia|sepsis|an infection))\b/i,
  /\b(?:prescri|treat(?:ment)? plan|how (?:do|should) (?:i|we) treat)\w*/i,
  /\b(?:am i|is (?:he|she|the patient|it)) (?:going to|gonna) (?:be (?:ok|okay|alright|fine)|die|survive)\b/i,
  /\b(?:prognosis|life expectancy|how long (?:do|have) i)\b/i,
];

const PATTERNS: { intent: Intent; pattern: RegExp }[] = [
  {
    intent: "RISK_EXPLANATION",
    pattern: /\b(?:why|what).{0,40}\b(?:risk|high risk|critical|flagged|score)\b|\brisk\b.{0,20}\b(?:why|because|reason|explain)\b|\bexplain\b.{0,20}\brisk\b/i,
  },
  { intent: "ALERTS", pattern: /\b(?:alert|alerts|emergency|emergencies|notification)s?\b/i },
  {
    intent: "TREND",
    // A bare time phrase — "last week", "over the last 24 hours" — is
    // deliberately not enough. "What did the cardiologist say last week?" is a
    // question about a consultation, and monitoring data cannot answer it; a
    // classifier that matched on the time phrase alone would send it to a model
    // with a fact sheet of heart rates and get a fluent non-answer.
    pattern: /\b(?:trend|trending|changed|change|worse|better|improving|declining|deteriorat\w*|going up|going down)\b/i,
  },
  {
    intent: "MONITORING_COVERAGE",
    pattern: /\b(?:device|band|watch|sensor|connected|offline|reporting|battery|wearing)\b/i,
  },
  {
    intent: "CURRENT_STATUS",
    pattern: /\b(?:how (?:am|is|are)|status|doing|health today|right now|current|vitals|heart rate|oxygen|spo2|temperature)\b/i,
  },
];

export function classifyIntent(question: string): Intent {
  const text = question.trim();
  if (text.length < 3) return "UNSUPPORTED";

  // First, always. See the note above OUT_OF_SCOPE.
  if (OUT_OF_SCOPE.some((pattern) => pattern.test(text))) return "OUT_OF_SCOPE";

  for (const { intent, pattern } of PATTERNS) {
    if (pattern.test(text)) return intent;
  }

  return "UNSUPPORTED";
}

export type AssistantAnswer = {
  intent: Intent;
  answer: string;
  /** The facts the answer was built from, shown under it. */
  grounds: string[];
  /** True when AVERIS declined rather than answered. */
  declined: boolean;
};

/**
 * The answer, assembled from the context.
 *
 * Used directly when no model is configured, and as the fallback when one
 * fails or drifts. Every sentence restates something in `sections`.
 */
export function deterministicAnswer(
  intent: Intent,
  sections: ReportSections,
  audience: Audience,
): AssistantAnswer {
  const subject = audience === "PATIENT" ? "You" : "This patient";
  const possessive = audience === "PATIENT" ? "Your" : "Their";

  if (intent === "OUT_OF_SCOPE") {
    return {
      intent,
      declined: true,
      grounds: [],
      answer:
        audience === "CLINICIAN"
          ? "AVERIS reports measurements and the thresholds they crossed. It does not diagnose, recommend treatment or estimate prognosis — that judgement is yours, and a monitoring platform that offered it would be claiming something it cannot know."
          : "AVERIS cannot answer that. It monitors your measurements and tells you when something crosses a threshold, but it does not diagnose, recommend treatment or predict what will happen — please ask your doctor, and call emergency services if you feel unwell now.",
    };
  }

  if (sections.readingCount === 0) {
    return {
      intent,
      declined: false,
      grounds: [],
      answer:
        audience === "PATIENT"
          ? "There are no readings from your device for this period, so AVERIS has nothing to tell you about it. That usually means the band was not worn or not connected."
          : `${subject} has no stored readings for this period, so there is nothing to report. That usually means the device was not worn or not connected.`,
    };
  }

  const grounds = groundsFrom(sections);

  switch (intent) {
    case "RISK_EXPLANATION": {
      if (!sections.risk) {
        return {
          intent,
          declined: false,
          grounds,
          answer: `AVERIS has not produced a risk assessment for ${
            audience === "PATIENT" ? "you" : "this patient"
          } in this period, so there is no score to explain.`,
        };
      }

      const reasons =
        sections.risk.reasons.length > 0
          ? ` It cited: ${sections.risk.reasons.join("; ")}.`
          : " The assessment recorded no individual contributing factors.";

      return {
        intent,
        declined: false,
        grounds,
        answer:
          `The most recent AVERIS assessment was ${Math.round(sections.risk.score * 100)}% (${sections.risk.level})` +
          `${sections.risk.confidence !== null ? `, with ${Math.round(sections.risk.confidence * 100)}% confidence` : ""}.` +
          `${reasons} The score is computed from the measurements listed below — it is a summary of the data, not a judgement about ${
            audience === "PATIENT" ? "your" : "the patient's"
          } condition.`,
      };
    }

    case "ALERTS": {
      const { critical, warning } = sections.alerts;
      const open = sections.emergencies.filter((e) =>
        ["NEW", "ACKNOWLEDGED", "IN_PROGRESS"].includes(e.status),
      );

      if (critical + warning === 0 && sections.emergencies.length === 0) {
        return {
          intent,
          declined: false,
          grounds,
          answer: `No threshold alerts and no emergency events were raised in this period.`,
        };
      }

      const parts = [
        `${critical} critical and ${warning} warning threshold alerts were raised in this period.`,
      ];
      if (sections.emergencies.length > 0) {
        parts.push(
          `${sections.emergencies.length} emergency ${
            sections.emergencies.length === 1 ? "event" : "events"
          } were raised: ${sections.emergencies
            .map((e) => EMERGENCY_LABEL[e.eventType as EmergencyType] ?? e.eventType)
            .join(", ")}.`,
        );
      }
      if (open.length > 0) {
        parts.push(
          `${open.length} ${open.length === 1 ? "is" : "are"} still open and awaiting a clinician's response.`,
        );
      }

      return { intent, declined: false, grounds, answer: parts.join(" ") };
    }

    case "TREND": {
      const moved = Object.entries(sections.vitals)
        .map(([channel, summary]) => ({ channel, drift: summary.drift }))
        .filter((entry) => Math.abs(entry.drift) > 0);

      if (moved.length === 0) {
        return {
          intent,
          declined: false,
          grounds,
          answer: `${possessive} measurements were steady across this period — AVERIS found no channel that moved enough to report a direction.`,
        };
      }

      return {
        intent,
        declined: false,
        grounds,
        answer:
          `Across this period, ${moved
            .map((entry) => `${labelOf(entry.channel)} ${entry.drift > 0 ? "rose" : "fell"}`)
            .join(", ")}. The measurements those directions come from are listed below.`,
      };
    }

    case "MONITORING_COVERAGE": {
      const gap = sections.longestGapMinutes;
      return {
        intent,
        declined: false,
        grounds,
        answer:
          gap !== null && gap >= 15
            ? `${sections.readingCount} readings were stored in this period, with a gap of up to ${gap} minutes when nothing was recorded. AVERIS cannot say anything about that gap — nothing was measured during it.`
            : `${sections.readingCount} readings were stored in this period with no significant interruption, so monitoring was continuous.`,
      };
    }

    case "CURRENT_STATUS":
      return {
        intent,
        declined: false,
        grounds,
        answer:
          `${subject} ${audience === "PATIENT" ? "have" : "has"} ${sections.readingCount} readings stored for this period. ` +
          describeVitals(sections) +
          (sections.risk
            ? ` The most recent AVERIS risk assessment was ${Math.round(sections.risk.score * 100)}% (${sections.risk.level}).`
            : "") +
          (sections.alerts.critical > 0
            ? ` ${sections.alerts.critical} critical threshold alerts were raised.`
            : ""),
      };

    default:
      return {
        intent: "UNSUPPORTED",
        declined: true,
        grounds,
        answer:
          "AVERIS can answer questions about monitoring data: current vitals, why a risk score is what it is, what alerts were raised, whether anything is trending, and whether the device is reporting. Ask about one of those, or open the chart for the full record.",
      };
  }
}

function labelOf(channel: string): string {
  return channel === "heartRate"
    ? "heart rate"
    : channel === "spo2"
      ? "blood oxygen"
      : "temperature";
}

function describeVitals(sections: ReportSections): string {
  const parts = Object.entries(sections.vitals).map(([channel, summary]) => {
    const precision = channel === "temperature" ? 1 : 0;
    const unit = channel === "heartRate" ? " BPM" : channel === "spo2" ? "%" : "°C";
    return `${labelOf(channel)} averaged ${summary.mean.toFixed(precision)}${unit} (range ${summary.min.toFixed(precision)}–${summary.max.toFixed(precision)}${unit})`;
  });

  return parts.length > 0 ? `${capitalise(parts.join(", "))}.` : "";
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The facts shown beneath an answer, so it can be checked rather than believed. */
export function groundsFrom(sections: ReportSections): string[] {
  const grounds: string[] = [];

  for (const [channel, summary] of Object.entries(sections.vitals)) {
    const precision = channel === "temperature" ? 1 : 0;
    const unit = channel === "heartRate" ? " BPM" : channel === "spo2" ? "%" : "°C";
    grounds.push(
      `${capitalise(labelOf(channel))}: ${summary.count} measurements, mean ${summary.mean.toFixed(precision)}${unit}, range ${summary.min.toFixed(precision)}–${summary.max.toFixed(precision)}${unit}`,
    );
  }

  if (sections.risk) {
    grounds.push(
      `Risk assessment ${Math.round(sections.risk.score * 100)}% (${sections.risk.level}) at ${sections.risk.assessedAt}`,
    );
  }

  if (sections.alerts.critical + sections.alerts.warning > 0) {
    grounds.push(
      `${sections.alerts.critical} critical and ${sections.alerts.warning} warning threshold alerts`,
    );
  }

  for (const event of sections.emergencies.slice(0, 3)) {
    grounds.push(`${event.createdAt}: ${event.summary}`);
  }

  return grounds;
}

/** The system prompt, which differs by who is reading. */
export function systemPromptFor(audience: Audience): string {
  const shared = `You are AVERIS, a remote patient monitoring platform. You are given measurements already computed from stored sensor data, and a question about them.

Hard rules:
- Use ONLY the facts provided. Never add a value, a direction or an event that is not in the input.
- NEVER diagnose, name a condition, recommend treatment or a test, or estimate prognosis.
- Restating a measurement and the threshold it crossed is allowed. Saying what it means is not.
- If the facts do not answer the question, say exactly that. Never fill the gap.
- 2 to 4 sentences, plain prose. No headings, no bullet points, no markdown.`;

  if (audience === "CLINICIAN") {
    return `${shared}
- Your reader is the treating clinician. Do not tell them to consult a doctor; they are the doctor. Do not hedge with reassurance — report what was measured.`;
  }

  if (audience === "CAREGIVER") {
    return `${shared}
- Your reader is a family member or carer, not a clinician. Plain language, no jargon. Do not reassure and do not alarm; say what was measured and who has been notified.`;
  }

  return `${shared}
- Your reader is the patient themselves. Address them as "you". Warm, calm, factual — no alarm and no reassurance, because neither is yours to give.
- Close by directing them to their healthcare provider for interpretation.`;
}

/** The user message: the question, and the facts it may be answered from. */
export function buildAssistantPrompt(question: string, facts: string, intent: Intent): string {
  return [
    `Question (classified as ${intent}): ${question}`,
    "",
    "Facts available. Nothing outside this list may appear in your answer:",
    facts,
  ].join("\n");
}

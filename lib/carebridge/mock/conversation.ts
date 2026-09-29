import type { ProgressField } from "../types";

/**
 * The scripted mock AI Health Interview.
 *
 * There is no real language model here yet (that's Phase 4). Instead this is
 * a fixed, ordered script: each step is one assistant message, and — for
 * most steps — the field that the patient's next reply is considered to
 * satisfy. This keeps the mock conversation structured the same way a real
 * one will be, so Phase 4 can swap the "what does the assistant say next"
 * logic for a real AI call without changing anything in `components/carebridge/*`.
 *
 * `field: null` marks a step whose reply is still recorded (e.g. temperature)
 * but doesn't check off a new row in the assessment-progress checklist —
 * mirroring how a real interview can ask a clarifying sub-question without
 * that meaning a whole new category of information was opened.
 */
export type InterviewStep = {
  assistant: string;
  field: ProgressField | null;
  quickReplies?: string[];
  placeholder?: string;
};

export const INTERVIEW_STEPS: InterviewStep[] = [
  {
    assistant:
      "Hi, I'm CareBridge. I'll ask a few short questions so I can organize what you share before your consultation. To start — what's been going on?",
    field: "symptoms",
    placeholder: "Describe what you're experiencing…",
  },
  {
    assistant: "Thanks for explaining that. How long have you been experiencing this?",
    field: "duration",
    quickReplies: ["Since today", "1–2 days", "Longer than a few days"],
    placeholder: "e.g. since yesterday",
  },
  {
    assistant: "Got it. How would you describe the overall severity?",
    field: "severity",
    quickReplies: ["Mild", "Moderate", "Severe"],
  },
  {
    assistant: "Have you measured your temperature? If so, what was it?",
    field: null,
    quickReplies: ["Haven't checked", "No fever"],
    placeholder: "e.g. 102°F",
  },
  {
    assistant: "Do you have any other medical conditions I should know about?",
    field: "medicalHistory",
    quickReplies: ["No", "Yes"],
  },
  {
    assistant: "Are you currently taking any medications?",
    field: "medications",
    quickReplies: ["No", "Yes"],
  },
  {
    assistant:
      "Last question — have you noticed any of the following: difficulty breathing, chest pain, confusion, or a stiff neck?",
    field: "warningSigns",
    quickReplies: ["None of these", "Yes, one or more"],
  },
];

export const INTERVIEW_CLOSING_MESSAGE =
  "Thank you — I've organized everything you've shared into a structured summary you can review before your consultation.";

export const INTERVIEW_GREETING_DELAY_MS = 500;
export const INTERVIEW_TYPING_DELAY_MS = 900;

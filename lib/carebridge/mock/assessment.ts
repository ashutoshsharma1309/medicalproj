import {
  PROGRESS_FIELDS,
  type AssessmentSetup,
  type ProgressField,
  type ProgressState,
  type ResultStatus,
  type ResultStatusContent,
  type SymptomFindings,
} from "../types";
import { INTERVIEW_STEPS } from "./conversation";

export const EMPTY_SETUP: AssessmentSetup = {
  age: "",
  language: "English",
  existingConditions: "",
  currentMedications: "",
};

export const LANGUAGE_OPTIONS = ["English", "Hindi", "Kannada"];

export const EMPTY_PROGRESS: ProgressState = PROGRESS_FIELDS.reduce(
  (acc, field) => ({ ...acc, [field]: false }),
  {} as ProgressState,
);

/**
 * A small keyword scan over the patient's free-text chief complaint —
 * intentionally the same "deterministic keyword matching" shape as
 * `lib/ai/extraction.ts`'s fallback parser elsewhere in this codebase, not a
 * real extraction model. Good enough to make the mock result feel connected
 * to what the patient actually typed, in Phase 2, without any AI call.
 */
const SYMPTOM_KEYWORDS = [
  "fever", "weak", "weakness", "cough", "headache", "pain", "nausea",
  "vomit", "rash", "dizzy", "dizziness", "tired", "fatigue", "chills",
  "sore throat", "congestion", "breath", "shortness of breath",
] as const;

export function deriveMockSymptoms(chiefComplaint: string): string[] {
  const text = chiefComplaint.toLowerCase();
  const found = SYMPTOM_KEYWORDS.filter((k) => text.includes(k)).map(titleCase);
  return found.length > 0 ? [...new Set(found)] : ["General symptoms as described"];
}

function titleCase(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function computeProgress(answers: Record<number, string>): ProgressState {
  const progress = { ...EMPTY_PROGRESS };
  INTERVIEW_STEPS.forEach((step, i) => {
    if (step.field && answers[i]) progress[step.field] = true;
  });
  return progress;
}

export function progressPercent(progress: ProgressState): number {
  const total = PROGRESS_FIELDS.length;
  const done = PROGRESS_FIELDS.filter((f) => progress[f]).length;
  return Math.round((done / total) * 100);
}

/**
 * Deliberately simple, deterministic mock triage — a small preview of the
 * real Safety Engine's shape (Phase 5): a reported warning sign always wins,
 * regardless of anything else. This is NOT a medical classification; it only
 * exists to make the three result states reachable through the mock chat.
 */
export function computeMockStatus(answers: Record<number, string>): ResultStatus {
  const severityIdx = INTERVIEW_STEPS.findIndex((s) => s.field === "severity");
  const warningIdx = INTERVIEW_STEPS.findIndex((s) => s.field === "warningSigns");
  const severity = (answers[severityIdx] ?? "").toLowerCase();
  const warning = (answers[warningIdx] ?? "").toLowerCase();

  if (warning.includes("yes")) return "urgent";
  if (severity.includes("severe") || severity.includes("moderate")) return "consult_soon";
  return "routine";
}

export function computeMockFindings(answers: Record<number, string>): SymptomFindings {
  const idx = (field: ProgressField | null) => INTERVIEW_STEPS.findIndex((s) => s.field === field);
  const temperatureIdx = 3; // the dedicated temperature step (field: null)

  return {
    symptoms: deriveMockSymptoms(answers[idx("symptoms")] ?? ""),
    duration: answers[idx("duration")] ?? "Not yet reported",
    severity: answers[idx("severity")] ?? "Not yet reported",
    temperature: answers[temperatureIdx] ?? null,
    warningSigns: answers[idx("warningSigns")] ?? "None reported",
    relevantHistory: answers[idx("medicalHistory")] ?? "None reported",
    currentMedications: answers[idx("medications")] ?? "None reported",
  };
}

export const RESULT_STATUS_CONTENT: Record<ResultStatus, ResultStatusContent> = {
  routine: {
    status: "routine",
    label: "Routine",
    description: "Nothing you've described points to an immediate concern.",
    guidance:
      "Based on the information provided, your symptoms appear routine. Continue to monitor how you feel, and mention this to a healthcare professional at your next convenient opportunity.",
  },
  consult_soon: {
    status: "consult_soon",
    label: "Consult Soon",
    description: "It would be worth discussing this with a healthcare professional soon.",
    guidance:
      "Based on the information provided, consider discussing these symptoms with a healthcare professional in the next day or so. Seek urgent care if symptoms worsen or new warning signs develop.",
  },
  urgent: {
    status: "urgent",
    label: "Urgent Attention",
    description: "What you've described includes a warning sign that needs prompt attention.",
    guidance:
      "Based on the information provided, please seek prompt medical attention — for example, an urgent care clinic or emergency department — rather than waiting for a routine appointment.",
  },
};

/** Used when a page needs a fully-formed example without any interview having run yet (e.g. component previews). */
export const SAMPLE_FINDINGS: SymptomFindings = {
  symptoms: ["Fever", "Weakness"],
  duration: "1 day",
  severity: "Moderate",
  temperature: "102°F",
  warningSigns: "None reported",
  relevantHistory: "None reported",
  currentMedications: "None reported",
};

/**
 * Shared CareBridge types.
 *
 * These describe the shape of data the UI needs, independent of where that
 * data comes from. In Phase 2 every value conforming to these types is
 * produced locally by `lib/carebridge/mock/*`. Phase 3 replaces the mock
 * data source with real API responses shaped the same way — the
 * components in `components/carebridge/*` never need to change.
 */

export type ChatRole = "assistant" | "patient";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  at: string; // ISO timestamp
};

/** The fields the health interview is trying to fill in, in display order. */
export const PROGRESS_FIELDS = [
  "symptoms",
  "duration",
  "severity",
  "medicalHistory",
  "medications",
  "warningSigns",
] as const;

export type ProgressField = (typeof PROGRESS_FIELDS)[number];

export const PROGRESS_FIELD_LABELS: Record<ProgressField, string> = {
  symptoms: "Symptoms",
  duration: "Duration",
  severity: "Severity",
  medicalHistory: "Medical history",
  medications: "Current medication",
  warningSigns: "Warning signs",
};

export type ProgressState = Record<ProgressField, boolean>;

/** Patient-entered basics from the assessment setup step. */
export type AssessmentSetup = {
  age: string;
  language: string;
  existingConditions: string;
  currentMedications: string;
};

/** The three urgency outcomes the (future, deterministic) Safety Engine can reach. */
export type ResultStatus = "routine" | "consult_soon" | "urgent";

export type ResultStatusContent = {
  status: ResultStatus;
  label: string;
  description: string;
  guidance: string;
};

/** The structured facts collected during the interview, shown on the result page. */
export type SymptomFindings = {
  symptoms: string[];
  duration: string;
  severity: string;
  temperature: string | null;
  warningSigns: string;
  relevantHistory: string;
  currentMedications: string;
};

/** Everything needed to render the doctor-ready pre-consultation summary. */
export type DoctorSummary = {
  patientAge: string;
  language: string;
  primaryConcern: string;
  symptoms: string[];
  duration: string;
  severity: string;
  reportedTemperature: string | null;
  relevantHistory: string;
  currentMedications: string;
  warningSigns: string;
  status: ResultStatus;
  generatedAt: string; // ISO timestamp
};

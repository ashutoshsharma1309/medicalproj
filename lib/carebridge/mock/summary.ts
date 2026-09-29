import type { AssessmentSetup, DoctorSummary, ResultStatus, SymptomFindings } from "../types";
import { RESULT_STATUS_CONTENT } from "./assessment";

export function buildDoctorSummary(
  setup: AssessmentSetup,
  findings: SymptomFindings,
  status: ResultStatus,
): DoctorSummary {
  return {
    patientAge: setup.age || "Not reported",
    language: setup.language || "English",
    primaryConcern: findings.symptoms.join(" and "),
    symptoms: findings.symptoms,
    duration: findings.duration,
    severity: findings.severity,
    reportedTemperature: findings.temperature,
    relevantHistory: setup.existingConditions || findings.relevantHistory,
    currentMedications: setup.currentMedications || findings.currentMedications,
    warningSigns: findings.warningSigns,
    status,
    generatedAt: new Date().toISOString(),
  };
}

/** Plain-text rendering shared by the "Copy Summary" and "Download Summary" actions. */
export function formatSummaryAsText(summary: DoctorSummary): string {
  const lines = [
    "CAREBRIDGE — PRE-CONSULTATION SUMMARY",
    `Generated: ${new Date(summary.generatedAt).toLocaleString()}`,
    "",
    "PATIENT",
    `  Age: ${summary.patientAge}`,
    `  Preferred language: ${summary.language}`,
    "",
    "PRIMARY CONCERN",
    `  ${summary.primaryConcern || "Not reported"}`,
    "",
    "SYMPTOMS",
    `  ${summary.symptoms.join(", ") || "Not reported"}`,
    "",
    "DURATION",
    `  ${summary.duration}`,
    "",
    "SEVERITY",
    `  ${summary.severity}`,
    "",
    "REPORTED TEMPERATURE",
    `  ${summary.reportedTemperature ?? "Not reported"}`,
    "",
    "RELEVANT HISTORY",
    `  ${summary.relevantHistory || "None reported"}`,
    "",
    "CURRENT MEDICATIONS",
    `  ${summary.currentMedications || "None reported"}`,
    "",
    "REPORTED WARNING SIGNS",
    `  ${summary.warningSigns || "None reported"}`,
    "",
    "CARE GUIDANCE",
    `  [${RESULT_STATUS_CONTENT[summary.status].label}] ${RESULT_STATUS_CONTENT[summary.status].guidance}`,
    "",
    "This summary was prepared with CareBridge, an AI-powered pre-consultation",
    "assistant. It provides informational support and does not replace",
    "professional medical advice, diagnosis, or treatment.",
  ];
  return lines.join("\n");
}

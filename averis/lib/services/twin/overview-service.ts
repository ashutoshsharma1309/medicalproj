import type {
  ConfirmedRecordRow,
  DocumentRow,
  HealthOverviewScore,
  MedicationRecord,
  ProfileSnapshot,
} from "./types";

/**
 * Health overview score.
 *
 * ⚠ This is NOT a medical score and must never be presented as one. It measures
 * how complete and current the patient's *record* is — the same patient with
 * the same health would score differently depending only on how much they have
 * uploaded.
 *
 * Every figure is paired with a plain-language explanation so no number is ever
 * shown to a patient uninterpreted.
 */

const MONITORING_FRESH_DAYS = 180;

export function computeHealthOverview(input: {
  profile: ProfileSnapshot;
  records: ConfirmedRecordRow[];
  documents: DocumentRow[];
  medications: MedicationRecord[];
  now?: Date;
}): HealthOverviewScore {
  const now = input.now ?? new Date();

  return {
    recordCompleteness: scoreCompleteness(input.profile, input.documents),
    medicationTracking: scoreMedication(input.medications, input.profile),
    recentMonitoring: scoreMonitoring(input.documents, now),
    explanations: {
      recordCompleteness: explainCompleteness(input.profile, input.documents),
      medicationTracking: explainMedication(input.medications, input.profile),
      recentMonitoring: explainMonitoring(input.documents, now),
    },
  };
}

/* --------------------------------------------------------- completeness */

/** Each element of a usable profile contributes equally. */
function completenessChecks(profile: ProfileSnapshot, documents: DocumentRow[]) {
  return [
    { label: "name", ok: Boolean(profile.fullName) },
    { label: "date of birth", ok: Boolean(profile.dateOfBirth) },
    { label: "gender", ok: Boolean(profile.gender) },
    { label: "blood group", ok: Boolean(profile.bloodGroup && profile.bloodGroup !== "UNKNOWN") },
    { label: "emergency contact", ok: Boolean(profile.emergencyContact) },
    { label: "conditions", ok: profile.conditions.length > 0 },
    { label: "allergies", ok: profile.allergies.length > 0 },
    { label: "an uploaded document", ok: documents.length > 0 },
  ];
}

function scoreCompleteness(profile: ProfileSnapshot, documents: DocumentRow[]): number {
  const checks = completenessChecks(profile, documents);
  const met = checks.filter((c) => c.ok).length;
  return Math.round((met / checks.length) * 100);
}

function explainCompleteness(profile: ProfileSnapshot, documents: DocumentRow[]): string {
  const missing = completenessChecks(profile, documents)
    .filter((c) => !c.ok)
    .map((c) => c.label);

  if (missing.length === 0) return "Every part of your profile is filled in.";
  return `Still missing: ${missing.join(", ")}.`;
}

/* ---------------------------------------------------------- medication */

function scoreMedication(
  medications: MedicationRecord[],
  profile: ProfileSnapshot,
): number {
  const current = medications.filter((m) => m.endDate === null);

  // Nothing to track is not a failure — a patient on no medication with none
  // listed has a complete picture.
  if (current.length === 0 && profile.medications.length === 0) return 100;
  if (current.length === 0) return 40;

  const withDosage = current.filter((m) => m.dosage).length;
  const withSource = current.filter((m) => m.sourceDocumentId).length;

  // Half for dosage detail, half for document backing.
  return Math.round(((withDosage / current.length) * 0.5 + (withSource / current.length) * 0.5) * 100);
}

function explainMedication(
  medications: MedicationRecord[],
  profile: ProfileSnapshot,
): string {
  const current = medications.filter((m) => m.endDate === null);

  if (current.length === 0 && profile.medications.length === 0) {
    return "No medications recorded, and none listed on your profile.";
  }
  if (current.length === 0) {
    return "Your profile lists medications, but none are backed by an uploaded document yet.";
  }

  const missingDosage = current.filter((m) => !m.dosage).length;
  if (missingDosage > 0) {
    return `${current.length} current medication${current.length > 1 ? "s" : ""} tracked; ${missingDosage} without a recorded dose.`;
  }
  return `${current.length} current medication${current.length > 1 ? "s" : ""} tracked with doses and source documents.`;
}

/* ---------------------------------------------------------- monitoring */

function daysSinceLatest(documents: DocumentRow[], now: Date): number | null {
  if (documents.length === 0) return null;
  const latest = documents.map((d) => d.uploaded_at).sort().reverse()[0];
  return Math.floor((now.getTime() - new Date(latest).getTime()) / 86_400_000);
}

function scoreMonitoring(documents: DocumentRow[], now: Date): number {
  const days = daysSinceLatest(documents, now);
  if (days === null) return 0;
  if (days <= MONITORING_FRESH_DAYS) return 100;

  // Decays over the following 18 months rather than falling off a cliff.
  const decayed = 100 - ((days - MONITORING_FRESH_DAYS) / 540) * 100;
  return Math.max(10, Math.round(decayed));
}

function explainMonitoring(documents: DocumentRow[], now: Date): string {
  const days = daysSinceLatest(documents, now);
  if (days === null) return "No documents added yet.";
  if (days <= 30) return "Your most recent document was added within the last month.";
  if (days <= MONITORING_FRESH_DAYS) {
    return `Your most recent document was added about ${Math.floor(days / 30)} months ago.`;
  }
  return `It has been about ${Math.floor(days / 30)} months since your last document.`;
}

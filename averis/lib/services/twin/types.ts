/**
 * Patient Digital Twin — domain types.
 *
 * The twin is assembled from data the patient has already confirmed. It adds
 * structure and chronology; it never adds clinical claims.
 */

export type HealthEventType =
  | "DIAGNOSIS"
  | "MEDICATION_STARTED"
  | "MEDICATION_CHANGED"
  | "MEDICATION_STOPPED"
  | "LAB_RESULT"
  | "DOCUMENT_ADDED"
  | "ALLERGY_RECORDED"
  | "OTHER";

export type ConditionStatus = "ACTIVE" | "RESOLVED" | "UNCONFIRMED";
export type ConditionSeverity = "UNKNOWN" | "MILD" | "MODERATE" | "SIGNIFICANT";
export type InsightType = "TREND" | "PATTERN" | "COMPLETENESS" | "REMINDER";
export type ImportanceLevel = "LOW" | "MEDIUM" | "HIGH";

export type TimelineEvent = {
  eventType: HealthEventType;
  eventTitle: string;
  description: string | null;
  eventDate: string; // ISO date
  sourceDocumentId: string | null;
};

export type TrackedCondition = {
  conditionName: string;
  firstDetected: string | null;
  severity: ConditionSeverity;
  currentStatus: ConditionStatus;
  confidenceScore: number | null;
};

export type MedicationRecord = {
  medicineName: string;
  dosage: string | null;
  frequency: string | null;
  startDate: string | null;
  endDate: string | null;
  sourceDocumentId: string | null;
};

/** A single piece of evidence backing an insight. */
export type InsightEvidence = {
  label: string;
  value?: string;
  date?: string | null;
  documentId?: string | null;
};

export type HealthInsight = {
  insightType: InsightType;
  insightText: string;
  importanceLevel: ImportanceLevel;
  /** Every insight must be able to answer "where did this come from?". */
  evidence: InsightEvidence[];
  confidenceScore: number | null;
};

/**
 * The non-diagnostic overview. Measures how complete and current the patient's
 * *record* is — explicitly not their health.
 */
export type HealthOverviewScore = {
  recordCompleteness: number;   // 0–100
  medicationTracking: number;   // 0–100
  recentMonitoring: number;     // 0–100
  /** Plain-language reason for each figure, so no number is unexplained. */
  explanations: {
    recordCompleteness: string;
    medicationTracking: string;
    recentMonitoring: string;
  };
};

/* --------------------------------------------------- Inputs to the engines */

/** A confirmed clinical fact, as stored in patient_medical_records. */
export type ConfirmedRecordRow = {
  id: string;
  record_type: "CONDITION" | "MEDICATION" | "ALLERGY" | "LAB_RESULT";
  condition: string | null;
  medication: string | null;
  allergy: string | null;
  test_name: string | null;
  test_value: string | null;
  test_unit: string | null;
  reference_range: string | null;
  record_date: string | null;
  confidence_score: number | null;
  source_document_id: string | null;
  created_at: string;
};

export type DocumentRow = {
  id: string;
  file_name: string;
  document_type: string;
  upload_status: string;
  uploaded_at: string;
};

export type ProfileSnapshot = {
  fullName: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  bloodGroup: string | null;
  allergies: string[];
  conditions: string[];
  medications: string[];
  emergencyContact: string | null;
};

/** Everything the twin knows, assembled in one place. */
export type DigitalTwin = {
  profile: ProfileSnapshot;
  age: number | null;
  conditions: TrackedCondition[];
  medications: MedicationRecord[];
  timeline: TimelineEvent[];
  insights: HealthInsight[];
  overview: HealthOverviewScore;
  documentCount: number;
  lastDocumentAt: string | null;
};

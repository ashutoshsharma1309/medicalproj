import type { DocumentType, UploadStatus } from "@/lib/supabase/database.types";

export const DOCUMENT_CATEGORIES: {
  value: DocumentType;
  label: string;
  hint: string;
}[] = [
  { value: "BLOOD_REPORT", label: "Blood report", hint: "Blood counts, panels, biochemistry" },
  { value: "LAB_RESULT", label: "Lab result", hint: "Any other laboratory test result" },
  { value: "HEALTH_CHECKUP", label: "Health checkup", hint: "Annual or preventive checkup report" },
  { value: "PRESCRIPTION", label: "Prescription", hint: "Medicines prescribed by a doctor" },
  { value: "DISCHARGE_SUMMARY", label: "Discharge summary", hint: "Issued when leaving hospital" },
  { value: "DIAGNOSIS_REPORT", label: "Diagnosis report", hint: "Imaging, pathology or specialist findings" },
  { value: "CONSULTATION_NOTE", label: "Consultation note", hint: "Notes from an appointment" },
  { value: "OTHER", label: "Something else", hint: "Anything that doesn't fit above" },
];

export function documentTypeLabel(value: DocumentType | string): string {
  return (
    DOCUMENT_CATEGORIES.find((c) => c.value === value)?.label ??
    String(value).toLowerCase().replace(/_/g, " ")
  );
}

export const STATUS_PRESENTATION: Record<
  UploadStatus,
  { label: string; tone: "default" | "brand" | "critical" | "positive" | "notice"; hint: string }
> = {
  PENDING: { label: "Queued", tone: "default", hint: "Waiting to be read." },
  PROCESSING: { label: "Reading", tone: "brand", hint: "AVERIS is reading this document." },
  PENDING_REVIEW: {
    label: "Needs your review",
    tone: "notice",
    hint: "AVERIS found information. Confirm what is correct.",
  },
  COMPLETED: { label: "Added to profile", tone: "positive", hint: "You reviewed this document." },
  FAILED: { label: "Couldn't be read", tone: "critical", hint: "Try a clearer copy." },
};

/** Confidence presentation is shared by the review screen and the viewer. */
export function confidenceTone(score: number): "positive" | "notice" | "critical" {
  if (score >= 0.85) return "positive";
  if (score >= 0.7) return "notice";
  return "critical";
}

export function confidencePercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

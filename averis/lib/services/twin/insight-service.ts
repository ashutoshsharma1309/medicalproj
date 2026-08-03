import type {
  ConfirmedRecordRow,
  DocumentRow,
  HealthInsight,
  MedicationRecord,
  TrackedCondition,
} from "./types";

/**
 * Insight engine.
 *
 * Deliberately deterministic. "Your HbA1c has increased across your last three
 * reports" is arithmetic over values the patient already confirmed — it is a
 * fact about their record, and a fact should not be delegated to a language
 * model that might hallucinate a direction or a number.
 *
 * The AI layer (health-summary-service) phrases things; this decides them.
 * That split is what makes every insight explainable and testable offline.
 *
 * Insights describe the *record*. None of them interpret clinical meaning.
 */

/** A trend needs at least this many comparable measurements. */
const MIN_POINTS_FOR_TREND = 2;

/** Relative change below this is treated as flat rather than a direction. */
const MATERIAL_CHANGE = 0.05; // 5%

export function generateInsights(input: {
  records: ConfirmedRecordRow[];
  documents: DocumentRow[];
  conditions: TrackedCondition[];
  medications: MedicationRecord[];
  now?: Date;
}): HealthInsight[] {
  const now = input.now ?? new Date();
  return [
    ...detectLabTrends(input.records),
    ...detectMedicationPatterns(input.medications, input.conditions),
    ...detectCompletenessGaps(input.records, input.conditions),
    ...detectMonitoringGaps(input.documents, now),
  ].sort((a, b) => importanceRank(b) - importanceRank(a));
}

/* ------------------------------------------------------------ lab trends */

type LabPoint = { value: number; date: string; unit: string | null; documentId: string | null };

/** Groups lab results by test name and reports a direction where one exists. */
export function detectLabTrends(records: ConfirmedRecordRow[]): HealthInsight[] {
  const byTest = new Map<string, LabPoint[]>();

  for (const record of records) {
    if (record.record_type !== "LAB_RESULT" || !record.test_name || !record.test_value) continue;

    const value = parseNumeric(record.test_value);
    if (value === null) continue; // non-numeric results cannot trend

    const key = record.test_name.trim().toLowerCase();
    const points = byTest.get(key) ?? [];
    points.push({
      value,
      date: record.record_date ?? record.created_at.slice(0, 10),
      unit: record.test_unit,
      documentId: record.source_document_id,
    });
    byTest.set(key, points);
  }

  const insights: HealthInsight[] = [];

  for (const [key, rawPoints] of byTest) {
    const points = [...rawPoints].sort((a, b) => a.date.localeCompare(b.date));
    if (points.length < MIN_POINTS_FOR_TREND) continue;

    const first = points[0];
    const last = points[points.length - 1];
    const testName = displayName(records, key);

    // Same-day duplicates are not a trend.
    if (first.date === last.date) continue;

    const delta = last.value - first.value;
    const relative = first.value === 0 ? 0 : Math.abs(delta) / Math.abs(first.value);

    let direction: "increased" | "decreased" | "stayed broadly stable";
    if (relative < MATERIAL_CHANGE) direction = "stayed broadly stable";
    else direction = delta > 0 ? "increased" : "decreased";

    const unit = last.unit ?? "";
    const text =
      direction === "stayed broadly stable"
        ? `Your ${testName} readings have ${direction} across ${points.length} reports (${first.value}${unit} → ${last.value}${unit}).`
        : `Your ${testName} values have ${direction} across ${points.length} reports, from ${first.value}${unit} to ${last.value}${unit}.`;

    insights.push({
      insightType: "TREND",
      insightText: text,
      // A movement is worth surfacing; stability is reassuring but less urgent.
      importanceLevel: direction === "stayed broadly stable" ? "LOW" : "MEDIUM",
      evidence: points.map((p) => ({
        label: testName,
        value: `${p.value}${p.unit ?? ""}`,
        date: p.date,
        documentId: p.documentId,
      })),
      // Confidence here is about the reading of the trend, not its meaning:
      // more points over a longer span is a firmer observation.
      confidenceScore: Math.min(1, 0.6 + 0.15 * (points.length - 1)),
    });
  }

  return insights;
}

/* --------------------------------------------------- medication patterns */

export function detectMedicationPatterns(
  medications: MedicationRecord[],
  conditions: TrackedCondition[],
): HealthInsight[] {
  const insights: HealthInsight[] = [];
  const current = medications.filter((m) => m.endDate === null);

  if (current.length > 0) {
    insights.push({
      insightType: "PATTERN",
      insightText:
        current.length === 1
          ? `Your records show one current medication: ${current[0].medicineName}.`
          : `Your records show ${current.length} current medications: ${current
              .map((m) => m.medicineName)
              .join(", ")}.`,
      importanceLevel: "LOW",
      evidence: current.map((m) => ({
        label: m.medicineName,
        value: [m.dosage, m.frequency].filter(Boolean).join(" · ") || undefined,
        date: m.startDate,
        documentId: m.sourceDocumentId,
      })),
      confidenceScore: 0.9,
    });
  }

  // A drug that appears more than once has a documented continuation history.
  const byName = new Map<string, MedicationRecord[]>();
  for (const m of medications) {
    const key = m.medicineName.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), m]);
  }
  for (const [, entries] of byName) {
    if (entries.length < 2) continue;
    const name = entries[0].medicineName;
    insights.push({
      insightType: "PATTERN",
      insightText: `${name} appears in ${entries.length} of your documents, so your record shows continuity of this medication.`,
      importanceLevel: "LOW",
      evidence: entries.map((e) => ({
        label: name,
        date: e.startDate,
        documentId: e.sourceDocumentId,
      })),
      confidenceScore: 0.85,
    });
  }

  if (conditions.length > 0 && current.length === 0) {
    insights.push({
      insightType: "COMPLETENESS",
      // Phrased carefully: "you have <condition>" reads as a diagnosis, and
      // "prescription" reads as an instruction. Neither is ours to say.
      insightText: `Your record lists ${conditions.length} condition${
        conditions.length > 1 ? "s" : ""
      } but no current medication. Adding a recent medication document would make your record more complete.`,
      importanceLevel: "MEDIUM",
      evidence: conditions.map((c) => ({ label: c.conditionName, date: c.firstDetected })),
      confidenceScore: 0.8,
    });
  }

  return insights;
}

/* ------------------------------------------------------ completeness gaps */

export function detectCompletenessGaps(
  records: ConfirmedRecordRow[],
  conditions: TrackedCondition[],
): HealthInsight[] {
  const insights: HealthInsight[] = [];

  const hasLabs = records.some((r) => r.record_type === "LAB_RESULT");
  if (conditions.length > 0 && !hasLabs) {
    insights.push({
      insightType: "COMPLETENESS",
      insightText:
        "Your record has conditions but no test results yet. Uploading a recent lab report would let AVERIS track how your measurements change over time.",
      importanceLevel: "MEDIUM",
      evidence: conditions.map((c) => ({ label: c.conditionName, date: c.firstDetected })),
      confidenceScore: 0.85,
    });
  }

  const undated = records.filter((r) => !r.record_date).length;
  if (undated > 0 && records.length > 0) {
    insights.push({
      insightType: "COMPLETENESS",
      insightText: `${undated} of your ${records.length} confirmed records have no date on the source document, so they sit on your timeline at the date they were added.`,
      importanceLevel: "LOW",
      evidence: [{ label: "Undated records", value: String(undated) }],
      confidenceScore: 1,
    });
  }

  return insights;
}

/* --------------------------------------------------------- monitoring gap */

export function detectMonitoringGaps(documents: DocumentRow[], now: Date): HealthInsight[] {
  if (documents.length === 0) return [];

  const latest = documents
    .map((d) => d.uploaded_at)
    .sort()
    .reverse()[0];

  const days = Math.floor((now.getTime() - new Date(latest).getTime()) / 86_400_000);
  if (days < 180) return [];

  return [
    {
      insightType: "REMINDER",
      insightText: `It has been about ${Math.floor(
        days / 30,
      )} months since you last added a document. Adding a recent one keeps your health record current.`,
      importanceLevel: days > 365 ? "MEDIUM" : "LOW",
      evidence: [{ label: "Last document added", date: latest.slice(0, 10) }],
      confidenceScore: 1,
    },
  ];
}

/* ----------------------------------------------------------------- utils */

function parseNumeric(value: string): number | null {
  // Tolerates "8.2", "8.2 %", "<0.01", "168 mg/dL" — but not "positive".
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function displayName(records: ConfirmedRecordRow[], key: string): string {
  const found = records.find(
    (r) => r.test_name && r.test_name.trim().toLowerCase() === key,
  );
  return found?.test_name?.trim() ?? key;
}

function importanceRank(insight: HealthInsight): number {
  return { HIGH: 3, MEDIUM: 2, LOW: 1 }[insight.importanceLevel];
}

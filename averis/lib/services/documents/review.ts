import {
  REVIEW_THRESHOLD,
  type MedicalExtraction,
  type ReviewItem,
} from "./types";

/**
 * Turns an extraction into the flat list the verification screen renders.
 *
 * Pure and dependency-free so the confidence/ordering rules that gate what
 * reaches a patient's health profile can be unit-tested without a database,
 * a model, or a network.
 */
export function buildReviewItems(extraction: MedicalExtraction): ReviewItem[] {
  const items: ReviewItem[] = [];

  extraction.conditions.forEach((c, i) => {
    items.push({
      id: `condition:${i}`,
      kind: "CONDITION",
      label: c.value,
      confidence: c.confidence,
      needsAttention: c.confidence < REVIEW_THRESHOLD,
      detail: { condition: c.value },
    });
  });

  extraction.medications.forEach((m, i) => {
    const parts = [m.name, m.dosage].filter(Boolean).join(" ");
    const label = m.frequency ? `${parts} — ${m.frequency}` : parts;
    items.push({
      id: `medication:${i}`,
      kind: "MEDICATION",
      label,
      confidence: m.confidence,
      needsAttention: m.confidence < REVIEW_THRESHOLD,
      detail: { medication: label },
    });
  });

  extraction.allergies.forEach((a, i) => {
    items.push({
      id: `allergy:${i}`,
      kind: "ALLERGY",
      label: a.value,
      confidence: a.confidence,
      needsAttention: a.confidence < REVIEW_THRESHOLD,
      detail: { allergy: a.value },
    });
  });

  extraction.lab_results.forEach((r, i) => {
    const measured = [r.value, r.unit].filter(Boolean).join(" ");
    items.push({
      id: `lab:${i}`,
      kind: "LAB_RESULT",
      label: `${r.test}: ${measured}`,
      confidence: r.confidence,
      needsAttention: r.confidence < REVIEW_THRESHOLD,
      detail: {
        test_name: r.test,
        test_value: r.value,
        test_unit: r.unit,
        reference_range: r.reference_range,
      },
    });
  });

  // Lowest confidence first: the items most likely to be wrong are the ones
  // the patient should look at hardest.
  return items.sort((a, b) => a.confidence - b.confidence);
}

/**
 * Overall document confidence — the mean of every field-level score.
 *
 * Deliberately not the max: one crisply-read line should not make a poor scan
 * look trustworthy. Returns null when the document yielded nothing scored.
 */
export function overallConfidence(extraction: MedicalExtraction): number | null {
  const scores: number[] = [];

  for (const field of [
    extraction.patient_name,
    extraction.age,
    extraction.gender,
    extraction.blood_group,
    extraction.doctor_name,
    extraction.hospital_name,
    extraction.document_date,
  ]) {
    if (field) scores.push(field.confidence);
  }

  for (const list of [extraction.conditions, extraction.symptoms, extraction.allergies]) {
    for (const item of list) scores.push(item.confidence);
  }
  for (const m of extraction.medications) scores.push(m.confidence);
  for (const r of extraction.lab_results) scores.push(r.confidence);

  if (scores.length === 0) return null;
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  return Math.round(mean * 1000) / 1000;
}

/** Count of items the patient should look at closely. */
export function attentionCount(items: ReviewItem[]): number {
  return items.filter((i) => i.needsAttention).length;
}

/**
 * Guardrail on patient-facing prose.
 *
 * AVERIS must never present a diagnosis. If the model drifts into diagnostic
 * phrasing despite the system prompt, the sentence is replaced rather than
 * shown. Belt and braces: the prompt asks, this enforces.
 */
const DIAGNOSTIC_PHRASES = [
  /\byou (?:have|are suffering from|are diagnosed with)\b/i,
  /\bthis (?:confirms|indicates that you have|means you have)\b/i,
  /\bdiagnos(?:is|ed|tic) (?:is|of)\b/i,
  /\byou should (?:take|start|stop|increase|decrease)\b/i,
  /\bprescrib\w*\b/i,
];

const REFERRAL_LINE =
  "Discuss these results with your healthcare provider — AVERIS organizes your information and does not provide medical advice.";

export function enforceNoDiagnosis(summary: string): {
  summary: string;
  rewritten: boolean;
} {
  const offending = DIAGNOSTIC_PHRASES.some((pattern) => pattern.test(summary));
  if (offending) {
    return {
      summary:
        "This document has been organized into your AVERIS record. " + REFERRAL_LINE,
      rewritten: true,
    };
  }

  const alreadyRefers = /healthcare provider|your doctor|your clinician/i.test(summary);
  return {
    summary: alreadyRefers ? summary : `${summary} ${REFERRAL_LINE}`.trim(),
    rewritten: false,
  };
}

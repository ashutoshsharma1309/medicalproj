/**
 * AVERIS Phase 2 — document intelligence pipeline tests.
 *
 * Runs on Node's built-in test runner, no framework:
 *   npm run test
 *
 * Grok is injected as a stub, so the whole extraction → review → reconciliation
 * path is exercised deterministically, offline, and in milliseconds. The rule
 * that matters most — nothing reaches a health profile without an explicit
 * confirmation — is asserted directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { medicalExtraction, REVIEW_THRESHOLD, type MedicalExtraction } from "../types";
import { buildReviewItems, overallConfidence, enforceNoDiagnosis } from "../review";
import { buildReconciliationPlan, mergeList } from "../reconciliation";
import { extractMedicalData, parseJsonPayload } from "../grok-service";
import { validateUpload, buildStoragePath, contentMatchesMimeType } from "../storage-validation";

/* ------------------------------------------------------------- fixtures */

const GROK_RESPONSE = {
  patient_name: { value: "Rahul Sharma", confidence: 0.97 },
  age: { value: 45, confidence: 0.95 },
  gender: { value: "MALE", confidence: 0.93 },
  blood_group: { value: "B+", confidence: 0.96 },
  conditions: [
    { value: "Type 2 Diabetes", confidence: 0.94 },
    { value: "Hypertension", confidence: 0.88 },
    { value: "Possible thyroid issue", confidence: 0.41 }, // low — needs attention
  ],
  symptoms: [{ value: "Fatigue", confidence: 0.72 }],
  allergies: [{ value: "Sulfa", confidence: 0.91 }],
  medications: [
    { name: "Metformin", dosage: "500mg", frequency: "twice daily", confidence: 0.96 },
    { name: "Telmisartan", dosage: "40mg", frequency: null, confidence: 0.62 }, // low
  ],
  lab_results: [
    {
      test: "HbA1c",
      value: "8.2",
      unit: "%",
      reference_range: "4.0-5.6",
      flag: "HIGH",
      confidence: 0.98,
    },
  ],
  doctor_name: { value: "Dr. Mehta", confidence: 0.89 },
  hospital_name: { value: "City Diagnostics", confidence: 0.85 },
  document_date: { value: "2026-06-12", confidence: 0.9 },
  summary: "This blood report records an HbA1c of 8.2% and lists two ongoing conditions.",
  key_findings: ["HbA1c recorded at 8.2%"],
};

function parseFixture(): MedicalExtraction {
  const parsed = medicalExtraction.safeParse(GROK_RESPONSE);
  assert.ok(parsed.success, "fixture must satisfy the extraction contract");
  return parsed.data;
}

/* ------------------------------------------------------- contract tests */

test("extraction contract accepts a well-formed payload", () => {
  const parsed = medicalExtraction.safeParse(GROK_RESPONSE);
  assert.equal(parsed.success, true);
});

test("extraction contract rejects out-of-range confidence", () => {
  const bad = { ...GROK_RESPONSE, conditions: [{ value: "Diabetes", confidence: 1.4 }] };
  assert.equal(medicalExtraction.safeParse(bad).success, false);
});

test("extraction contract rejects a missing summary", () => {
  const { summary: _omitted, ...withoutSummary } = GROK_RESPONSE;
  assert.equal(medicalExtraction.safeParse(withoutSummary).success, false);
});

/* ---------------------------------------------------- JSON recovery tests */

test("parseJsonPayload reads a bare JSON object", () => {
  assert.deepEqual(parseJsonPayload('{"a":1}'), { a: 1 });
});

test("parseJsonPayload recovers JSON from a markdown fence", () => {
  assert.deepEqual(parseJsonPayload('```json\n{"a":1}\n```'), { a: 1 });
});

test("parseJsonPayload recovers JSON wrapped in prose", () => {
  assert.deepEqual(parseJsonPayload('Sure! Here it is:\n{"a":1}\nHope that helps.'), { a: 1 });
});

test("parseJsonPayload throws on unrecoverable output", () => {
  assert.throws(() => parseJsonPayload("no json here at all"));
});

/* --------------------------------------------------------- Grok service */

test("extractMedicalData validates a stubbed model response", async () => {
  const { extraction } = await extractMedicalData({
    text: "Patient: Rahul Sharma. HbA1c 8.2%. Metformin 500mg twice daily.",
    documentType: "BLOOD_REPORT",
    complete: async () => JSON.stringify(GROK_RESPONSE),
  });

  assert.equal(extraction.patient_name?.value, "Rahul Sharma");
  assert.equal(extraction.lab_results[0].test, "HbA1c");
  assert.equal(extraction.medications.length, 2);
});

test("extractMedicalData retries once, then succeeds", async () => {
  let calls = 0;
  const { extraction } = await extractMedicalData({
    text: "Patient: Rahul Sharma. HbA1c 8.2%.",
    documentType: "BLOOD_REPORT",
    complete: async () => {
      calls++;
      if (calls === 1) return "not json";
      return JSON.stringify(GROK_RESPONSE);
    },
  });
  assert.equal(calls, 2);
  assert.equal(extraction.conditions.length, 3);
});

test("extractMedicalData fails when the model never returns valid JSON", async () => {
  await assert.rejects(
    extractMedicalData({
      text: "Patient: Rahul Sharma. HbA1c 8.2%.",
      documentType: "BLOOD_REPORT",
      complete: async () => "still not json",
    }),
    /could not process|not valid JSON/i,
  );
});

test("extractMedicalData rejects documents with too little text", async () => {
  await assert.rejects(
    extractMedicalData({
      text: "  ",
      documentType: "OTHER",
      complete: async () => JSON.stringify(GROK_RESPONSE),
    }),
    /readable text/i,
  );
});

/* --------------------------------------------------------- review items */

test("review items are built across every category", () => {
  const items = buildReviewItems(parseFixture());
  // 3 conditions + 2 medications + 1 allergy + 1 lab = 7 (symptoms are not reviewable)
  assert.equal(items.length, 7);
  assert.equal(items.filter((i) => i.kind === "CONDITION").length, 3);
  assert.equal(items.filter((i) => i.kind === "MEDICATION").length, 2);
  assert.equal(items.filter((i) => i.kind === "LAB_RESULT").length, 1);
});

test("low-confidence items are flagged and sorted first", () => {
  const items = buildReviewItems(parseFixture());
  assert.ok(items[0].confidence < items[items.length - 1].confidence);

  const flagged = items.filter((i) => i.needsAttention);
  assert.equal(flagged.length, 2); // 0.41 condition + 0.62 medication
  for (const item of flagged) assert.ok(item.confidence < REVIEW_THRESHOLD);
});

test("medication labels combine name, dosage and frequency", () => {
  const items = buildReviewItems(parseFixture());
  const metformin = items.find((i) => i.label.startsWith("Metformin"));
  assert.equal(metformin?.label, "Metformin 500mg — twice daily");
});

test("overall confidence is the mean, not the maximum", () => {
  const score = overallConfidence(parseFixture());
  assert.ok(score !== null);
  assert.ok(score! < 0.98, "a single crisp value must not lift the whole document");
  assert.ok(score! > 0.5);
});

/* --------------------------------------------- no-diagnosis guardrail */

test("diagnostic phrasing is replaced with a referral", () => {
  const result = enforceNoDiagnosis("You have diabetes and should take metformin.");
  assert.equal(result.rewritten, true);
  assert.match(result.summary, /healthcare provider/i);
  assert.doesNotMatch(result.summary, /you have diabetes/i);
});

test("observational summaries are kept and given a referral line", () => {
  const result = enforceNoDiagnosis("This report records an HbA1c of 8.2%.");
  assert.equal(result.rewritten, false);
  assert.match(result.summary, /HbA1c of 8\.2%/);
  assert.match(result.summary, /healthcare provider/i);
});

test("a summary that already refers on is not double-appended", () => {
  const text = "This records an HbA1c of 8.2%. Discuss with your healthcare provider.";
  const result = enforceNoDiagnosis(text);
  assert.equal(result.summary, text);
});

/* ------------------------------------------------------ reconciliation */

const EMPTY_PROFILE = { conditions: [], medications: [], allergies: [] };

test("nothing is written when the patient confirms nothing", () => {
  const items = buildReviewItems(parseFixture());
  const plan = buildReconciliationPlan(items, [], EMPTY_PROFILE);

  assert.equal(plan.records.length, 0);
  assert.equal(plan.confirmedCount, 0);
  assert.equal(plan.rejectedCount, items.length);
  assert.deepEqual(plan.profileAdditions.conditions, []);
});

test("explicitly rejected items are never written", () => {
  const items = buildReviewItems(parseFixture());
  const plan = buildReconciliationPlan(
    items,
    items.map((i) => ({ id: i.id, decision: "REJECT" as const })),
    EMPTY_PROFILE,
  );
  assert.equal(plan.records.length, 0);
});

test("only confirmed items reach the profile", () => {
  const items = buildReviewItems(parseFixture());
  const condition = items.find((i) => i.kind === "CONDITION" && i.confidence > 0.9)!;

  const plan = buildReconciliationPlan(
    items,
    [{ id: condition.id, decision: "CONFIRM" }],
    EMPTY_PROFILE,
  );

  assert.equal(plan.confirmedCount, 1);
  assert.equal(plan.records.length, 1);
  assert.equal(plan.records[0].record_type, "CONDITION");
  assert.deepEqual(plan.profileAdditions.conditions, [condition.label]);
});

test("a patient edit supersedes the extracted value", () => {
  const items = buildReviewItems(parseFixture());
  const target = items.find((i) => i.kind === "ALLERGY")!;

  const plan = buildReconciliationPlan(
    items,
    [{ id: target.id, decision: "CONFIRM", editedLabel: "Sulfonamides" }],
    EMPTY_PROFILE,
  );

  assert.equal(plan.records[0].allergy, "Sulfonamides");
  assert.deepEqual(plan.profileAdditions.allergies, ["Sulfonamides"]);
});

test("lab results become records but never join the profile summary lists", () => {
  const items = buildReviewItems(parseFixture());
  const lab = items.find((i) => i.kind === "LAB_RESULT")!;

  const plan = buildReconciliationPlan(
    items,
    [{ id: lab.id, decision: "CONFIRM" }],
    EMPTY_PROFILE,
  );

  assert.equal(plan.records.length, 1);
  assert.equal(plan.records[0].test_name, "HbA1c");
  assert.equal(plan.records[0].test_value, "8.2");
  assert.deepEqual(plan.profileAdditions.conditions, []);
  assert.deepEqual(plan.profileAdditions.medications, []);
});

test("merging is additive and case-insensitively deduplicated", () => {
  const items = buildReviewItems(parseFixture());
  const condition = items.find((i) => i.label === "Hypertension")!;

  const plan = buildReconciliationPlan(items, [{ id: condition.id, decision: "CONFIRM" }], {
    conditions: ["hypertension"], // already present, different case
    medications: [],
    allergies: [],
  });

  // The record is still written (it came from this document)…
  assert.equal(plan.records.length, 1);
  // …but the profile is not duplicated.
  assert.deepEqual(plan.profileAdditions.conditions, []);
});

test("mergeList preserves existing entries and order", () => {
  const merged = mergeList(["Asthma"], ["Diabetes", "asthma"]);
  assert.deepEqual(merged, ["Asthma", "Diabetes"]);
});

test("confirmed record shape satisfies the database CHECK constraint", () => {
  const items = buildReviewItems(parseFixture());
  const plan = buildReconciliationPlan(
    items,
    items.map((i) => ({ id: i.id, decision: "CONFIRM" as const })),
    EMPTY_PROFILE,
  );

  // patient_medical_records_shape requires exactly one populated field per type.
  for (const record of plan.records) {
    const populated = [
      record.condition,
      record.medication,
      record.allergy,
      record.test_name,
    ].filter((v) => v !== null).length;
    assert.equal(populated, 1, `${record.record_type} must populate exactly one column`);
  }
});

/* ------------------------------------------------------- file validation */

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff]);

test("valid PDF, PNG and JPG uploads are accepted", () => {
  assert.equal(validateUpload({ size: 1024, type: "application/pdf", bytes: PDF_BYTES }).ok, true);
  assert.equal(validateUpload({ size: 1024, type: "image/png", bytes: PNG_BYTES }).ok, true);
  assert.equal(validateUpload({ size: 1024, type: "image/jpeg", bytes: JPG_BYTES }).ok, true);
});

test("a disallowed MIME type is rejected", () => {
  const result = validateUpload({
    size: 1024,
    type: "application/zip",
    bytes: PDF_BYTES,
  });
  assert.equal(result.ok, false);
});

test("a file whose bytes contradict its declared type is rejected", () => {
  const result = validateUpload({ size: 1024, type: "application/pdf", bytes: PNG_BYTES });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /do not match/i);
});

test("oversized and empty files are rejected", () => {
  assert.equal(
    validateUpload({ size: 20 * 1024 * 1024, type: "application/pdf", bytes: PDF_BYTES }).ok,
    false,
  );
  assert.equal(validateUpload({ size: 0, type: "application/pdf", bytes: PDF_BYTES }).ok, false);
});

test("magic-byte detection distinguishes formats", () => {
  assert.equal(contentMatchesMimeType(PDF_BYTES, "application/pdf"), true);
  assert.equal(contentMatchesMimeType(PNG_BYTES, "application/pdf"), false);
  assert.equal(contentMatchesMimeType(JPG_BYTES, "image/jpeg"), true);
});

test("storage paths are scoped to the patient's own folder", () => {
  const patientId = "8f14e45f-ceea-467a-9f1a-1c1e1c1e1c1e";
  const path = buildStoragePath(patientId, "application/pdf");

  assert.ok(path.startsWith(`patients/${patientId}/medical_documents/`));
  assert.ok(path.endsWith(".pdf"));
  // Two uploads must never collide.
  assert.notEqual(path, buildStoragePath(patientId, "application/pdf"));
});

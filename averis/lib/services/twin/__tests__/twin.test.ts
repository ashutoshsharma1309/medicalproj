import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveTimelineEvents,
  sortAndDedupe,
  groupByYear,
  deriveConditions,
  deriveMedicationHistory,
  splitMedicationLabel,
} from "../timeline-service";
import {
  generateInsights,
  detectLabTrends,
  detectMedicationPatterns,
  detectCompletenessGaps,
  detectMonitoringGaps,
} from "../insight-service";
import { computeHealthOverview } from "../overview-service";
import { assembleTwin } from "../assemble";
import { describeTwin, deterministicSummary } from "../health-summary-service";
import { enforceNoDiagnosis } from "../../documents/review";
import type { ConfirmedRecordRow, DocumentRow, ProfileSnapshot } from "../types";

/* ------------------------------------------------------------- fixtures */

let sequence = 0;
function record(overrides: Partial<ConfirmedRecordRow> = {}): ConfirmedRecordRow {
  sequence += 1;
  return {
    id: `rec-${sequence}`,
    record_type: "CONDITION",
    condition: null,
    medication: null,
    allergy: null,
    test_name: null,
    test_value: null,
    test_unit: null,
    reference_range: null,
    record_date: null,
    confidence_score: 0.9,
    source_document_id: "doc-1",
    created_at: "2026-01-15T10:00:00.000Z",
    ...overrides,
  };
}

function document(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: "doc-1",
    file_name: "report.pdf",
    document_type: "LAB_REPORT",
    upload_status: "COMPLETED",
    uploaded_at: "2026-01-15T10:00:00.000Z",
    ...overrides,
  };
}

const EMPTY_PROFILE: ProfileSnapshot = {
  fullName: null,
  dateOfBirth: null,
  gender: null,
  bloodGroup: null,
  allergies: [],
  conditions: [],
  medications: [],
  emergencyContact: null,
};

const FULL_PROFILE: ProfileSnapshot = {
  fullName: "Asha Menon",
  dateOfBirth: "1985-04-02",
  gender: "FEMALE",
  bloodGroup: "O_POSITIVE",
  allergies: ["Penicillin"],
  conditions: ["Type 2 Diabetes"],
  medications: ["Metformin"],
  emergencyContact: "+91 98000 00000",
};

const NOW = new Date("2026-06-01T00:00:00.000Z");

/* ------------------------------------------------------------- timeline */

describe("timeline-service", () => {
  it("dates an event by its clinical date, not the upload date", () => {
    const events = deriveTimelineEvents(
      [
        record({
          record_type: "CONDITION",
          condition: "Hypertension",
          record_date: "2019-08-04",
          created_at: "2026-01-15T10:00:00.000Z",
        }),
      ],
      [],
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].eventDate, "2019-08-04");
  });

  it("falls back to the created date when the document carried no date", () => {
    const events = deriveTimelineEvents(
      [record({ record_type: "CONDITION", condition: "Asthma", record_date: null })],
      [],
    );
    assert.equal(events[0].eventDate, "2026-01-15");
  });

  it("does not add a document event when the document already produced records", () => {
    const events = deriveTimelineEvents(
      [record({ record_type: "CONDITION", condition: "Anaemia", source_document_id: "doc-1" })],
      [document({ id: "doc-1" })],
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "DIAGNOSIS");
  });

  it("adds a document event when the document produced nothing", () => {
    const events = deriveTimelineEvents([], [document({ id: "doc-9", file_name: "scan.pdf" })]);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "DOCUMENT_ADDED");
    assert.match(events[0].eventTitle, /scan\.pdf/);
  });

  it("skips records whose subject field is empty", () => {
    const events = deriveTimelineEvents(
      [
        record({ record_type: "CONDITION", condition: null }),
        record({ record_type: "MEDICATION", medication: null }),
        record({ record_type: "LAB_RESULT", test_name: null }),
      ],
      [],
    );
    assert.equal(events.length, 0);
  });

  it("labels a lab result with its value and reference range", () => {
    const events = deriveTimelineEvents(
      [
        record({
          record_type: "LAB_RESULT",
          test_name: "HbA1c",
          test_value: "8.2",
          test_unit: "%",
          reference_range: "4.0–5.6 %",
          record_date: "2026-02-01",
        }),
      ],
      [],
    );
    assert.equal(events[0].eventTitle, "HbA1c: 8.2 %");
    assert.match(events[0].description!, /4\.0–5\.6/);
  });

  it("sorts newest first and collapses identical title + date", () => {
    const sorted = sortAndDedupe([
      { eventType: "OTHER", eventTitle: "A", description: null, eventDate: "2020-01-01", sourceDocumentId: null },
      { eventType: "OTHER", eventTitle: "B", description: null, eventDate: "2024-01-01", sourceDocumentId: null },
      { eventType: "OTHER", eventTitle: "a", description: null, eventDate: "2020-01-01", sourceDocumentId: null },
    ]);

    assert.deepEqual(sorted.map((e) => e.eventTitle), ["B", "A"]);
  });

  it("groups by year with the most recent year first", () => {
    const groups = groupByYear([
      { eventType: "OTHER", eventTitle: "new", description: null, eventDate: "2026-03-01", sourceDocumentId: null },
      { eventType: "OTHER", eventTitle: "old", description: null, eventDate: "2019-03-01", sourceDocumentId: null },
    ]);

    assert.deepEqual(groups.map((g) => g.year), ["2026", "2019"]);
    assert.equal(groups[0].events.length, 1);
  });
});

describe("condition derivation", () => {
  it("collapses repeats and keeps the earliest date and highest confidence", () => {
    const conditions = deriveConditions([
      record({ record_type: "CONDITION", condition: "Type 2 Diabetes", record_date: "2022-05-01", confidence_score: 0.7 }),
      record({ record_type: "CONDITION", condition: "type 2 diabetes", record_date: "2020-01-09", confidence_score: 0.95 }),
    ]);

    assert.equal(conditions.length, 1);
    assert.equal(conditions[0].firstDetected, "2020-01-09");
    assert.equal(conditions[0].confidenceScore, 0.95);
  });

  it("never infers severity — an unspecified severity stays UNKNOWN", () => {
    const conditions = deriveConditions([
      record({ record_type: "CONDITION", condition: "Severe hypertension", record_date: "2024-01-01" }),
    ]);
    assert.equal(conditions[0].severity, "UNKNOWN");
  });
});

describe("medication history", () => {
  it("splits a compound label into name, dosage and frequency", () => {
    assert.deepEqual(splitMedicationLabel("Metformin 500 mg — twice daily"), {
      name: "Metformin",
      dosage: "500 mg",
      frequency: "twice daily",
    });
  });

  it("leaves a bare drug name untouched", () => {
    assert.deepEqual(splitMedicationLabel("Aspirin"), {
      name: "Aspirin",
      dosage: null,
      frequency: null,
    });
  });

  it("closes the earlier entry when the same drug reappears later", () => {
    const history = deriveMedicationHistory([
      record({ record_type: "MEDICATION", medication: "Metformin 500 mg", record_date: "2024-01-01" }),
      record({ record_type: "MEDICATION", medication: "Metformin 1000 mg", record_date: "2025-06-01" }),
    ]);

    const [current, previous] = history; // newest first
    assert.equal(current.startDate, "2025-06-01");
    assert.equal(current.endDate, null);
    assert.equal(previous.endDate, "2025-06-01");
  });

  it("treats different drugs as independent histories", () => {
    const history = deriveMedicationHistory([
      record({ record_type: "MEDICATION", medication: "Metformin", record_date: "2024-01-01" }),
      record({ record_type: "MEDICATION", medication: "Atorvastatin", record_date: "2025-01-01" }),
    ]);
    assert.equal(history.filter((m) => m.endDate === null).length, 2);
  });
});

/* ------------------------------------------------------------- insights */

describe("lab trends", () => {
  const labs = (values: [string, string][]) =>
    values.map(([date, value]) =>
      record({
        record_type: "LAB_RESULT",
        test_name: "HbA1c",
        test_value: value,
        test_unit: "%",
        record_date: date,
      }),
    );

  it("reports a rise across reports with every reading as evidence", () => {
    const [insight] = detectLabTrends(labs([["2025-01-01", "6.4"], ["2025-07-01", "7.1"], ["2026-01-01", "8.2"]]));

    assert.equal(insight.insightType, "TREND");
    assert.match(insight.insightText, /increased/);
    assert.match(insight.insightText, /6\.4% to 8\.2%/);
    assert.equal(insight.evidence.length, 3);
  });

  it("reports a fall", () => {
    const [insight] = detectLabTrends(labs([["2025-01-01", "8.2"], ["2026-01-01", "6.4"]]));
    assert.match(insight.insightText, /decreased/);
  });

  it("calls a sub-5% move stable rather than a direction", () => {
    const [insight] = detectLabTrends(labs([["2025-01-01", "5.00"], ["2026-01-01", "5.10"]]));
    assert.match(insight.insightText, /stayed broadly stable/);
    assert.equal(insight.importanceLevel, "LOW");
  });

  it("needs more than one reading", () => {
    assert.equal(detectLabTrends(labs([["2025-01-01", "6.4"]])).length, 0);
  });

  it("does not treat same-day duplicates as a trend", () => {
    assert.equal(detectLabTrends(labs([["2025-01-01", "6.4"], ["2025-01-01", "8.9"]])).length, 0);
  });

  it("ignores non-numeric results", () => {
    const insights = detectLabTrends([
      record({ record_type: "LAB_RESULT", test_name: "Dengue NS1", test_value: "Positive", record_date: "2025-01-01" }),
      record({ record_type: "LAB_RESULT", test_name: "Dengue NS1", test_value: "Negative", record_date: "2026-01-01" }),
    ]);
    assert.equal(insights.length, 0);
  });

  it("parses a value embedded in text", () => {
    const [insight] = detectLabTrends([
      record({ record_type: "LAB_RESULT", test_name: "LDL", test_value: "168 mg/dL", record_date: "2025-01-01" }),
      record({ record_type: "LAB_RESULT", test_name: "LDL", test_value: "112 mg/dL", record_date: "2026-01-01" }),
    ]);
    assert.match(insight.insightText, /decreased/);
  });

  it("grows confidence with the number of readings", () => {
    const two = detectLabTrends(labs([["2025-01-01", "6.0"], ["2026-01-01", "8.0"]]))[0];
    const three = detectLabTrends(labs([["2025-01-01", "6.0"], ["2025-06-01", "7.0"], ["2026-01-01", "8.0"]]))[0];
    assert.ok(three.confidenceScore! > two.confidenceScore!);
    assert.ok(three.confidenceScore! <= 1);
  });
});

describe("medication and completeness insights", () => {
  it("lists current medications as a pattern", () => {
    const meds = deriveMedicationHistory([
      record({ record_type: "MEDICATION", medication: "Metformin 500 mg", record_date: "2026-01-01" }),
    ]);
    const insights = detectMedicationPatterns(meds, []);
    assert.match(insights[0].insightText, /one current medication: Metformin/);
  });

  it("flags conditions recorded with no current medication", () => {
    const conditions = deriveConditions([
      record({ record_type: "CONDITION", condition: "Type 2 Diabetes", record_date: "2024-01-01" }),
    ]);
    const insights = detectMedicationPatterns([], conditions);
    const gap = insights.find((i) => i.insightType === "COMPLETENESS");
    assert.ok(gap);
    assert.match(gap.insightText, /no current medication/);
  });

  it("flags conditions with no lab results", () => {
    const conditions = deriveConditions([
      record({ record_type: "CONDITION", condition: "Hypothyroidism", record_date: "2024-01-01" }),
    ]);
    const insights = detectCompletenessGaps([], conditions);
    assert.match(insights[0].insightText, /no test results yet/);
  });

  it("counts undated records", () => {
    const records = [
      record({ record_type: "CONDITION", condition: "Anaemia", record_date: null }),
      record({ record_type: "LAB_RESULT", test_name: "Hb", test_value: "9", record_date: "2026-01-01" }),
    ];
    const insights = detectCompletenessGaps(records, []);
    const undated = insights.find((i) => /no date on the source document/.test(i.insightText));
    assert.ok(undated);
    assert.match(undated.insightText, /^1 of your 2/);
  });
});

describe("monitoring reminder", () => {
  it("stays quiet inside six months", () => {
    assert.equal(
      detectMonitoringGaps([document({ uploaded_at: "2026-03-01T00:00:00.000Z" })], NOW).length,
      0,
    );
  });

  it("reminds after six months", () => {
    const [insight] = detectMonitoringGaps([document({ uploaded_at: "2025-06-01T00:00:00.000Z" })], NOW);
    assert.equal(insight.insightType, "REMINDER");
    assert.equal(insight.importanceLevel, "LOW");
  });

  it("raises importance past a year", () => {
    const [insight] = detectMonitoringGaps([document({ uploaded_at: "2024-01-01T00:00:00.000Z" })], NOW);
    assert.equal(insight.importanceLevel, "MEDIUM");
  });

  it("says nothing when there are no documents at all", () => {
    assert.equal(detectMonitoringGaps([], NOW).length, 0);
  });
});

describe("insight ordering and safety", () => {
  const records = [
    record({ record_type: "CONDITION", condition: "Type 2 Diabetes", record_date: "2024-01-01" }),
    record({ record_type: "LAB_RESULT", test_name: "HbA1c", test_value: "6.4", test_unit: "%", record_date: "2025-01-01" }),
    record({ record_type: "LAB_RESULT", test_name: "HbA1c", test_value: "8.2", test_unit: "%", record_date: "2026-01-01" }),
  ];

  it("puts the most important observation first", () => {
    const insights = generateInsights({
      records,
      documents: [document()],
      conditions: deriveConditions(records),
      medications: [],
      now: NOW,
    });

    const ranks = insights.map((i) => ({ HIGH: 3, MEDIUM: 2, LOW: 1 })[i.importanceLevel]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a));
  });

  it("never states a diagnosis or a recommendation", () => {
    const insights = generateInsights({
      records,
      documents: [document()],
      conditions: deriveConditions(records),
      medications: [],
      now: NOW,
    });

    for (const insight of insights) {
      assert.equal(
        enforceNoDiagnosis(insight.insightText).rewritten,
        false,
        `insight tripped the anti-diagnosis guard: ${insight.insightText}`,
      );
    }
  });

  it("gives every insight at least one piece of evidence", () => {
    const insights = generateInsights({
      records,
      documents: [document()],
      conditions: deriveConditions(records),
      medications: deriveMedicationHistory(records),
      now: NOW,
    });
    for (const insight of insights) {
      assert.ok(insight.evidence.length > 0, `no evidence for: ${insight.insightText}`);
    }
  });
});

/* ------------------------------------------------------------- overview */

describe("health overview", () => {
  it("scores an empty record at zero and explains what is missing", () => {
    const overview = computeHealthOverview({
      profile: EMPTY_PROFILE,
      records: [],
      documents: [],
      medications: [],
      now: NOW,
    });

    assert.equal(overview.recordCompleteness, 0);
    assert.equal(overview.recentMonitoring, 0);
    assert.match(overview.explanations.recordCompleteness, /Still missing/);
    assert.equal(overview.explanations.recentMonitoring, "No documents added yet.");
  });

  it("scores a fully filled profile with a document at 100", () => {
    const overview = computeHealthOverview({
      profile: FULL_PROFILE,
      records: [],
      documents: [document({ uploaded_at: "2026-05-20T00:00:00.000Z" })],
      medications: [],
      now: NOW,
    });

    assert.equal(overview.recordCompleteness, 100);
    assert.equal(overview.recentMonitoring, 100);
    assert.match(overview.explanations.recordCompleteness, /Every part/);
  });

  it("treats no medication with none listed as complete, not as a failure", () => {
    const overview = computeHealthOverview({
      profile: { ...EMPTY_PROFILE, medications: [] },
      records: [],
      documents: [],
      medications: [],
      now: NOW,
    });
    assert.equal(overview.medicationTracking, 100);
  });

  it("decays monitoring past six months but never below 10", () => {
    const stale = computeHealthOverview({
      profile: FULL_PROFILE,
      records: [],
      documents: [document({ uploaded_at: "2015-01-01T00:00:00.000Z" })],
      medications: [],
      now: NOW,
    });
    assert.equal(stale.recentMonitoring, 10);
  });

  it("keeps every figure inside 0–100 with an explanation attached", () => {
    const overview = computeHealthOverview({
      profile: FULL_PROFILE,
      records: [],
      documents: [document({ uploaded_at: "2025-09-01T00:00:00.000Z" })],
      medications: deriveMedicationHistory([
        record({ record_type: "MEDICATION", medication: "Metformin 500 mg", record_date: "2025-09-01" }),
      ]),
      now: NOW,
    });

    for (const key of ["recordCompleteness", "medicationTracking", "recentMonitoring"] as const) {
      assert.ok(overview[key] >= 0 && overview[key] <= 100, `${key} out of range`);
      assert.ok(overview.explanations[key].length > 0, `${key} has no explanation`);
    }
  });
});

/* ------------------------------------------------------------- assembly */

describe("assembleTwin", () => {
  const records = [
    record({ record_type: "CONDITION", condition: "Type 2 Diabetes", record_date: "2022-03-04" }),
    record({ record_type: "MEDICATION", medication: "Metformin 500 mg — twice daily", record_date: "2025-11-02" }),
    record({ record_type: "ALLERGY", allergy: "Penicillin", record_date: "2022-03-04" }),
    record({ record_type: "LAB_RESULT", test_name: "HbA1c", test_value: "7.9", test_unit: "%", record_date: "2026-01-10" }),
  ];
  const documents = [document({ id: "doc-1", uploaded_at: "2026-01-11T09:00:00.000Z" })];

  it("produces a whole twin from confirmed records", () => {
    const twin = assembleTwin({ profile: FULL_PROFILE, age: 41, records, documents, now: NOW });

    assert.equal(twin.conditions.length, 1);
    assert.equal(twin.medications.length, 1);
    assert.equal(twin.timeline.length, 4);
    assert.equal(twin.documentCount, 1);
    assert.equal(twin.lastDocumentAt, "2026-01-11T09:00:00.000Z");
  });

  it("survives a patient with nothing on file", () => {
    const twin = assembleTwin({
      profile: EMPTY_PROFILE,
      age: null,
      records: [],
      documents: [],
      now: NOW,
    });

    assert.deepEqual(twin.timeline, []);
    assert.deepEqual(twin.insights, []);
    assert.equal(twin.documentCount, 0);
    assert.equal(twin.lastDocumentAt, null);
  });

  it("orders the timeline newest first", () => {
    const twin = assembleTwin({ profile: FULL_PROFILE, age: 41, records, documents, now: NOW });
    const dates = twin.timeline.map((e) => e.eventDate);
    assert.deepEqual(dates, [...dates].sort().reverse());
  });
});

/* -------------------------------------------------------- summary layer */

describe("health summary", () => {
  const twin = assembleTwin({
    profile: FULL_PROFILE,
    age: 41,
    records: [
      record({ record_type: "CONDITION", condition: "Type 2 Diabetes", record_date: "2022-03-04" }),
      record({ record_type: "MEDICATION", medication: "Metformin 500 mg", record_date: "2025-11-02" }),
    ],
    documents: [document()],
    now: NOW,
  });

  it("describes the twin to the model using facts only", () => {
    const description = describeTwin(twin);
    assert.match(description, /Type 2 Diabetes/);
    assert.match(description, /Metformin/);
  });

  it("produces a deterministic summary that passes the anti-diagnosis guard", () => {
    const { summary, guardrailTriggered } = deterministicSummary(twin);
    assert.ok(summary.length > 0);
    assert.equal(guardrailTriggered, false);
    assert.equal(enforceNoDiagnosis(summary).rewritten, false);
  });

  it("has something to say even for an empty record", () => {
    const empty = assembleTwin({
      profile: EMPTY_PROFILE,
      age: null,
      records: [],
      documents: [],
      now: NOW,
    });
    assert.ok(deterministicSummary(empty).summary.length > 0);
  });
});

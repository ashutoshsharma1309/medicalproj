import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assembleReport,
  describeReport,
  deterministicNarrative,
  enforceNoClinicalJudgement,
  REPORT_FOOTER,
  type ReadingRow,
} from "../report";

const START = "2026-08-07T12:00:00.000Z";
const END = "2026-08-08T12:00:00.000Z";

/** `count` readings, two minutes apart, with a linear ramp on each channel. */
function readings(
  count: number,
  from: { hr: number; spo2: number; temp: number },
  to: { hr: number; spo2: number; temp: number },
  stepMs = 120_000,
): ReadingRow[] {
  const base = Date.parse(START);
  return Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 0 : i / (count - 1);
    return {
      heart_rate: Math.round(from.hr + (to.hr - from.hr) * t),
      spo2: Math.round(from.spo2 + (to.spo2 - from.spo2) * t),
      temperature: Number((from.temp + (to.temp - from.temp) * t).toFixed(1)),
      recorded_at: new Date(base + i * stepMs).toISOString(),
    };
  });
}

function report(overrides: Partial<Parameters<typeof assembleReport>[0]> = {}) {
  return assembleReport({
    periodStart: START,
    periodEnd: END,
    readings: readings(60, { hr: 72, spo2: 98, temp: 36.6 }, { hr: 74, spo2: 98, temp: 36.7 }),
    alerts: [],
    emergencies: [],
    prediction: null,
    ...overrides,
  });
}

describe("assembling the window", () => {
  it("summarises each channel from the stored readings", () => {
    const sections = report();

    assert.equal(sections.readingCount, 60);
    assert.equal(sections.vitals.heartRate?.min, 72);
    assert.equal(sections.vitals.heartRate?.max, 74);
    assert.equal(sections.vitals.spo2?.count, 60);
  });

  it("reports drift from the first fifth to the last, not first to last", () => {
    // A single spike at the start must not become a trend across a day.
    const rows = readings(60, { hr: 70, spo2: 98, temp: 36.6 }, { hr: 70, spo2: 98, temp: 36.6 });
    rows[0].heart_rate = 160;

    const sections = assembleReport({
      periodStart: START,
      periodEnd: END,
      readings: rows,
      alerts: [],
      emergencies: [],
      prediction: null,
    });

    // 160 sits inside the first fifth and is averaged down by eleven others.
    assert.ok(Math.abs(sections.vitals.heartRate!.drift) < 9);
  });

  it("refuses to call a direction from too few readings", () => {
    const sections = assembleReport({
      periodStart: START,
      periodEnd: END,
      readings: readings(4, { hr: 60, spo2: 99, temp: 36.5 }, { hr: 130, spo2: 88, temp: 38.5 }),
      alerts: [],
      emergencies: [],
      prediction: null,
    });

    // Four points is a line through four points, not a trend.
    assert.equal(sections.vitals.heartRate?.drift, 0);
  });

  it("orders readings itself rather than trusting the caller's query", () => {
    const ascending = readings(30, { hr: 60, spo2: 99, temp: 36.5 }, { hr: 90, spo2: 95, temp: 37.2 });
    const descending = [...ascending].reverse();

    const a = assembleReport({
      periodStart: START,
      periodEnd: END,
      readings: ascending,
      alerts: [],
      emergencies: [],
      prediction: null,
    });
    const b = assembleReport({
      periodStart: START,
      periodEnd: END,
      readings: descending,
      alerts: [],
      emergencies: [],
      prediction: null,
    });

    assert.equal(a.vitals.heartRate!.drift, b.vitals.heartRate!.drift);
    assert.ok(a.vitals.heartRate!.drift > 0);
  });

  it("measures the longest interruption in monitoring", () => {
    const rows = readings(10, { hr: 70, spo2: 98, temp: 36.6 }, { hr: 70, spo2: 98, temp: 36.6 });
    // A four-hour hole in the middle.
    for (let i = 5; i < rows.length; i += 1) {
      rows[i].recorded_at = new Date(Date.parse(rows[i].recorded_at) + 4 * 3600_000).toISOString();
    }

    const sections = assembleReport({
      periodStart: START,
      periodEnd: END,
      readings: rows,
      alerts: [],
      emergencies: [],
      prediction: null,
    });

    assert.equal(sections.longestGapMinutes, 242);
  });

  it("counts alerts by severity", () => {
    const sections = report({
      alerts: [
        { severity: "CRITICAL" },
        { severity: "WARNING" },
        { severity: "WARNING" },
        { severity: "INFO" },
      ],
    });

    assert.deepEqual(sections.alerts, { critical: 1, warning: 2, info: 1 });
  });

  it("carries the risk assessment's own reasons rather than recomputing them", () => {
    const sections = report({
      prediction: {
        risk_score: 0.82,
        risk_category: "HIGH",
        confidence_score: 0.74,
        explanation: { explanation: ["SpO2 declining", "heart rate rising"] },
        created_at: END,
      },
    });

    assert.equal(sections.risk?.score, 0.82);
    assert.deepEqual(sections.risk?.reasons, ["SpO2 declining", "heart rate rising"]);
  });

  it("survives an explanation that is not the shape it expects", () => {
    const sections = report({
      prediction: {
        risk_score: "0.5",
        risk_category: "MODERATE",
        confidence_score: null,
        explanation: "a string, somehow",
        created_at: END,
      },
    });

    assert.equal(sections.risk?.score, 0.5);
    assert.deepEqual(sections.risk?.reasons, []);
    assert.equal(sections.risk?.confidence, null);
  });

  it("omits a channel the device never reported", () => {
    const rows = readings(20, { hr: 70, spo2: 98, temp: 36.6 }, { hr: 70, spo2: 98, temp: 36.6 });
    for (const row of rows) row.temperature = null;

    const sections = assembleReport({
      periodStart: START,
      periodEnd: END,
      readings: rows,
      alerts: [],
      emergencies: [],
      prediction: null,
    });

    // Absent, not zero — a zero would read as a measurement of 0°C.
    assert.equal(sections.vitals.temperature, undefined);
    assert.ok(sections.vitals.heartRate);
  });
});

describe("the fact sheet handed to the model", () => {
  it("states the numbers the narration is allowed to use", () => {
    const facts = describeReport(
      report({
        prediction: {
          risk_score: 0.82,
          risk_category: "HIGH",
          confidence_score: 0.7,
          explanation: { explanation: ["SpO2 declining"] },
          created_at: END,
        },
      }),
    );

    assert.match(facts, /Heart rate: mean/);
    assert.match(facts, /82%/);
    assert.match(facts, /SpO2 declining/);
  });

  it("says plainly when there is no assessment rather than omitting the line", () => {
    // An absent line reads as an oversight; an explicit one is a fact.
    assert.match(describeReport(report()), /risk assessment: none recorded/);
  });

  it("calls a small change steady rather than reporting a direction", () => {
    const facts = describeReport(
      report({
        readings: readings(60, { hr: 72, spo2: 98, temp: 36.6 }, { hr: 73, spo2: 98, temp: 36.6 }),
      }),
    );

    assert.match(facts, /Heart rate: .*steady across the window/);
  });
});

describe("narration without a model", () => {
  it("restates the assembled facts", () => {
    const narrative = deterministicNarrative(
      report({
        alerts: [{ severity: "CRITICAL" }],
        prediction: {
          risk_score: 0.82,
          risk_category: "HIGH",
          confidence_score: 0.7,
          explanation: { explanation: ["SpO2 declining"] },
          created_at: END,
        },
      }),
    );

    assert.match(narrative, /60 readings/);
    assert.match(narrative, /82% \(HIGH\)/);
    assert.match(narrative, /1 critical/);
    assert.ok(narrative.includes(REPORT_FOOTER));
  });

  it("says so when the window is empty instead of implying health", () => {
    const narrative = deterministicNarrative(
      report({ readings: [] }),
    );

    assert.match(narrative, /No readings were stored/);
    assert.match(narrative, /not worn or not connected/);
  });
});

describe("the clinical-judgement guardrail", () => {
  const sections = report();

  it("passes a factual restatement through", () => {
    const result = enforceNoClinicalJudgement(
      "Heart rate averaged 73 BPM and was steady across the window.",
      sections,
    );

    assert.equal(result.rewritten, false);
    assert.ok(result.summary.includes(REPORT_FOOTER));
  });

  it("does not append the footer twice", () => {
    const once = enforceNoClinicalJudgement(`Steady. ${REPORT_FOOTER}`, sections);

    assert.equal(once.summary.split(REPORT_FOOTER).length - 1, 1);
  });

  for (const drift of [
    "The pattern is suggestive of infection and warrants review.",
    "Recommend increasing supplemental oxygen therapy overnight.",
    "The patient should be admitted for observation.",
    "Prognosis is poor if the trend continues.",
    "Findings are consistent with an early sepsis event.",
  ]) {
    it(`replaces drift into judgement: ${drift.slice(0, 34)}…`, () => {
      const result = enforceNoClinicalJudgement(drift, sections);

      assert.equal(result.rewritten, true);
      // Replaced with the deterministic narration, not an apology — a
      // clinician who asked for a summary and got a refusal has nothing.
      assert.match(result.summary, /AVERIS stored 60 readings/);
    });
  }

  it("does not reject AVERIS's own wording for a fall", () => {
    // "a movement pattern consistent with a fall" is the alert text the
    // platform writes itself. A guardrail that rejected it would replace
    // every report about a fall with the deterministic one.
    const result = enforceNoClinicalJudgement(
      "The device reported a movement pattern consistent with a fall at 03:14.",
      sections,
    );

    assert.equal(result.rewritten, false);
  });

  it("still allows restating a threshold that was crossed", () => {
    const result = enforceNoClinicalJudgement(
      "Blood oxygen fell to 88%, below the 90% escalation threshold, on three occasions.",
      sections,
    );

    assert.equal(result.rewritten, false);
  });
});

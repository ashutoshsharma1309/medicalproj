import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyIntent,
  deterministicAnswer,
  groundsFrom,
  systemPromptFor,
  type Audience,
} from "../assistant";
import { normaliseTranscript, routeVoiceCommand, spokenReply } from "../voice";
import { assembleReport, type ReportSections } from "../report";

const START = "2026-08-07T12:00:00.000Z";
const END = "2026-08-08T12:00:00.000Z";

function sections(overrides: Partial<Parameters<typeof assembleReport>[0]> = {}): ReportSections {
  const base = Date.parse(START);
  return assembleReport({
    periodStart: START,
    periodEnd: END,
    readings: Array.from({ length: 40 }, (_, i) => ({
      heart_rate: 72 + i,
      spo2: 98 - Math.floor(i / 10),
      temperature: 36.6,
      recorded_at: new Date(base + i * 120_000).toISOString(),
    })),
    alerts: [],
    emergencies: [],
    prediction: null,
    ...overrides,
  });
}

const RISK = {
  risk_score: 0.82,
  risk_category: "HIGH",
  confidence_score: 0.71,
  explanation: { explanation: ["SpO2 declining", "heart rate rising"] },
  created_at: END,
};

describe("intent classification", () => {
  const cases: [string, string][] = [
    ["Why is this patient marked high risk?", "RISK_EXPLANATION"],
    ["Explain the risk score", "RISK_EXPLANATION"],
    ["Do I have any alerts?", "ALERTS"],
    ["Were there any emergencies overnight?", "ALERTS"],
    ["Has anything changed in the last 24 hours?", "TREND"],
    ["Is her oxygen trending down?", "TREND"],
    ["Is the device still reporting?", "MONITORING_COVERAGE"],
    ["How is my health today?", "CURRENT_STATUS"],
    ["What is his heart rate?", "CURRENT_STATUS"],
  ];

  for (const [question, expected] of cases) {
    it(`reads "${question}" as ${expected}`, () => {
      assert.equal(classifyIntent(question), expected);
    });
  }

  it("treats an empty question as unsupported", () => {
    assert.equal(classifyIntent("  "), "UNSUPPORTED");
  });

  it("does not guess at a question it has no data for", () => {
    // Answering this from monitoring data would mean inventing an answer.
    assert.equal(classifyIntent("What did the cardiologist say last week?"), "UNSUPPORTED");
  });
});

describe("requests AVERIS must refuse", () => {
  const refusals = [
    "What medication should I take for this?",
    "Should I go to hospital?",
    "Do I have an infection?",
    "What is the treatment plan?",
    "Am I going to be okay?",
    "What is the prognosis?",
    "Should the patient be admitted?",
  ];

  for (const question of refusals) {
    it(`refuses: ${question}`, () => {
      assert.equal(classifyIntent(question), "OUT_OF_SCOPE");
    });
  }

  it("refuses a question that hides a prescription request inside a fair one", () => {
    // The part asking for a prescription decides how the whole thing is
    // handled — which is why the out-of-scope check runs first.
    assert.equal(
      classifyIntent("Why is my risk high and what should I take for it?"),
      "OUT_OF_SCOPE",
    );
  });

  it("refuses before any model is involved", () => {
    const answer = deterministicAnswer("OUT_OF_SCOPE", sections(), "PATIENT");

    assert.equal(answer.declined, true);
    assert.match(answer.answer, /does not diagnose/);
    // A refusal produced by asking a model nicely can be argued out of; this
    // one is a branch.
    assert.deepEqual(answer.grounds, []);
  });

  it("does not tell a clinician to consult a doctor", () => {
    const answer = deterministicAnswer("OUT_OF_SCOPE", sections(), "CLINICIAN");

    assert.ok(!/ask your doctor|healthcare provider/i.test(answer.answer));
    assert.match(answer.answer, /judgement is yours/);
  });
});

describe("grounded answers", () => {
  it("explains a risk score from the assessment's own reasons", () => {
    const answer = deterministicAnswer(
      "RISK_EXPLANATION",
      sections({ prediction: RISK }),
      "CLINICIAN",
    );

    assert.match(answer.answer, /82% \(HIGH\)/);
    assert.match(answer.answer, /SpO2 declining/);
    // Never presented as a verdict about the person.
    assert.match(answer.answer, /not a judgement/);
  });

  it("says there is no score rather than inventing an explanation", () => {
    const answer = deterministicAnswer("RISK_EXPLANATION", sections(), "CLINICIAN");

    assert.match(answer.answer, /has not produced a risk assessment/);
  });

  it("reports alerts and which are still open", () => {
    const answer = deterministicAnswer(
      "ALERTS",
      sections({
        alerts: [{ severity: "CRITICAL" }, { severity: "WARNING" }],
        emergencies: [
          {
            event_type: "SEVERE_HYPOXIA",
            severity: "CRITICAL",
            status: "NEW",
            summary: "Blood oxygen measured 86%.",
            created_at: END,
          },
        ],
      }),
      "CLINICIAN",
    );

    assert.match(answer.answer, /1 critical and 1 warning/);
    assert.match(answer.answer, /Severe drop in blood oxygen/);
    assert.match(answer.answer, /still open/);
  });

  it("says plainly when there is nothing to report", () => {
    const answer = deterministicAnswer("ALERTS", sections(), "PATIENT");

    assert.match(answer.answer, /No threshold alerts and no emergency events/);
  });

  it("refuses to describe a period with no readings as healthy", () => {
    const answer = deterministicAnswer("CURRENT_STATUS", sections({ readings: [] }), "PATIENT");

    // Silence is not health, and this is the sentence that keeps a monitoring
    // platform from implying it is.
    assert.match(answer.answer, /no readings/i);
    assert.match(answer.answer, /not worn or not connected/);
  });

  it("reports a gap in monitoring rather than averaging over it", () => {
    const base = Date.parse(START);
    const readings = Array.from({ length: 20 }, (_, i) => ({
      heart_rate: 72,
      spo2: 98,
      temperature: 36.6,
      recorded_at: new Date(base + i * 120_000 + (i >= 10 ? 3 * 3600_000 : 0)).toISOString(),
    }));

    const answer = deterministicAnswer(
      "MONITORING_COVERAGE",
      sections({ readings }),
      "CLINICIAN",
    );

    assert.match(answer.answer, /gap of up to 182 minutes/);
    assert.match(answer.answer, /cannot say anything about that gap/);
  });

  it("addresses each audience as itself", () => {
    const patient = deterministicAnswer("CURRENT_STATUS", sections(), "PATIENT");
    const clinician = deterministicAnswer("CURRENT_STATUS", sections(), "CLINICIAN");

    assert.match(patient.answer, /^You have/);
    assert.match(clinician.answer, /^This patient has/);
  });

  it("names what it can answer when it cannot answer", () => {
    const answer = deterministicAnswer("UNSUPPORTED", sections(), "CLINICIAN");

    assert.equal(answer.declined, true);
    assert.match(answer.answer, /current vitals/);
  });

  it("shows the facts beneath the answer", () => {
    const grounds = groundsFrom(sections({ prediction: RISK }));

    // An answer that cannot be checked has to be believed instead.
    assert.ok(grounds.some((g) => /Heart rate: 40 measurements/.test(g)));
    assert.ok(grounds.some((g) => /Risk assessment 82%/.test(g)));
  });
});

describe("the system prompt", () => {
  for (const audience of ["CLINICIAN", "PATIENT", "CAREGIVER"] as Audience[]) {
    it(`forbids diagnosis for a ${audience.toLowerCase()}`, () => {
      const prompt = systemPromptFor(audience);

      assert.match(prompt, /NEVER diagnose/);
      assert.match(prompt, /Use ONLY the facts provided/);
    });
  }

  it("does not tell a clinician to consult a doctor", () => {
    assert.match(systemPromptFor("CLINICIAN"), /they are the doctor/);
  });
});

describe("voice routing", () => {
  it("strips filler and punctuation before routing", () => {
    assert.equal(
      normaliseTranscript("Um, hey AVERIS, show me the critical patients."),
      "show me the critical patients",
    );
  });

  it("takes a clinician to the caseload rather than describing it", () => {
    const route = routeVoiceCommand("Show me critical patients");

    // Paying a model to narrate a list the user is about to look at is slower
    // and worse than showing it.
    assert.equal(route.kind, "NAVIGATE");
    assert.equal(route.kind === "NAVIGATE" && route.href, "/clinical");
  });

  it("sends a real question to the assistant with its intent", () => {
    const route = routeVoiceCommand("Why is this patient high risk?");

    assert.equal(route.kind, "ASK");
    assert.equal(route.kind === "ASK" && route.intent, "RISK_EXPLANATION");
  });

  it("forwards an out-of-scope question so it gets the written refusal", () => {
    const route = routeVoiceCommand("What medication should I take?");

    assert.equal(route.kind, "ASK");
    assert.equal(route.kind === "ASK" && route.intent, "OUT_OF_SCOPE");
  });

  it("says it did not catch a misheard utterance rather than asking anyway", () => {
    // Speech recognition mishears, and a fluent answer to a question nobody
    // asked is worse than admitting the miss.
    assert.equal(routeVoiceCommand("banana telephone gradient").kind, "UNCLEAR");
  });

  it("speaks only the first sentence back", () => {
    const spoken = spokenReply(
      "No alerts were raised in this period. Heart rate averaged 74 BPM across 40 measurements.",
    );

    assert.equal(spoken, "No alerts were raised in this period.");
  });

  it("truncates a long first sentence rather than reading a paragraph", () => {
    assert.ok(spokenReply("x".repeat(400)).length <= 220);
  });
});

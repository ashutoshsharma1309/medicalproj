import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AI_ESCALATION_SCORE,
  DEVICE_SILENCE_MS,
  escalationsFor,
  fromAlerts,
  fromAssessment,
  fromSilence,
  noticeFor,
  shouldEscalate,
  type AlertLike,
  type AssessmentLike,
} from "../escalation";

function alert(overrides: Partial<AlertLike> = {}): AlertLike {
  return {
    alertType: "SPO2_LOW",
    severity: "CRITICAL",
    message: "Blood oxygen measured 86%, below the 90% escalation threshold.",
    observedValue: 86,
    thresholdValue: 90,
    ...overrides,
  };
}

function assessment(overrides: Partial<AssessmentLike> = {}): AssessmentLike {
  return {
    riskLevel: "LOW",
    riskScore: 0.1,
    confidence: 0.8,
    reasons: [],
    fallDetected: false,
    fallConfidence: null,
    deteriorating: false,
    ...overrides,
  };
}

describe("escalation from threshold alerts", () => {
  it("raises hypoxia from a critical SpO2 alert", () => {
    const [event] = fromAlerts([alert()]);

    assert.equal(event.eventType, "SEVERE_HYPOXIA");
    assert.equal(event.severity, "CRITICAL");
    assert.equal(event.detectedBy, "RULE_ENGINE");
    // The numbers travel with the event: an emergency a clinician cannot trace
    // back to a measurement is one they must take on trust.
    assert.equal(event.evidence.observed, 86);
    assert.equal(event.evidence.threshold, 90);
  });

  it("leaves warnings alone", () => {
    const events = fromAlerts([
      alert({ severity: "WARNING", observedValue: 93, thresholdValue: 94 }),
    ]);

    // The point of two levels is that one can wait. Escalating both produces a
    // queue with no priority in it.
    assert.deepEqual(events, []);
  });

  it("raises a fall from the movement flag", () => {
    const [event] = fromAlerts([
      alert({ alertType: "FALL_SUSPECTED", observedValue: null, thresholdValue: null }),
    ]);

    assert.equal(event.eventType, "FALL_DETECTED");
  });

  it("raises the same event type for a high and a low heart rate", () => {
    const high = fromAlerts([alert({ alertType: "HEART_RATE_HIGH", observedValue: 168 })]);
    const low = fromAlerts([alert({ alertType: "HEART_RATE_LOW", observedValue: 34 })]);

    assert.equal(high[0].eventType, "EXTREME_HEART_RATE");
    assert.equal(low[0].eventType, "EXTREME_HEART_RATE");
  });

  it("does not escalate a critical temperature", () => {
    const events = fromAlerts([
      alert({ alertType: "TEMPERATURE_HIGH", observedValue: 39.8, thresholdValue: 39.5 }),
    ]);

    // Still a critical alert on the patient's chart; not a minutes-matter
    // event, and diluting the response queue would not improve the fever.
    assert.deepEqual(events, []);
  });

  it("collapses a duplicated finding into one event", () => {
    const events = fromAlerts([alert(), alert({ observedValue: 84 })]);

    assert.equal(events.length, 1);
  });
});

describe("escalation from the AI assessment", () => {
  it("raises deterioration only when risk is critical and rising", () => {
    const events = fromAssessment(
      assessment({
        riskLevel: "CRITICAL",
        riskScore: 0.91,
        deteriorating: true,
        reasons: ["SpO2 declining", "heart rate rising"],
      }),
    );

    assert.equal(events[0].eventType, "RAPID_DETERIORATION");
    assert.equal(events[0].detectedBy, "AI_ENGINE");
    assert.match(events[0].summary, /91%/);
    assert.match(events[0].summary, /SpO2 declining/);
  });

  it("stays quiet for a high score that is flat", () => {
    const events = fromAssessment(
      assessment({ riskLevel: "CRITICAL", riskScore: 0.93, deteriorating: false }),
    );

    // A patient who has been at 0.93 for a week is a patient whose clinician
    // already knows. Re-raising it teaches them to dismiss the queue.
    assert.deepEqual(events, []);
  });

  it("stays quiet below the escalation score", () => {
    const events = fromAssessment(
      assessment({
        riskLevel: "CRITICAL",
        riskScore: AI_ESCALATION_SCORE - 0.01,
        deteriorating: true,
      }),
    );

    assert.deepEqual(events, []);
  });

  it("does not escalate a merely high risk level", () => {
    const events = fromAssessment(
      assessment({ riskLevel: "HIGH", riskScore: 0.95, deteriorating: true }),
    );

    assert.deepEqual(events, []);
  });

  it("carries the fall model's synthetic-data caveat into the evidence", () => {
    const [event] = fromAssessment(
      assessment({ fallDetected: true, fallConfidence: 0.88 }),
    );

    assert.equal(event.eventType, "FALL_DETECTED");
    assert.equal(event.evidence.confidence, 0.88);
    assert.match(String(event.evidence.caveat), /synthetic/);
  });
});

describe("escalation from silence", () => {
  const now = Date.parse("2026-08-08T12:00:00Z");

  it("raises after the silence window", () => {
    const last = new Date(now - DEVICE_SILENCE_MS - 60_000).toISOString();
    const [event] = fromSilence(last, now);

    assert.equal(event.eventType, "DEVICE_LOST");
    // WARNING, not CRITICAL: nothing is known to be wrong with the patient,
    // which is a different problem from a measured emergency.
    assert.equal(event.severity, "WARNING");
    assert.equal(event.evidence.silentMinutes, 16);
  });

  it("tolerates a short gap", () => {
    const last = new Date(now - 60_000).toISOString();
    assert.deepEqual(fromSilence(last, now), []);
  });

  it("says nothing about a device that never reported", () => {
    // A band still in its box is not a band that went quiet.
    assert.deepEqual(fromSilence(null, now), []);
  });

  it("ignores an unparseable timestamp rather than raising on it", () => {
    assert.deepEqual(fromSilence("not-a-date", now), []);
  });
});

describe("suppression against what is already open", () => {
  it("suppresses a repeat of an open event", () => {
    const candidate = fromAlerts([alert()])[0];

    assert.equal(
      shouldEscalate(candidate, [
        { eventType: "SEVERE_HYPOXIA", severity: "CRITICAL", status: "NEW" },
      ]),
      false,
    );
  });

  it("keeps suppressing while a clinician is on their way", () => {
    const candidate = fromAlerts([alert()])[0];

    for (const status of ["ACKNOWLEDGED", "IN_PROGRESS"] as const) {
      assert.equal(
        shouldEscalate(candidate, [
          { eventType: "SEVERE_HYPOXIA", severity: "CRITICAL", status },
        ]),
        false,
        `${status} should still suppress`,
      );
    }
  });

  it("raises again once the last one was resolved", () => {
    const candidate = fromAlerts([alert()])[0];

    assert.equal(
      shouldEscalate(candidate, [
        { eventType: "SEVERE_HYPOXIA", severity: "CRITICAL", status: "RESOLVED" },
      ]),
      true,
    );
  });

  it("lets an escalating severity through", () => {
    const candidate = fromAlerts([alert()])[0];

    // An open WARNING that has become CRITICAL is new information, and the
    // queue has to be able to say so.
    assert.equal(
      shouldEscalate(candidate, [
        { eventType: "SEVERE_HYPOXIA", severity: "WARNING", status: "NEW" },
      ]),
      true,
    );
  });
});

describe("escalationsFor", () => {
  const now = Date.parse("2026-08-08T12:00:00Z");

  it("merges a rule-engine and an AI fall into one event", () => {
    const events = escalationsFor({
      alerts: [alert({ alertType: "FALL_SUSPECTED", observedValue: null, thresholdValue: null })],
      assessment: assessment({ fallDetected: true, fallConfidence: 0.9 }),
      now,
    });

    // One fall. A queue showing it twice makes a clinician check whether the
    // patient fell twice.
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "FALL_DETECTED");
  });

  it("orders the most severe first", () => {
    const events = escalationsFor({
      alerts: [alert()],
      lastReadingAt: new Date(now - DEVICE_SILENCE_MS - 1).toISOString(),
      now,
    });

    assert.equal(events[0].severity, "CRITICAL");
    assert.equal(events[1].severity, "WARNING");
  });

  it("filters against open events in one pass", () => {
    const events = escalationsFor({
      alerts: [alert()],
      now,
      open: [{ eventType: "SEVERE_HYPOXIA", severity: "CRITICAL", status: "ACKNOWLEDGED" }],
    });

    assert.deepEqual(events, []);
  });

  it("returns nothing for an ordinary reading", () => {
    assert.deepEqual(escalationsFor({ alerts: [], assessment: assessment(), now }), []);
  });
});

describe("the notice a care team member receives", () => {
  it("leads with the patient, then the finding", () => {
    const candidate = fromAlerts([alert()])[0];
    const notice = noticeFor(candidate, { patientId: "p1", fullName: "Rahul Sharma" });

    // A phone notification truncates, and the recipient's first question is
    // always *who*.
    assert.match(notice.title, /^Rahul Sharma —/);
    assert.match(notice.body, /86%/);
    assert.equal(notice.severity, "CRITICAL");
  });

  it("links inside AVERIS, never off-site", () => {
    const candidate = fromAlerts([alert()])[0];
    const notice = noticeFor(candidate, { patientId: "p1", fullName: "Rahul Sharma" });

    assert.equal(notice.href, "/clinical/p1");
    assert.ok(!notice.href.startsWith("//"));
  });
});

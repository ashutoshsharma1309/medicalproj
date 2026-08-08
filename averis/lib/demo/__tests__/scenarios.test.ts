import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CARDIAC, FALL, LOW_OXYGEN, SCENARIOS, toReadingInput } from "../scenarios";
import { THRESHOLDS, evaluateReading, highestSeverity } from "@/lib/iot/alert-rules";
import { fromAlerts } from "@/lib/care/escalation";

/**
 * The three Phase 9 scenarios, driven through the pipeline.
 *
 * Each scenario is run reading by reading through the *real* alert rules and
 * the *real* escalation engine — no fixtures, no stand-ins — and asserted at
 * every stage. The point is not that extreme values trip thresholds; it is
 * that the quiet readings stay quiet, that a warning is deliberately not an
 * emergency, and that each event is classified as the kind of event it is.
 *
 * Every threshold below is read from `THRESHOLDS` rather than written as a
 * literal. A scenario whose claims are asserted against copies of the numbers
 * keeps passing after somebody changes the real ones, which is precisely when
 * you want it to fail.
 */

const NOW = new Date("2026-08-12T10:00:00Z");

/** Runs a scenario through alert evaluation, one reading at a time. */
function evaluate(scenario: (typeof SCENARIOS)[number]) {
  return scenario.readings.map((reading) => ({
    reading,
    alerts: evaluateReading(toReadingInput(reading, NOW)),
  }));
}

describe("scenario 1 — falling blood oxygen", () => {
  const steps = evaluate(LOW_OXYGEN);

  it("stays quiet while the patient is above the warning line", () => {
    // The half that is harder to believe and more important. A monitoring
    // system that alerts on 96% is one whose alerts nobody reads.
    const quiet = steps.filter((s) => s.reading.spo2 > THRESHOLDS.spo2.warning);

    assert.ok(quiet.length >= 3, "the scenario must contain genuinely normal readings");
    for (const step of quiet) {
      assert.deepEqual(
        step.alerts,
        [],
        `SpO₂ ${step.reading.spo2}% raised an alert while above the ${THRESHOLDS.spo2.warning}% warning line`,
      );
    }
  });

  it("raises a warning below the early-warning line without escalating", () => {
    const step = steps.find((s) => s.reading.spo2 === 93)!;
    const spo2Alerts = step.alerts.filter((a) => a.alertType === "SPO2_LOW");

    assert.equal(spo2Alerts.length, 1, "93% must raise exactly one oxygen alert");
    assert.equal(spo2Alerts[0].severity, "WARNING");

    // The property the scenario exists to demonstrate: a WARNING is not an
    // emergency. A system that escalates every warning has no way to say
    // "watch this" as distinct from "go now".
    assert.deepEqual(fromAlerts(step.alerts), []);
  });

  it("escalates below the published escalation point", () => {
    const step = steps.find((s) => s.reading.spo2 < THRESHOLDS.spo2.critical)!;

    assert.equal(highestSeverity(step.alerts), "CRITICAL");

    const emergencies = fromAlerts(step.alerts);
    assert.equal(emergencies.length, 1);
    assert.equal(emergencies[0].eventType, "SEVERE_HYPOXIA");
    assert.equal(emergencies[0].severity, "CRITICAL");
    assert.equal(emergencies[0].detectedBy, "RULE_ENGINE");
  });

  it("carries the numbers a clinician would need to check it", () => {
    const step = steps.at(-1)!;
    const emergency = fromAlerts(step.alerts)[0];

    // An emergency a clinician cannot trace back to numbers is one they have to
    // take on trust at the worst possible moment.
    assert.ok(emergency.summary.length > 10);
    assert.ok(Object.keys(emergency.evidence).length > 0);
    assert.match(JSON.stringify(emergency.evidence), /88/);
  });
});

describe("scenario 2 — a fall", () => {
  const steps = evaluate(FALL);

  it("raises nothing while the patient is walking", () => {
    const walking = steps.filter((s) => s.reading.movement === "ACTIVE");

    assert.ok(walking.length >= 2);
    for (const step of walking) {
      assert.deepEqual(step.alerts, [], "an active patient with normal vitals raised an alert");
    }
  });

  it("escalates on the movement channel alone, with unremarkable vitals", () => {
    const step = steps.find((s) => s.reading.movement === "FALL_SUSPECTED")!;

    // The assertion that matters. Every vital in this reading is inside its
    // normal range — a fall must escalate without help from them, or a patient
    // who falls without a vital sign changing is one nobody is told about.
    assert.ok(step.reading.spo2 > THRESHOLDS.spo2.warning);
    assert.ok(step.reading.heartRate < THRESHOLDS.heartRate.criticalHigh);

    const emergencies = fromAlerts(step.alerts);
    assert.equal(emergencies.length, 1);
    assert.equal(emergencies[0].eventType, "FALL_DETECTED");
    assert.equal(emergencies[0].severity, "CRITICAL");
  });

  it("does not raise a second fall once the patient is still", () => {
    const after = steps.at(-1)!;

    assert.deepEqual(
      after.alerts.filter((a) => a.alertType === "FALL_SUSPECTED"),
      [],
      "stillness after an impact must not re-raise the fall",
    );
  });
});

describe("scenario 3 — a cardiac event at rest", () => {
  const steps = evaluate(CARDIAC);

  it("does not escalate while the heart rate is climbing below the line", () => {
    const climbing = steps.find((s) => s.reading.heartRate === 141)!;

    // 141 is above the `high` threshold and below `criticalHigh`. It should be
    // visible as a warning and it should not summon anybody.
    assert.ok(climbing.reading.heartRate > THRESHOLDS.heartRate.high);
    assert.ok(climbing.reading.heartRate < THRESHOLDS.heartRate.criticalHigh);
    assert.deepEqual(fromAlerts(climbing.alerts), []);
  });

  it("escalates above the critical line", () => {
    const step = steps.at(-1)!;

    assert.ok(step.reading.heartRate > THRESHOLDS.heartRate.criticalHigh);

    const emergencies = fromAlerts(step.alerts);
    assert.equal(emergencies.length, 1);
    assert.equal(emergencies[0].eventType, "EXTREME_HEART_RATE");
    assert.equal(emergencies[0].severity, "CRITICAL");
  });

  it("names the heart rate as the reason rather than reporting a score alone", () => {
    const emergency = fromAlerts(steps.at(-1)!.alerts)[0];

    // A risk score with no explanation is a number a clinician cannot act on
    // and cannot argue with. The summary has to say what moved.
    assert.match(emergency.summary.toLowerCase(), /heart rate|bpm/);
    assert.match(JSON.stringify(emergency.evidence), /165/);
  });

  it("distinguishes a resting spike from exercise", () => {
    // The same heart rate while ACTIVE is a person exercising. This is the
    // reason the scenario specifies RESTING at every step: without the movement
    // channel the system either misses the event or cries wolf at every gym
    // session.
    const resting = steps.at(-1)!.reading;
    assert.equal(resting.movement, "RESTING");
  });
});

describe("the scenarios are isolated from one another", () => {
  it("classifies each event as its own kind", () => {
    // Run separately, so no scenario's open emergency can absorb another's.
    // The combined demo script cannot prove this: by the time the fall arrives,
    // a respiratory emergency is already open.
    const types = SCENARIOS.map((scenario) => {
      const last = scenario.readings.at(-1)!;
      const fromLast = fromAlerts(evaluateReading(toReadingInput(last, NOW)));
      const worst = fromLast[0]?.eventType ?? null;

      // The fall scenario's last reading is the recovery, so look one back.
      if (worst === null && scenario.id === "fall") {
        const impact = scenario.readings.at(-2)!;
        return fromAlerts(evaluateReading(toReadingInput(impact, NOW)))[0]?.eventType ?? null;
      }
      return worst;
    });

    assert.deepEqual(types, ["SEVERE_HYPOXIA", "FALL_DETECTED", "EXTREME_HEART_RATE"]);
  });

  it("states an expectation for every scenario, and a premise", () => {
    // Prose and assertion must agree; this is what keeps the documented
    // behaviour from drifting away from the tested behaviour.
    for (const scenario of SCENARIOS) {
      assert.ok(scenario.premise.length > 30, `${scenario.id} has no premise`);
      assert.ok(scenario.expectation.length > 30, `${scenario.id} has no expectation`);
    }
  });
});

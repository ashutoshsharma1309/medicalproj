import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSimulatedPayload,
  EMERGENCY_SCRIPT,
  scriptDurationMs,
} from "../emergency-script";
import { evaluateReading, THRESHOLDS } from "@/lib/iot/alert-rules";
import { escalationsFor } from "@/lib/care/escalation";
import { validateReading } from "@/lib/iot/reading-validation";

/**
 * The script is checked against the *real* rules, never against a copy of the
 * numbers. Its claims are things like "step three raises a warning and does
 * not escalate" — and if the published thresholds ever move, those claims
 * should fail here rather than during a demonstration.
 */

function readingFor(index: number) {
  const step = EMERGENCY_SCRIPT[index];
  return {
    deviceKey: "AVR001",
    heartRate: step.heart_rate,
    spo2: step.spo2,
    temperature: step.temperature,
    movementStatus: step.movement,
    batteryPercentage: 90,
    recordedAt: new Date().toISOString(),
  };
}

describe("the scripted payloads are real payloads", () => {
  it("every step passes the production validator", () => {
    // If the demo can produce something the ingest service rejects, the demo
    // is testing a different system from the one being demonstrated.
    EMERGENCY_SCRIPT.forEach((step, index) => {
      const result = validateReading(buildSimulatedPayload("AVR001", step, index));
      assert.equal(result.ok, true, `step ${index} (${step.stage}) failed validation`);
    });
  });

  it("carries no patient id", () => {
    const payload = buildSimulatedPayload("AVR001", EMERGENCY_SCRIPT[0], 0);

    // Ownership comes from the authenticated device row. The demo must not be
    // the one place that quietly does it differently.
    assert.equal("patient_id" in payload, false);
  });

  it("labels itself as a simulator on the wire", () => {
    const payload = buildSimulatedPayload("AVR001", EMERGENCY_SCRIPT[0], 0) as {
      telemetry: { transport: string };
    };

    assert.equal(payload.telemetry.transport, "simulator");
  });
});

describe("each stage does what it claims", () => {
  it("baseline raises nothing at all", () => {
    // The harder half to believe: that the alerting path is quiet when it
    // should be. A demo whose first frame already alarms proves nothing.
    const alerts = evaluateReading(readingFor(0));
    assert.deepEqual(alerts, [], `baseline raised ${alerts.map((a) => a.alertType).join(", ")}`);
  });

  it("the drifting step still raises nothing", () => {
    assert.deepEqual(evaluateReading(readingFor(1)), []);
  });

  it("the warning step raises a warning and does not escalate", () => {
    const alerts = evaluateReading(readingFor(2));

    assert.ok(alerts.length > 0, "expected a warning alert");
    assert.ok(
      alerts.every((a) => a.severity === "WARNING"),
      "a warning step must not raise anything critical",
    );

    // A WARNING is deliberately not an emergency. This is the assertion that
    // keeps the distinction real rather than a claim in a comment.
    assert.deepEqual(escalationsFor({ alerts }), []);
  });

  it("the critical step raises critical alerts and an emergency", () => {
    const alerts = evaluateReading(readingFor(4));
    const critical = alerts.filter((a) => a.severity === "CRITICAL");

    assert.ok(critical.length >= 2, "expected both hypoxia and heart rate to be critical");

    const escalations = escalationsFor({ alerts });
    const types = escalations.map((e) => e.eventType).sort();

    assert.deepEqual(types, ["EXTREME_HEART_RATE", "SEVERE_HYPOXIA"]);
  });

  it("the fall step raises a distinct emergency type", () => {
    const alerts = evaluateReading(readingFor(5));
    const escalations = escalationsFor({ alerts });

    assert.ok(escalations.some((e) => e.eventType === "FALL_DETECTED"));
  });

  it("the fall is not suppressed by the hypoxia already open", () => {
    const alerts = evaluateReading(readingFor(5));

    // Deduplication is per type. Demonstrating that one open emergency does
    // not swallow a different one is half the point of the last step.
    const escalations = escalationsFor({
      alerts,
      open: [{ eventType: "SEVERE_HYPOXIA", severity: "CRITICAL", status: "NEW" }],
    });

    assert.ok(escalations.some((e) => e.eventType === "FALL_DETECTED"));
  });
});

describe("the script's shape", () => {
  it("sits either side of the published thresholds, not at them", () => {
    const warning = EMERGENCY_SCRIPT[2];
    const critical = EMERGENCY_SCRIPT[4];

    // Chosen against the constants, so a threshold change breaks this test
    // rather than the demonstration.
    assert.ok(warning.spo2 < THRESHOLDS.spo2.warning, "warning step must cross the warning line");
    assert.ok(warning.spo2 > THRESHOLDS.spo2.critical, "warning step must stay above escalation");
    assert.ok(critical.spo2 < THRESHOLDS.spo2.critical, "critical step must cross escalation");
    assert.ok(critical.heart_rate >= THRESHOLDS.heartRate.criticalHigh);
  });

  it("deteriorates monotonically until the fall", () => {
    // A judge watching the numbers should see them move one way. A dip in the
    // middle reads as noise and undercuts the story the script is telling.
    const upToCritical = EMERGENCY_SCRIPT.slice(0, 5);

    for (let i = 1; i < upToCritical.length; i += 1) {
      assert.ok(
        upToCritical[i].spo2 <= upToCritical[i - 1].spo2,
        `SpO₂ rose at step ${i}`,
      );
      assert.ok(
        upToCritical[i].heart_rate >= upToCritical[i - 1].heart_rate,
        `heart rate fell at step ${i}`,
      );
    }
  });

  it("fits inside a five-minute demonstration", () => {
    assert.ok(scriptDurationMs() < 60_000, `script takes ${scriptDurationMs()}ms`);
  });

  it("every step explains itself", () => {
    for (const step of EMERGENCY_SCRIPT) {
      assert.ok(step.narration.length > 20, `${step.stage} has no narration`);
    }
  });
});

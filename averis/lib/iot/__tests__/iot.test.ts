import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  hashDeviceToken,
  hashesMatch,
  isValidDeviceKey,
  isWellFormedToken,
  issueDeviceToken,
  normalizeDeviceKey,
  suggestDeviceKey,
} from "../device-identity";
import { validateReading, PLAUSIBLE } from "../reading-validation";
import {
  evaluateReading,
  highestSeverity,
  severityRank,
  shouldRaise,
  THRESHOLDS,
  type AlertSeverity,
  type AlertType,
} from "../alert-rules";
import type { SensorReadingInput } from "../reading-validation";

const VECTORS = JSON.parse(
  readFileSync(join(import.meta.dirname, "vectors.json"), "utf8"),
) as {
  validation: {
    name: string;
    payload: unknown;
    expect: Record<string, unknown>;
  }[];
  alerts: {
    name: string;
    reading: Record<string, unknown>;
    expect: { alertType: string; severity: string }[];
  }[];
};

const NOW = new Date("2026-08-06T12:00:00.000Z");

/* --------------------------------------------------------- device identity */

describe("device tokens", () => {
  it("issues a prefixed, high-entropy token", () => {
    const { token } = issueDeviceToken();
    assert.match(token, /^avd_[A-Za-z0-9_-]{40,}$/);
  });

  it("never issues the same token twice", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => issueDeviceToken().token));
    assert.equal(tokens.size, 200);
  });

  it("stores a hash, not the token", () => {
    const { token, tokenHash } = issueDeviceToken();
    assert.match(tokenHash, /^[a-f0-9]{64}$/);
    assert.ok(!tokenHash.includes(token.slice(4)), "the token is recoverable from its hash");
  });

  it("hashes deterministically, so a device can authenticate twice", () => {
    const { token, tokenHash } = issueDeviceToken();
    assert.equal(hashDeviceToken(token), tokenHash);
  });

  it("produces a different hash for a one-character difference", () => {
    assert.notEqual(hashDeviceToken("avd_aaaa"), hashDeviceToken("avd_aaab"));
  });

  it("rejects malformed tokens before any database lookup", () => {
    for (const bad of ["", "hello", "Bearer avd_x", "avd_", "avd_short", `avd_${"x".repeat(200)}`]) {
      assert.equal(isWellFormedToken(bad), false, `accepted "${bad}"`);
    }
    assert.equal(isWellFormedToken(issueDeviceToken().token), true);
  });

  it("compares hashes without leaking a prefix through timing", () => {
    const a = hashDeviceToken("one");
    assert.equal(hashesMatch(a, a), true);
    assert.equal(hashesMatch(a, hashDeviceToken("two")), false);
    // Different lengths must not throw — timingSafeEqual does.
    assert.equal(hashesMatch(a, "short"), false);
  });
});

describe("device keys", () => {
  it("accepts the AVR001 shape and normalises case", () => {
    assert.equal(isValidDeviceKey("avr001"), true);
    assert.equal(normalizeDeviceKey(" avr001 "), "AVR001");
  });

  it("rejects keys that would break the database constraint", () => {
    for (const bad of ["", "ab", "has space", "sym!bol", "x".repeat(65)]) {
      assert.equal(isValidDeviceKey(bad), false, `accepted "${bad}"`);
    }
  });

  it("suggests the next free key in the series", () => {
    assert.equal(suggestDeviceKey([]), "AVR001");
    assert.equal(suggestDeviceKey(["AVR001"]), "AVR002");
    assert.equal(suggestDeviceKey(["AVR001", "avr002"]), "AVR003");
  });

  it("suggests something collision-proof past the series", () => {
    const full = Array.from({ length: 999 }, (_, i) => `AVR${String(i + 1).padStart(3, "0")}`);
    assert.match(suggestDeviceKey(full), /^AVR-[0-9A-F]{8}$/);
  });
});

/* ------------------------------------------------- validation (vectors) */

describe("payload validation — shared vectors", () => {
  for (const vector of VECTORS.validation) {
    it(vector.name, () => {
      const result = validateReading(vector.payload, NOW);
      const expected = vector.expect;

      if (expected.ok === false) {
        assert.equal(result.ok, false, "expected rejection");
        if (typeof expected.errorContains === "string") {
          const joined = (result as { errors: string[] }).errors.join(" | ");
          assert.ok(
            joined.includes(expected.errorContains),
            `expected an error containing "${expected.errorContains}", got: ${joined}`,
          );
        }
        return;
      }

      assert.equal(result.ok, true, `expected acceptance, got ${JSON.stringify(result)}`);
      const reading = (result as { reading: SensorReadingInput }).reading;

      for (const field of [
        "deviceKey",
        "heartRate",
        "spo2",
        "temperature",
        "movementStatus",
        "recordedAt",
      ] as const) {
        if (field in expected) {
          assert.deepEqual(reading[field], expected[field], `${field} mismatch`);
        }
      }

      if (expected.noPatientIdInResult) {
        // The validated shape has no field a patient id could travel in.
        assert.ok(!("patientId" in reading), "a patient id survived validation");
        assert.ok(!("patient_id" in (reading as Record<string, unknown>)));
      }
    });
  }
});

describe("validation boundaries", () => {
  it("accepts values exactly on the plausible bounds", () => {
    for (const [value, field] of [
      [PLAUSIBLE.heartRate.min, "heart_rate"],
      [PLAUSIBLE.heartRate.max, "heart_rate"],
      [PLAUSIBLE.spo2.min, "spo2"],
      [PLAUSIBLE.spo2.max, "spo2"],
    ] as const) {
      const result = validateReading({ device_id: "AVR001", [field]: value }, NOW);
      assert.equal(result.ok, true, `rejected ${field}=${value} at the boundary`);
    }
  });

  it("stamps arrival time when the device sends none", () => {
    const result = validateReading({ device_id: "AVR001", heart_rate: 70 }, NOW);
    assert.equal(result.ok, true);
    assert.equal((result as { reading: SensorReadingInput }).reading.recordedAt, NOW.toISOString());
  });

  it("accepts a timestamp within the tolerated clock skew", () => {
    const nearFuture = new Date(NOW.getTime() + 30 * 60 * 1000).toISOString();
    const result = validateReading(
      { device_id: "AVR001", heart_rate: 70, recorded_at: nearFuture },
      NOW,
    );
    assert.equal(result.ok, true);
  });
});

/* ----------------------------------------------------- alerts (vectors) */

function reading(overrides: Partial<SensorReadingInput> = {}): SensorReadingInput {
  return {
    deviceKey: "AVR001",
    heartRate: 70,
    spo2: 98,
    temperature: 36.7,
    movementStatus: "RESTING",
    batteryPercentage: 90,
    recordedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("alert rules — shared vectors", () => {
  for (const vector of VECTORS.alerts) {
    it(vector.name, () => {
      const raised = evaluateReading(reading(vector.reading as Partial<SensorReadingInput>));

      assert.equal(
        raised.length,
        vector.expect.length,
        `expected ${vector.expect.length} alert(s), got ${raised.map((a) => a.alertType).join(", ") || "none"}`,
      );

      for (const expected of vector.expect) {
        const found = raised.find((a) => a.alertType === expected.alertType);
        assert.ok(found, `no ${expected.alertType} alert raised`);
        assert.equal(found.severity, expected.severity, `${expected.alertType} severity`);
      }
    });
  }
});

describe("alert behaviour", () => {
  it("every alert names the value and the threshold that produced it", () => {
    // An alert a patient cannot trace to a number is indistinguishable from
    // the system guessing.
    const raised = evaluateReading(reading({ spo2: 85, heartRate: 160, temperature: 39.9 }));
    assert.ok(raised.length >= 3);

    for (const alert of raised) {
      assert.ok(alert.message.length > 0);
      if (alert.alertType !== "FALL_SUSPECTED") {
        assert.notEqual(alert.observedValue, null, `${alert.alertType} has no observed value`);
        assert.notEqual(alert.thresholdValue, null, `${alert.alertType} has no threshold`);
        assert.match(alert.message, /\d/, `${alert.alertType} message quotes no number`);
      }
    }
  });

  it("never says what a reading means clinically", () => {
    const raised = evaluateReading(reading({ spo2: 85, heartRate: 165, temperature: 39.9 }));
    for (const alert of raised) {
      assert.doesNotMatch(alert.message, /\byou (?:have|are)\b/i, alert.message);
      assert.doesNotMatch(alert.message, /\bdiagnos/i, alert.message);
      assert.doesNotMatch(alert.message, /\byou should\b/i, alert.message);
    }
  });

  it("suppresses a repeat of an alert already open", () => {
    // 0.5 Hz below threshold for ten minutes would otherwise be 300 rows.
    const open = [{ alertType: "SPO2_LOW" as AlertType, severity: "CRITICAL" as AlertSeverity }];
    const [candidate] = evaluateReading(reading({ spo2: 87 }));
    assert.equal(shouldRaise(candidate, open), false);
  });

  it("lets an escalation through", () => {
    const open = [{ alertType: "SPO2_LOW" as AlertType, severity: "WARNING" as AlertSeverity }];
    const [candidate] = evaluateReading(reading({ spo2: 87 }));
    assert.equal(candidate.severity, "CRITICAL");
    assert.equal(shouldRaise(candidate, open), true);
  });

  it("does not treat a de-escalation as new", () => {
    const open = [{ alertType: "SPO2_LOW" as AlertType, severity: "CRITICAL" as AlertSeverity }];
    const [candidate] = evaluateReading(reading({ spo2: 92 }));
    assert.equal(candidate.severity, "WARNING");
    assert.equal(shouldRaise(candidate, open), false);
  });

  it("raises an unrelated alert even when another is open", () => {
    const open = [{ alertType: "SPO2_LOW" as AlertType, severity: "CRITICAL" as AlertSeverity }];
    const raised = evaluateReading(reading({ heartRate: 160 }));
    const hr = raised.find((a) => a.alertType === "HEART_RATE_HIGH")!;
    assert.equal(shouldRaise(hr, open), true);
  });

  it("ranks severities so the dashboard shows the worst", () => {
    assert.ok(severityRank("CRITICAL") > severityRank("WARNING"));
    assert.ok(severityRank("WARNING") > severityRank("INFO"));
    assert.equal(highestSeverity(evaluateReading(reading({ spo2: 87, batteryPercentage: 5 }))), "CRITICAL");
    assert.equal(highestSeverity([]), null);
  });

  it("keeps thresholds inside what validation accepts", () => {
    // A threshold outside the plausible range could never fire, and the alert
    // would silently never exist.
    assert.ok(THRESHOLDS.heartRate.criticalHigh < PLAUSIBLE.heartRate.max);
    assert.ok(THRESHOLDS.heartRate.criticalLow > PLAUSIBLE.heartRate.min);
    assert.ok(THRESHOLDS.spo2.critical > PLAUSIBLE.spo2.min);
    assert.ok(THRESHOLDS.temperature.criticalHigh < PLAUSIBLE.temperature.max);
    assert.ok(THRESHOLDS.temperature.criticalLow > PLAUSIBLE.temperature.min);
  });
});

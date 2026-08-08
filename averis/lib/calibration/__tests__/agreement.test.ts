import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACCEPTABLE,
  MIN_PAIRS,
  REGULATORY_NOTE,
  agreement,
  verdict,
  type CalibrationPair,
} from "../agreement";

/** `count` pairs where the device reads exactly `offset` above the reference. */
function offsetPairs(count: number, offset: number, start = 95): CalibrationPair[] {
  return Array.from({ length: count }, (_, i) => {
    const reference = start + (i % 5);
    return { device: reference + offset, reference };
  });
}

describe("the reason this is not a correlation", () => {
  it("catches a device that tracks the reference perfectly and reads 8 points low", () => {
    // The scenario in one test. These two series correlate at r = 1.0 — the
    // device moves exactly with the reference. It is also telling a clinician
    // that a patient at 92% is at 84%.
    const pairs = offsetPairs(40, -8);
    const result = agreement(pairs, "%");

    assert.equal(result.insufficient, false);
    assert.ok(Math.abs(result.bias + 8) < 0.001, `bias was ${result.bias}`);

    // A correlation-based check would have passed this device.
    assert.equal(verdict("spo2", result).acceptable, false);
    assert.match(verdict("spo2", result).reason, /systematic offset/);
  });

  it("reports the limits of agreement, not just the average", () => {
    // Two devices can share a bias of zero: one that is always right, and one
    // that alternates ±10. Only the limits of agreement tell them apart.
    const steady = agreement(offsetPairs(40, 0), "%");
    const erratic = agreement(
      Array.from({ length: 40 }, (_, i) => ({ device: 95 + (i % 2 ? 10 : -10), reference: 95 })),
      "%",
    );

    assert.ok(Math.abs(steady.bias) < 0.001);
    assert.ok(Math.abs(erratic.bias) < 0.001, "both have zero bias");

    assert.ok(steady.limitsOfAgreement.upper < 0.001);
    assert.ok(erratic.limitsOfAgreement.upper > 9, "the erratic device must be distinguishable");
  });
});

describe("refusing to report on too little data", () => {
  it("says so rather than producing a figure", () => {
    const result = agreement(offsetPairs(6, 1), "%");

    assert.equal(result.insufficient, true);
    assert.equal(result.bias, 0, "no statistic is produced at all");
    assert.match(result.summary, /At least 20/);
    assert.match(result.summary, /confidence interval wider than the limits/);
  });

  it("treats insufficient data as neither a pass nor a fail", () => {
    const v = verdict("spo2", agreement(offsetPairs(5, 0), "%"));

    // A device with five perfect measurements has not passed. Recording it as
    // passing is how a calibration record becomes a claim nobody checked.
    assert.equal(v.acceptable, false);
    assert.match(v.reason, /At least 20/);
  });

  it("starts reporting at exactly the minimum", () => {
    assert.equal(agreement(offsetPairs(MIN_PAIRS - 1, 1)).insufficient, true);
    assert.equal(agreement(offsetPairs(MIN_PAIRS, 1)).insufficient, false);
  });

  it("handles an empty set without dividing by zero", () => {
    const result = agreement([]);

    assert.equal(result.n, 0);
    assert.equal(result.insufficient, true);
    assert.ok(Number.isFinite(result.bias));
  });
});

describe("the statistics themselves", () => {
  it("computes bias as device minus reference", () => {
    const high = agreement(offsetPairs(30, 3), "bpm");
    const low = agreement(offsetPairs(30, -3), "bpm");

    // Sign convention matters for the sentence on screen: positive must mean
    // the band reads high.
    assert.ok(high.bias > 0);
    assert.ok(low.bias < 0);
    assert.match(high.summary, /above the reference/);
    assert.match(low.summary, /below the reference/);
  });

  it("uses the sample standard deviation, not the population one", () => {
    // n−1. The population form understates the spread, which narrows the limits
    // of agreement — an error in the direction that flatters the device.
    const pairs: CalibrationPair[] = [
      ...Array.from({ length: 10 }, () => ({ device: 96, reference: 95 })),
      ...Array.from({ length: 10 }, () => ({ device: 94, reference: 95 })),
    ];
    const result = agreement(pairs, "%");

    // differences are +1 (×10) and −1 (×10): mean 0, sample SD = sqrt(20/19).
    assert.ok(Math.abs(result.bias) < 1e-9);
    assert.ok(Math.abs(result.sd - Math.sqrt(20 / 19)) < 1e-9, `sd was ${result.sd}`);
  });

  it("puts 95% of disagreements inside the limits", () => {
    const result = agreement(offsetPairs(40, 2), "%");

    assert.ok(Math.abs(result.limitsOfAgreement.upper - (result.bias + 1.96 * result.sd)) < 1e-9);
    assert.ok(Math.abs(result.limitsOfAgreement.lower - (result.bias - 1.96 * result.sd)) < 1e-9);
  });

  it("reports the worst single disagreement", () => {
    const pairs = [...offsetPairs(30, 0), { device: 80, reference: 95 }];
    const result = agreement(pairs, "%");

    // The average hides the one reading that would have mattered.
    assert.equal(result.maxAbsoluteDifference, 15);
  });

  it("computes RMS as the ISO metric does", () => {
    // A_rms combines bias and scatter. A device with a pure 3-point offset and
    // no scatter has an RMS of exactly 3.
    const result = agreement(offsetPairs(30, 3), "%");
    assert.ok(Math.abs(result.rms - 3) < 1e-9, `rms was ${result.rms}`);
  });
});

describe("proportional bias", () => {
  it("flags a device that agrees at the top of the range and diverges below it", () => {
    // The clinically important case for SpO₂: fine at 98%, wrong at 90%, where
    // the decision actually lives.
    const pairs: CalibrationPair[] = [];
    for (let reference = 88; reference <= 100; reference += 1) {
      for (let repeat = 0; repeat < 3; repeat += 1) {
        // error shrinks to zero as saturation approaches 100
        pairs.push({ device: reference + (100 - reference) * 0.5, reference });
      }
    }

    const result = agreement(pairs, "%");

    assert.equal(result.proportionalBias.present, true);
    assert.ok(result.proportionalBias.slope < 0, "error must shrink as the value rises");
    assert.match(result.summary, /understates the error at one end/);
  });

  it("does not flag a constant offset as proportional", () => {
    const result = agreement(offsetPairs(40, 3), "%");

    assert.equal(result.proportionalBias.present, false);
    assert.ok(Math.abs(result.proportionalBias.slope) < 0.01);
  });

  it("does not divide by zero when every measurement is the same value", () => {
    const pairs = Array.from({ length: 30 }, () => ({ device: 97, reference: 95 }));
    const result = agreement(pairs, "%");

    assert.equal(result.proportionalBias.slope, 0);
    assert.equal(result.proportionalBias.present, false);
  });
});

describe("the verdict never overclaims", () => {
  it("says a pass means working, not clinically accurate", () => {
    const v = verdict("heart_rate", agreement(offsetPairs(30, 1), "bpm"));

    assert.equal(v.acceptable, true);
    assert.match(v.reason, /sensor is working, not that the reading is clinically accurate/);
  });

  it("refuses to judge a channel with no defined bounds", () => {
    const v = verdict("blood_glucose", agreement(offsetPairs(30, 0)));

    assert.equal(v.acceptable, false);
    assert.match(v.reason, /No acceptance bounds/);
  });

  it("keeps the temperature RMS bound tighter than its bias bound", () => {
    // The MLX90614 measures skin, which runs 1–2 °C below core. A large,
    // consistent offset is expected and fine; inconsistency is not.
    assert.ok(ACCEPTABLE.temperature.maxRms < ACCEPTABLE.temperature.maxAbsBias);
  });

  it("carries the regulatory caveat where it cannot be missed", () => {
    assert.match(REGULATORY_NOTE, /ISO 80601-2-61/);
    assert.match(REGULATORY_NOTE, /AVERIS has not performed one and cannot/);
    assert.match(REGULATORY_NOTE, /does not establish accuracy/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bandFor,
  calculateHealthScore,
  MINIMUM_READINGS,
  type ScoreInput,
} from "../health-score";

const NOW = Date.parse("2026-08-10T12:00:00.000Z");

/** `count` readings, two minutes apart, ending now. */
function readings(
  count: number,
  values: { hr?: number | null; spo2?: number | null; temp?: number | null } = {},
  stepMs = 120_000,
): ScoreInput["readings"] {
  return Array.from({ length: count }, (_, i) => ({
    heart_rate: values.hr === undefined ? 72 : values.hr,
    spo2: values.spo2 === undefined ? 98 : values.spo2,
    temperature: values.temp === undefined ? 36.7 : values.temp,
    recorded_at: new Date(NOW - (count - 1 - i) * stepMs).toISOString(),
  }));
}

function input(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    readings: readings(120),
    alerts: [],
    openEmergencies: 0,
    risk: { score: 0.1, level: "LOW" },
    deviceReporting: true,
    windowHours: 6,
    now: NOW,
    ...overrides,
  };
}

describe("refusing to produce a number", () => {
  it("returns null for a window with no readings", () => {
    const result = calculateHealthScore(input({ readings: [] }));

    // The worst failure available to this component would be a reassuring
    // number for a band nobody wore.
    assert.equal(result.score, null);
    assert.match(result.unavailableReason!, /not worn or not connected/);
  });

  it("refuses rather than scoring a handful of readings", () => {
    const result = calculateHealthScore(input({ readings: readings(MINIMUM_READINGS - 1) }));

    assert.equal(result.score, null);
    assert.match(result.unavailableReason!, /too few/);
  });

  it("never returns a default like 50 or 100 when it cannot score", () => {
    for (const count of [0, 1, 5, 9]) {
      const result = calculateHealthScore(input({ readings: readings(count) }));
      assert.equal(result.score, null, `${count} readings should not produce a score`);
    }
  });
});

describe("the score itself", () => {
  it("is high for a quiet, well-monitored window", () => {
    const result = calculateHealthScore(input());

    assert.ok(result.score !== null && result.score >= 85, `got ${result.score}`);
    assert.equal(result.band, "STABLE");
  });

  it("falls when measurements sit outside published ranges", () => {
    const healthy = calculateHealthScore(input());
    const hypoxic = calculateHealthScore(input({ readings: readings(120, { spo2: 88 }) }));

    assert.ok(hypoxic.score! < healthy.score!);
  });

  it("falls further with critical alerts than with warnings", () => {
    const warned = calculateHealthScore(input({ alerts: [{ severity: "WARNING" }] }));
    const critical = calculateHealthScore(input({ alerts: [{ severity: "CRITICAL" }] }));

    assert.ok(critical.score! < warned.score!);
  });

  it("stays inside 0–100 under the worst inputs", () => {
    const result = calculateHealthScore(
      input({
        readings: readings(120, { hr: 180, spo2: 80, temp: 40 }),
        alerts: Array.from({ length: 40 }, () => ({ severity: "CRITICAL" })),
        risk: { score: 1, level: "CRITICAL" },
        deviceReporting: false,
      }),
    );

    assert.ok(result.score! >= 0 && result.score! <= 100, `got ${result.score}`);
  });
});

describe("decomposability", () => {
  it("lists every factor with its weight and contribution", () => {
    const result = calculateHealthScore(input());

    // A score that cannot be taken apart is a black box, which is the one
    // thing this product claims not to be.
    assert.deepEqual(
      result.factors.map((f) => f.key).sort(),
      ["alerts", "coverage", "risk", "timeInRange"],
    );

    for (const factor of result.factors) {
      assert.ok(factor.detail.length > 0, `${factor.key} has no explanation`);
      assert.ok(factor.weight > 0 && factor.weight <= 1);
    }
  });

  it("weights sum to one, so the factors account for the whole score", () => {
    const result = calculateHealthScore(input());
    const total = result.factors.reduce((sum, f) => sum + f.weight, 0);

    assert.ok(Math.abs(total - 1) < 0.0001, `weights sum to ${total}`);
  });

  it("the factor points sum to the score", () => {
    const result = calculateHealthScore(input({ readings: readings(120, { spo2: 91 }) }));
    const summed = Math.round(result.factors.reduce((sum, f) => sum + f.points, 0));

    assert.equal(summed, result.score);
  });
});

describe("the cases where an average would mislead", () => {
  it("an open emergency forces the band to critical whatever the score", () => {
    const result = calculateHealthScore(input({ openEmergencies: 1 }));

    // Six quiet hours must never render as "Stable" while somebody is waiting
    // for a response.
    assert.equal(result.band, "CRITICAL");
  });

  it("an open emergency zeroes the alert factor rather than softening it", () => {
    const result = calculateHealthScore(input({ openEmergencies: 2 }));
    const alerts = result.factors.find((f) => f.key === "alerts")!;

    assert.equal(alerts.points, 0);
    assert.match(alerts.detail, /awaiting a response/);
  });

  it("a missing risk assessment is neutral, not healthy", () => {
    const withRisk = calculateHealthScore(input({ risk: { score: 0, level: "LOW" } }));
    const without = calculateHealthScore(input({ risk: null }));

    // Otherwise a patient whose analysis never ran outscores one whose
    // analysis found nothing wrong.
    assert.ok(without.score! < withRisk.score!);
    assert.match(
      without.factors.find((f) => f.key === "risk")!.detail,
      /neutral, not as healthy/,
    );
  });

  it("a device that stopped reporting costs coverage", () => {
    // `deviceReporting` is a categorical answer from the device service. Even
    // when the newest timestamp is recent, "not reporting" has to cost
    // something — otherwise a band that dropped off seconds ago scores exactly
    // like one still on air.
    const live = calculateHealthScore(input());
    const stale = calculateHealthScore(input({ deviceReporting: false }));

    assert.ok(stale.score! < live.score!);
    assert.match(
      stale.factors.find((f) => f.key === "coverage")!.detail,
      /not currently reporting/,
    );
  });

  it("a long gap in the middle of the window costs coverage", () => {
    // Identical first and last timestamps, so the span is the same and only
    // the hole differs. Comparing a longer span against a shorter one would
    // measure span, not the gap.
    const continuous = readings(60, {}, 120_000);

    // The middle third simply removed. Same first and last timestamp, same
    // span — the only difference is a forty-minute silence in the middle,
    // which is exactly what the assertion is about.
    const gapped = continuous.filter((_, i) => i < 20 || i >= 40);

    const a = calculateHealthScore(input({ readings: continuous }));
    const b = calculateHealthScore(input({ readings: gapped }));

    assert.ok(
      b.factors.find((f) => f.key === "coverage")!.attained <
        a.factors.find((f) => f.key === "coverage")!.attained,
      "a window with a silence in it should score lower coverage",
    );
  });

  it("does not penalise a device for a sensor it does not have", () => {
    const withTemp = calculateHealthScore(input());
    const noTemp = calculateHealthScore(input({ readings: readings(120, { temp: null }) }));

    // An absent thermometer is a coverage question, not a health one — a chest
    // strap should not score worse than a wristband for being a chest strap.
    assert.equal(
      withTemp.factors.find((f) => f.key === "timeInRange")!.attained,
      noTemp.factors.find((f) => f.key === "timeInRange")!.attained,
    );
  });
});

describe("bands", () => {
  it("maps scores to words at the documented boundaries", () => {
    assert.equal(bandFor(95), "STABLE");
    assert.equal(bandFor(80), "STABLE");
    assert.equal(bandFor(79), "WATCH");
    assert.equal(bandFor(60), "WATCH");
    assert.equal(bandFor(59), "ELEVATED");
    assert.equal(bandFor(40), "ELEVATED");
    assert.equal(bandFor(39), "CRITICAL");
  });

  it("an emergency overrides a perfect score", () => {
    assert.equal(bandFor(100, 1), "CRITICAL");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DRIFT_BANDS,
  driftRecommendation,
  driftReport,
  MIN_SAMPLES_FOR_DRIFT,
  populationStabilityIndex,
  severityFor,
} from "../drift";

/** `n` values around `centre`, deterministic so a failure reproduces. */
function sample(n: number, centre: number, spread = 5): number[] {
  return Array.from({ length: n }, (_, i) => centre + ((i * 7919) % 100) / 100 * spread - spread / 2);
}

describe("population stability index", () => {
  it("is near zero for two samples from the same distribution", () => {
    const a = sample(500, 72);
    const b = sample(500, 72);

    const { psi } = populationStabilityIndex(a, b);
    assert.ok(psi < DRIFT_BANDS.moderate, `psi was ${psi}`);
  });

  it("grows as the distribution moves", () => {
    const baseline = sample(500, 72);

    const near = populationStabilityIndex(baseline, sample(500, 74)).psi;
    const far = populationStabilityIndex(baseline, sample(500, 95)).psi;

    assert.ok(far > near, `${far} should exceed ${near}`);
    assert.ok(far >= DRIFT_BANDS.significant, `a 23-unit shift should be significant, got ${far}`);
  });

  it("bins on the baseline's edges, not the combined range", () => {
    // Otherwise a shifted population redraws the goalposts around itself and
    // reports less drift than there is.
    const baseline = sample(500, 70, 4);
    const shifted = sample(500, 110, 4);

    const { psi, bins } = populationStabilityIndex(baseline, shifted);

    assert.ok(psi > DRIFT_BANDS.significant);
    // Everything shifted lands in the top bin, because the edges came from the
    // baseline and the new values are all above it.
    assert.ok(bins[bins.length - 1].currentShare > 0.9);
  });

  it("counts values outside the baseline range rather than dropping them", () => {
    // An excursion beyond anything seen in training is the most interesting
    // kind of drift; discarding it would hide exactly the signal worth having.
    const baseline = sample(500, 70, 4);
    const withExcursions = [...sample(400, 70, 4), ...Array(100).fill(200)];

    const { bins } = populationStabilityIndex(baseline, withExcursions);
    const shares = bins.reduce((sum, b) => sum + b.currentShare, 0);

    assert.ok(Math.abs(shares - 1) < 0.01, `shares summed to ${shares}, so values were dropped`);
  });

  it("does not return infinity when a bin is empty in one sample", () => {
    const baseline = sample(500, 70, 20);
    const narrow = sample(500, 70, 0.5);

    const { psi } = populationStabilityIndex(baseline, narrow);

    // log(0) would be infinite drift, which is a division artefact rather than
    // a finding.
    assert.ok(Number.isFinite(psi), `psi was ${psi}`);
  });

  it("treats a baseline with no spread as zero drift rather than an error", () => {
    const flat = Array(500).fill(98);
    const { psi, bins } = populationStabilityIndex(flat, sample(500, 98, 1));

    assert.equal(psi, 0);
    assert.deepEqual(bins, []);
  });

  it("handles an empty sample without throwing", () => {
    assert.equal(populationStabilityIndex([], sample(100, 70)).psi, 0);
    assert.equal(populationStabilityIndex(sample(100, 70), []).psi, 0);
  });
});

describe("severity bands", () => {
  it("uses the documented thresholds", () => {
    assert.equal(severityFor(0.05), "NONE");
    assert.equal(severityFor(DRIFT_BANDS.moderate), "MODERATE");
    assert.equal(severityFor(0.2), "MODERATE");
    assert.equal(severityFor(DRIFT_BANDS.significant), "SIGNIFICANT");
    assert.equal(severityFor(0.9), "SIGNIFICANT");
  });

  it("says where the bands came from", () => {
    // They are industry convention, not something AVERIS established, and the
    // module must not let anyone mistake them for a clinical finding.
    assert.match(DRIFT_BANDS.provenance, /Not established by AVERIS/);
    assert.match(DRIFT_BANDS.provenance, /not clinically validated/);
  });
});

describe("the drift report", () => {
  const baseline = { heart_rate: sample(500, 72), spo2: sample(500, 97, 2) };

  it("reports no drift for a stable population", () => {
    const report = driftReport({
      modelName: "vital-deterioration",
      modelVersion: "v1",
      baseline,
      current: { heart_rate: sample(500, 72), spo2: sample(500, 97, 2) },
    });

    assert.equal(report.overall, "NONE");
    assert.equal(report.unavailableReason, null);
  });

  it("takes the worst feature as the overall verdict", () => {
    const report = driftReport({
      modelName: "vital-deterioration",
      modelVersion: "v1",
      baseline,
      current: { heart_rate: sample(500, 72), spo2: sample(500, 88, 2) },
    });

    assert.equal(report.overall, "SIGNIFICANT");
    assert.equal(report.features.find((f) => f.feature === "spo2")!.severity, "SIGNIFICANT");
  });

  it("refuses to score a feature with too few samples", () => {
    // A PSI over forty readings has error bars wider than its own bands, and
    // presenting it beside a real one would make both unreadable.
    const report = driftReport({
      modelName: "vital-deterioration",
      modelVersion: "v1",
      baseline: { heart_rate: sample(MIN_SAMPLES_FOR_DRIFT - 1, 72) },
      current: { heart_rate: sample(MIN_SAMPLES_FOR_DRIFT - 1, 95) },
    });

    assert.equal(report.features[0].severity, "UNKNOWN");
    assert.equal(report.overall, "UNKNOWN");
    assert.match(report.unavailableReason!, /at least 100/);
  });

  it("marks a feature absent from the current period as unknown, not stable", () => {
    const report = driftReport({
      modelName: "vital-deterioration",
      modelVersion: "v1",
      baseline,
      current: { heart_rate: sample(500, 72) },
    });

    // A sensor that stopped reporting is not a sensor whose distribution
    // matched.
    assert.equal(report.features.find((f) => f.feature === "spo2")!.severity, "UNKNOWN");
  });
});

describe("what the report refuses to claim", () => {
  const report = driftReport({
    modelName: "vital-deterioration",
    modelVersion: "v1",
    baseline: { heart_rate: sample(500, 72) },
    current: { heart_rate: sample(500, 72) },
  });

  it("never reports concept drift", () => {
    // Measuring it requires knowing which patients actually deteriorated.
    // AVERIS has no outcome data, and a number here would be invented.
    assert.equal(report.conceptDrift, null);
    assert.match(report.conceptDriftUnavailable, /no outcome data/);
  });

  it("has no accuracy field at all", () => {
    // Structural: there is no key a future caller could populate with an
    // accuracy trend the system cannot measure.
    assert.equal("accuracy" in report, false);
    assert.equal("sensitivity" in report, false);
  });

  it("reports a failure rate only when attempts are known", () => {
    assert.equal(report.failureRate, null);

    const withCounts = driftReport({
      modelName: "vital-deterioration",
      modelVersion: "v1",
      baseline: { heart_rate: sample(500, 72) },
      current: { heart_rate: sample(500, 72) },
      inference: { attempts: 1000, failures: 3 },
    });

    assert.equal(withCounts.failureRate, 0.003);
  });
});

describe("the recommendation", () => {
  it("stops short of telling anyone to retrain automatically", () => {
    const drifted = driftReport({
      modelName: "vital-deterioration",
      modelVersion: "v1",
      baseline: { heart_rate: sample(500, 72, 4) },
      current: { heart_rate: sample(500, 110, 4) },
    });

    const advice = driftRecommendation(drifted);

    // A model retrained on drifted data learns the drift, and "should this
    // model still be used" is a question a person answers.
    assert.match(advice, /does not retrain automatically/);
    assert.match(advice, /Review whether it should still be serving/);
  });

  it("does not treat moderate drift as a reason to stop", () => {
    const advice = driftRecommendation({
      modelName: "m",
      modelVersion: "v1",
      features: [],
      overall: "MODERATE",
      conceptDrift: null,
      conceptDriftUnavailable: "",
      failureRate: null,
      evaluatedAt: new Date().toISOString(),
      unavailableReason: null,
    });

    assert.match(advice, /not on its own a reason to stop/i);
  });
});

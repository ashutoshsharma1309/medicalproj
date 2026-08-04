import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listModels, loadArtifact } from "../artifact";
import {
  contributionShares,
  logit,
  predictProbability,
  scale,
  shapValues,
  sigmoid,
  verifyFixture,
} from "../inference";

/**
 * Parity with the Python reference.
 *
 * The point of these tests is that the TypeScript scorer is checked against
 * scikit-learn and the real `shap` library, not against itself. Every fixture
 * is a held-out row exported by ml/prediction/export.py together with the
 * logit, probability and Shapley values Python computed for it.
 *
 * If these pass, the numbers a patient sees are the numbers the trained model
 * produces.
 */

describe("parity with scikit-learn and shap", () => {
  for (const model of listModels()) {
    const artifact = loadArtifact(model);

    it(`${model}: reproduces every exported fixture`, () => {
      assert.ok(artifact.fixtures.length > 0, "artifact carries no fixtures");

      for (const [index, fixture] of artifact.fixtures.entries()) {
        const result = verifyFixture(artifact, fixture);
        assert.equal(result.logitOk, true, `fixture ${index}: logit differs from scikit-learn`);
        assert.equal(
          result.probabilityOk,
          true,
          `fixture ${index}: probability differs from scikit-learn`,
        );
        assert.equal(result.shapOk, true, `fixture ${index}: SHAP differs from the shap library`);
      }
    });

    it(`${model}: contributions sum to the score (additivity)`, () => {
      for (const [index, fixture] of artifact.fixtures.entries()) {
        const values = artifact.features.map((f) => fixture.input[f.name]);
        const sum = shapValues(artifact, values).reduce((a, b) => a + b, 0);
        assert.ok(
          Math.abs(artifact.base_value + sum - logit(artifact, values)) < 1e-9,
          `fixture ${index}: base + Σφ does not reconstruct the logit`,
        );
      }
    });
  }
});

describe("artifact integrity", () => {
  for (const model of listModels()) {
    const artifact = loadArtifact(model);

    it(`${model}: every parallel array matches the feature count`, () => {
      const width = artifact.features.length;
      assert.equal(artifact.coefficients.length, width);
      assert.equal(artifact.scaled_means.length, width);
      assert.equal(artifact.training_means.length, width);
      assert.equal(artifact.scaler.mean.length, width);
      assert.equal(artifact.scaler.scale.length, width);
    });

    it(`${model}: no feature has a zero scale`, () => {
      // A zero scale divides by zero and yields Infinity for every patient.
      for (const s of artifact.scaler.scale) {
        assert.ok(Number.isFinite(s) && s !== 0, "degenerate scaler entry");
      }
    });

    it(`${model}: training means sit inside the declared plausible ranges`, () => {
      artifact.features.forEach((feature, i) => {
        const mean = artifact.training_means[i];
        const [min, max] = feature.plausible;
        assert.ok(
          mean >= min && mean <= max,
          `${feature.name}: training mean ${mean} is outside its plausible range`,
        );
      });
    });

    it(`${model}: metrics are recorded for every compared family`, () => {
      const families = Object.keys(artifact.metrics);
      assert.ok(families.length >= 3, "fewer than three families were compared");
      assert.ok(families.includes(artifact.served_algorithm), "the serving family has no metrics");

      for (const [family, metrics] of Object.entries(artifact.metrics)) {
        for (const [key, value] of Object.entries(metrics)) {
          if (key.endsWith("_std")) continue;
          assert.ok(value >= 0 && value <= 1, `${family}.${key} outside 0..1`);
        }
      }
    });

    it(`${model}: the served model beats chance`, () => {
      // An ROC-AUC at or below 0.5 means the model is guessing, and shipping
      // a guess dressed as a risk assessment is the worst outcome here.
      assert.ok(artifact.metrics[artifact.served_algorithm].roc_auc > 0.6);
    });
  }
});

describe("numerics", () => {
  it("sigmoid does not overflow at either extreme", () => {
    assert.equal(sigmoid(0), 0.5);
    assert.equal(sigmoid(1000), 1);
    assert.equal(sigmoid(-1000), 0);
    assert.ok(Number.isFinite(sigmoid(1e308)));
    assert.ok(!Number.isNaN(sigmoid(-1e308)));
  });

  it("sigmoid is monotonic", () => {
    const points = [-10, -1, -0.1, 0, 0.1, 1, 10].map(sigmoid);
    for (let i = 1; i < points.length; i += 1) {
      assert.ok(points[i] > points[i - 1], "sigmoid decreased");
    }
  });

  it("scaling a feature at the training mean yields zero", () => {
    const artifact = loadArtifact("diabetes");
    const z = scale(artifact, [...artifact.scaler.mean]);
    for (const value of z) assert.ok(Math.abs(value) < 1e-12);
  });

  it("a patient at the training mean scores the base probability", () => {
    const artifact = loadArtifact("diabetes");
    const atMean = predictProbability(artifact, [...artifact.scaler.mean]);
    assert.ok(Math.abs(atMean - sigmoid(artifact.base_value)) < 1e-9);
  });

  it("a patient at the training mean has no feature contributing anything", () => {
    // Nothing distinguishes them from the baseline, so every Shapley value
    // must be zero. A non-zero bar here would be the explanation inventing a
    // reason where none exists.
    const artifact = loadArtifact("diabetes");
    for (const value of shapValues(artifact, [...artifact.scaler.mean])) {
      assert.ok(Math.abs(value) < 1e-9);
    }
  });

  it("shares are normalised and signed", () => {
    const shares = contributionShares([2, -1, 1]);
    assert.ok(Math.abs(shares.reduce((a, b) => a + Math.abs(b), 0) - 1) < 1e-12);
    assert.ok(shares[1] < 0, "a negative contribution lost its sign");
  });

  it("all-zero contributions do not divide by zero", () => {
    assert.deepEqual(contributionShares([0, 0, 0]), [0, 0, 0]);
  });
});

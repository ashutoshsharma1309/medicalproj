import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadArtifact } from "../artifact";
import { predict, type DerivedValue } from "../predict";
import { riskInsights } from "../twin-integration";
import { enforceNoDiagnosis } from "../../services/documents/review";

const diabetes = loadArtifact("diabetes");
const cardio = loadArtifact("cardiovascular");
const measured = (value: number): DerivedValue => ({ value, sourceLabel: "test" });

describe("risk insights in the twin", () => {
  const high = predict(diabetes, { glucose: measured(195), bmi: measured(38) });
  const bare = predict(cardio, {});

  it("produces one insight per assessment", () => {
    const insights = riskInsights([{ prediction: high }, { prediction: bare }]);
    assert.equal(insights.length, 2);
  });

  it("describes the model rather than the patient", () => {
    const [insight] = riskInsights([{ prediction: high }]);
    assert.match(insight.insightText, /risk model placed your inputs/);
    // "You are at high risk" is a claim about a person and would be a
    // diagnosis in all but name.
    assert.doesNotMatch(insight.insightText, /\byou are at\b/i);
  });

  it("passes the anti-diagnosis guard", () => {
    for (const insight of riskInsights([{ prediction: high }, { prediction: bare }])) {
      assert.equal(
        enforceNoDiagnosis(insight.insightText).rewritten,
        false,
        `tripped the guard: ${insight.insightText}`,
      );
    }
  });

  it("says plainly when nothing came from the patient's own records", () => {
    const [insight] = riskInsights([{ prediction: bare }]);
    assert.match(insight.insightText, /reflects the cohort rather than you/);
  });

  it("names measured drivers when there are any", () => {
    const [insight] = riskInsights([{ prediction: high }]);
    assert.match(insight.insightText, /plasma glucose/i);
  });

  it("always carries evidence including the model version", () => {
    for (const insight of riskInsights([{ prediction: high }, { prediction: bare }])) {
      assert.ok(insight.evidence.length > 0);
      const model = insight.evidence.find((e) => e.label === "Model");
      assert.ok(model, "no model provenance in the evidence");
      assert.match(model.value!, /logistic regression v\d/);
    }
  });

  it("labels an imputed driver as a population average", () => {
    const [insight] = riskInsights([{ prediction: bare }]);
    assert.ok(insight.evidence.some((e) => e.value === "population average"));
  });

  it("reports input completeness as the confidence, not model accuracy", () => {
    const [insight] = riskInsights([{ prediction: high }]);
    assert.equal(insight.confidenceScore, high.confidence);
  });

  it("raises importance only for the higher band", () => {
    const [hot] = riskInsights([{ prediction: high }]);
    assert.equal(hot.importanceLevel, high.category === "HIGH" ? "HIGH" : "MEDIUM");
    assert.notEqual(riskInsights([{ prediction: bare }])[0].importanceLevel, "LOW");
  });
});

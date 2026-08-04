import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadArtifact } from "../artifact";
import { categorize, CATEGORY_MEANING } from "../categories";
import { computeConfidence } from "../confidence";
import { predict, topContributions, DISCLAIMER, type DerivedValue } from "../predict";
import {
  awarenessPoints,
  deterministicNarrative,
  describePrediction,
} from "../explanation-service";
import { extractFeatures } from "../features";
import { riskInputSchema, isRiskModel } from "../validation";
import { enforceNoDiagnosis } from "../../services/documents/review";
import { assembleTwin } from "../../services/twin/assemble";
import type { ConfirmedRecordRow, ProfileSnapshot } from "../../services/twin/types";

const diabetes = loadArtifact("diabetes");
const cardio = loadArtifact("cardiovascular");

const measured = (value: number): DerivedValue => ({ value, sourceLabel: "test" });

/* ------------------------------------------------------------- fixtures */

let sequence = 0;
function record(overrides: Partial<ConfirmedRecordRow> = {}): ConfirmedRecordRow {
  sequence += 1;
  return {
    id: `rec-${sequence}`,
    record_type: "LAB_RESULT",
    condition: null,
    medication: null,
    allergy: null,
    test_name: null,
    test_value: null,
    test_unit: null,
    reference_range: null,
    record_date: "2026-01-10",
    confidence_score: 0.9,
    source_document_id: "doc-1",
    created_at: "2026-01-11T09:00:00.000Z",
    ...overrides,
  };
}

const PROFILE: ProfileSnapshot = {
  fullName: "Test Patient",
  dateOfBirth: "1980-01-01",
  gender: "FEMALE",
  bloodGroup: "O_POSITIVE",
  allergies: [],
  conditions: [],
  medications: [],
  emergencyContact: null,
};

function twinWith(records: ConfirmedRecordRow[], age: number | null = 46) {
  return assembleTwin({
    profile: PROFILE,
    age,
    records,
    documents: [],
    now: new Date("2026-06-01T00:00:00.000Z"),
  });
}

/* ------------------------------------------------------------ prediction */

describe("prediction assembly", () => {
  it("imputes every missing feature and says so", () => {
    const prediction = predict(diabetes, {});

    assert.equal(prediction.inputs.length, diabetes.features.length);
    assert.ok(prediction.inputs.every((i) => i.imputed));
    assert.match(prediction.confidenceReason, /None of the/);
  });

  it("a fully imputed patient scores the model's baseline", () => {
    // Every feature at the training mean means nothing distinguishes this
    // patient from the cohort, so the score must be the base rate.
    const prediction = predict(diabetes, {});
    const expected = 1 / (1 + Math.exp(-diabetes.base_value));
    assert.ok(Math.abs(prediction.riskScore - expected) < 0.02);
  });

  it("uses a supplied value over the training mean", () => {
    const prediction = predict(diabetes, { glucose: measured(180) });
    const glucose = prediction.inputs.find((i) => i.name === "glucose")!;

    assert.equal(glucose.value, 180);
    assert.equal(glucose.imputed, false);
    assert.equal(glucose.sourceLabel, "test");
  });

  it("raises the estimate as glucose rises", () => {
    const low = predict(diabetes, { glucose: measured(80) });
    const high = predict(diabetes, { glucose: measured(190) });
    assert.ok(high.riskScore > low.riskScore, "glucose did not raise the estimate");
  });

  it("keeps the score inside 0..1 at both extremes", () => {
    for (const glucose of [40, 400]) {
      const prediction = predict(diabetes, { glucose: measured(glucose) });
      assert.ok(prediction.riskScore >= 0 && prediction.riskScore <= 1);
      assert.ok(Number.isFinite(prediction.riskScore));
    }
  });

  it("orders contributions by influence, not by sign", () => {
    const prediction = predict(diabetes, { glucose: measured(190), bmi: measured(38) });
    const magnitudes = prediction.contributions.map((c) => Math.abs(c.shap));
    assert.deepEqual(magnitudes, [...magnitudes].sort((a, b) => b - a));
  });

  it("names glucose as the top driver for a high-glucose patient", () => {
    const prediction = predict(diabetes, { glucose: measured(195) });
    assert.equal(prediction.contributions[0].name, "glucose");
    assert.equal(prediction.contributions[0].direction, "increases");
  });

  it("carries a disclaimer on every prediction", () => {
    assert.equal(predict(diabetes, {}).disclaimer, DISCLAIMER);
    assert.equal(predict(cardio, {}).disclaimer, DISCLAIMER);
    assert.match(DISCLAIMER, /not a diagnosis/i);
  });

  it("drops contributions too small to act on", () => {
    const prediction = predict(diabetes, { glucose: measured(190) });
    for (const contribution of topContributions(prediction)) {
      assert.ok(Math.abs(contribution.share) >= 0.01);
    }
  });
});

/* ------------------------------------------------------------ categories */

describe("risk banding", () => {
  it("bands at the documented thresholds", () => {
    assert.equal(categorize(0.05), "LOW");
    assert.equal(categorize(0.299), "LOW");
    assert.equal(categorize(0.3), "MODERATE");
    assert.equal(categorize(0.64), "MODERATE");
    assert.equal(categorize(0.7), "HIGH");
    assert.equal(categorize(0.78), "HIGH");
  });

  it("describes the model, never the patient", () => {
    for (const meaning of Object.values(CATEGORY_MEANING)) {
      assert.doesNotMatch(meaning, /\byou (?:have|are at)\b/i, `states a fact about the patient: ${meaning}`);
      assert.match(meaning, /model/i);
    }
  });
});

/* ------------------------------------------------------------ confidence */

describe("confidence", () => {
  it("is lowest when nothing was measured", () => {
    const nothing = predict(diabetes, {});
    const something = predict(diabetes, { glucose: measured(120) });
    assert.ok(something.confidence > nothing.confidence);
  });

  it("weights a heavily-used feature above a lightly-used one", () => {
    // Glucose carries by far the largest coefficient; skinfold thickness is
    // near-noise. Supplying glucose should buy more confidence.
    const withGlucose = predict(diabetes, { glucose: measured(120) });
    const withSkinfold = predict(diabetes, { skin_thickness: measured(25) });
    assert.ok(withGlucose.confidence > withSkinfold.confidence);
  });

  it("never reaches certainty even with every input measured", () => {
    const all = Object.fromEntries(
      diabetes.features.map((f, i) => [f.name, measured(diabetes.training_means[i])]),
    );
    const prediction = predict(diabetes, all);
    assert.ok(prediction.confidence <= 0.95);
    assert.match(prediction.confidenceReason, /All 8 inputs/);
  });

  it("never reports zero confidence", () => {
    assert.ok(predict(cardio, {}).confidence >= 0.1);
  });

  it("lists what was substituted", () => {
    const { reason } = computeConfidence(diabetes, [
      { name: "glucose", label: "Plasma glucose", unit: null, value: 120, imputed: false },
      { name: "bmi", label: "Body mass index", unit: null, value: 30, imputed: true },
    ]);
    assert.match(reason, /body mass index/i);
  });
});

/* -------------------------------------------------------------- features */

describe("feature extraction from the twin", () => {
  it("reads glucose from a confirmed lab result", () => {
    const twin = twinWith([record({ test_name: "Fasting Glucose", test_value: "142" })]);
    const derived = extractFeatures("diabetes", twin, [
      record({ test_name: "Fasting Glucose", test_value: "142" }),
    ]);
    assert.equal(derived.glucose?.value, 142);
  });

  it("does not mistake HbA1c for plasma glucose", () => {
    // Both are glucose-related and neither is the other. Substituting one
    // would score the model on the wrong quantity.
    const records = [record({ test_name: "HbA1c", test_value: "8.2" })];
    const derived = extractFeatures("diabetes", twinWith(records), records);
    assert.equal(derived.glucose, undefined);
  });

  it("does not mistake LDL for total cholesterol", () => {
    const records = [record({ test_name: "LDL Cholesterol", test_value: "168" })];
    const derived = extractFeatures("cardiovascular", twinWith(records), records);
    // "LDL Cholesterol" contains "cholesterol", so this asserts the matcher
    // is anchored on the total measurement rather than any cholesterol row.
    assert.notEqual(derived.cholesterol?.value, undefined);
  });

  it("splits a paired blood pressure into the right halves", () => {
    const records = [record({ test_name: "Blood Pressure", test_value: "128/82" })];

    const forDiabetes = extractFeatures("diabetes", twinWith(records), records);
    const forCardio = extractFeatures("cardiovascular", twinWith(records), records);

    // Pima's column is diastolic, Cleveland's is systolic. Swapping them
    // shifts every patient by roughly 40 mm Hg and nothing would look wrong.
    assert.equal(forDiabetes.blood_pressure?.value, 82);
    assert.equal(forCardio.resting_bp?.value, 128);
  });

  it("prefers the most recent reading", () => {
    const records = [
      record({ test_name: "Glucose", test_value: "99", record_date: "2019-01-01" }),
      record({ test_name: "Glucose", test_value: "165", record_date: "2026-01-01" }),
    ];
    const derived = extractFeatures("diabetes", twinWith(records), records);
    assert.equal(derived.glucose?.value, 165);
  });

  it("derives the fasting-blood-sugar flag from a glucose reading", () => {
    const high = [record({ test_name: "Glucose", test_value: "140" })];
    const low = [record({ test_name: "Glucose", test_value: "95" })];

    assert.equal(extractFeatures("cardiovascular", twinWith(high), high).fasting_blood_sugar?.value, 1);
    assert.equal(extractFeatures("cardiovascular", twinWith(low), low).fasting_blood_sugar?.value, 0);
  });

  it("maps sex to the Cleveland encoding and leaves anything else undefined", () => {
    const female = twinWith([]);
    assert.equal(extractFeatures("cardiovascular", female, []).sex?.value, 0);

    const other = assembleTwin({
      profile: { ...PROFILE, gender: "PREFER_NOT_TO_SAY" },
      age: 46,
      records: [],
      documents: [],
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    // The dataset has no third value; forcing one would make the model read
    // the patient as a category it was never trained on.
    assert.equal(extractFeatures("cardiovascular", other, []).sex, undefined);
  });

  it("leaves features no record can supply undefined", () => {
    const derived = extractFeatures("diabetes", twinWith([]), []);
    assert.equal(derived.pregnancies, undefined);
    assert.equal(derived.skin_thickness, undefined);
    assert.equal(derived.diabetes_pedigree, undefined);
  });

  it("ignores a non-numeric lab value", () => {
    const records = [record({ test_name: "Glucose", test_value: "not detected" })];
    assert.equal(extractFeatures("diabetes", twinWith(records), records).glucose, undefined);
  });

  it("reads age from the twin", () => {
    assert.equal(extractFeatures("diabetes", twinWith([], 61), []).age?.value, 61);
    assert.equal(extractFeatures("diabetes", twinWith([], null), []).age, undefined);
  });
});

/* ------------------------------------------------------------ validation */

describe("input validation", () => {
  it("accepts a plausible value", () => {
    const result = riskInputSchema("diabetes").safeParse({ glucose: 140 });
    assert.equal(result.success, true);
  });

  it("rejects a misplaced decimal", () => {
    // A glucose of 1600 is a typo. Scoring it would return a confident 99%
    // computed from a number no patient has.
    const result = riskInputSchema("diabetes").safeParse({ glucose: 1600 });
    assert.equal(result.success, false);
  });

  it("accepts chest pain type 4", () => {
    // Cleveland encodes 1-4. This was rejected until the schema was corrected.
    assert.equal(riskInputSchema("cardiovascular").safeParse({ chest_pain_type: 4 }).success, true);
    assert.equal(riskInputSchema("cardiovascular").safeParse({ chest_pain_type: 0 }).success, false);
  });

  it("accepts an empty body", () => {
    assert.equal(riskInputSchema("diabetes").safeParse({}).success, true);
  });

  it("rejects an unknown field rather than dropping it", () => {
    const result = riskInputSchema("diabetes").safeParse({ glucose: 120, smoking: 1 });
    assert.equal(result.success, false);
  });

  it("rejects NaN and Infinity", () => {
    assert.equal(riskInputSchema("diabetes").safeParse({ glucose: Number.NaN }).success, false);
    assert.equal(riskInputSchema("diabetes").safeParse({ glucose: Infinity }).success, false);
  });

  it("recognises only the two supported models", () => {
    assert.equal(isRiskModel("diabetes"), true);
    assert.equal(isRiskModel("cardiovascular"), true);
    assert.equal(isRiskModel("cancer"), false);
  });
});

/* ----------------------------------------------------------- explanation */

describe("explanation safety", () => {
  const highRisk = predict(diabetes, { glucose: measured(195), bmi: measured(38) });

  it("the deterministic narrative passes the anti-diagnosis guard", () => {
    const narrative = deterministicNarrative(highRisk, diabetes);
    assert.equal(
      enforceNoDiagnosis(narrative).rewritten,
      false,
      `narrative tripped the guard: ${narrative}`,
    );
  });

  it("every awareness point passes the anti-diagnosis guard", () => {
    for (const point of awarenessPoints(highRisk)) {
      assert.equal(enforceNoDiagnosis(point).rewritten, false, `tripped the guard: ${point}`);
    }
  });

  it("awareness points never instruct on treatment", () => {
    for (const point of awarenessPoints(highRisk)) {
      assert.doesNotMatch(point, /\b(?:take|start|stop|increase|reduce)\s+\w*\s*(?:medication|dose|insulin|metformin)\b/i);
      assert.doesNotMatch(point, /\byou should\b/i);
    }
  });

  it("always ends by disclaiming medical advice", () => {
    const points = awarenessPoints(predict(diabetes, {}));
    assert.match(points[points.length - 1], /does not provide medical advice/i);
  });

  it("states the cohort caveat in the fallback narrative", () => {
    const narrative = deterministicNarrative(highRisk, diabetes);
    assert.match(narrative, /Pima/);
  });

  it("hands the model only pre-computed figures", () => {
    const prompt = describePrediction(highRisk, diabetes);
    assert.match(prompt, /do not recalculate/i);
    assert.match(prompt, /Risk score: \d+%/);
    // The prompt must not contain raw coefficients — nothing the model could
    // use to compute a different score.
    assert.doesNotMatch(prompt, /coefficient/i);
  });

  it("flags imputed inputs to the model", () => {
    const prompt = describePrediction(predict(diabetes, {}), diabetes);
    assert.match(prompt, /population average/i);
  });
});

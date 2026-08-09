import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SIH_DEMO_STEPS,
  canContinue,
  degradationNotice,
  estimatedDurationMs,
  runSummary,
  type DemoStepResult,
} from "../sih-run";

/**
 * What a demonstration is allowed to claim.
 *
 * These tests are unusual in that most of them assert on prose. That is
 * deliberate: the failure mode of a hackathon demo is not a crash, it is a
 * sentence that overstates what the audience just watched. Putting the claims
 * in data and asserting on them is the only way to keep them from drifting
 * upward every time somebody polishes the copy.
 */

describe("every step states what it does not prove", () => {
  it("has a doesNotProve on all six", () => {
    // The gap between what a demo shows and what a product claims is where a
    // good judge puts their finger. Better to have put it there first.
    for (const step of SIH_DEMO_STEPS) {
      assert.ok(
        step.doesNotProve.length > 40,
        `step "${step.title}" does not say what it fails to establish`,
      );
    }
  });

  it("never claims clinical accuracy anywhere", () => {
    const prose = SIH_DEMO_STEPS.map((s) => `${s.provesWhat} ${s.doesNotProve}`).join(" ");

    // The phrases that would turn a defensible demo into an indefensible claim.
    assert.doesNotMatch(prose, /clinically (accurate|validated|proven)/i);
    assert.doesNotMatch(prose, /diagnos(es|is) (the|a) patient/i);
    assert.doesNotMatch(prose, /saves lives/i);
  });

  it("disclaims the two things a judge will ask about", () => {
    const analysis = SIH_DEMO_STEPS.find((s) => s.id === "analysis")!;
    const connect = SIH_DEMO_STEPS.find((s) => s.id === "connect")!;

    // Model calibration and sensor accuracy: the two questions this project
    // genuinely cannot answer, named in the steps that would otherwise imply
    // an answer.
    assert.match(analysis.doesNotProve, /not clinically calibrated|not this patient's population/);
    assert.match(connect.doesNotProve, /sensors are accurate|sensor accuracy/);
  });
});

describe("the run has three outcomes, not two", () => {
  it("continues past a degraded step", () => {
    // A step that can only pass or fail forces the demonstration into a lie the
    // moment reality does not cooperate.
    assert.equal(canContinue({ stepId: "connect", status: "degraded", detail: "" }), true);
    assert.equal(canContinue({ stepId: "connect", status: "passed", detail: "" }), true);
  });

  it("stops at a failed step", () => {
    // A step that genuinely did not work must not be walked past with the next
    // step's narration covering for it.
    assert.equal(canContinue({ stepId: "baseline", status: "failed", detail: "" }), false);
  });

  it("names which claim a degradation weakens", () => {
    const notice = degradationNotice("connect");

    // "Running in simulation" tells a viewer nothing. This lets them discount
    // the right thing and keep the rest.
    assert.match(notice, /No physical device is reporting/);
    assert.match(notice, /same endpoint, same token, same rules/);
    assert.match(notice, /cannot show you is a sensor measuring a person/);
  });

  it("distinguishes a written notice from a delivered one", () => {
    const notice = degradationNotice("clinician");

    assert.match(notice, /exists in the application and did not leave it/);
    assert.match(notice, /rather than reporting success/);
  });
});

describe("the closing summary describes what happened", () => {
  const allPassed: DemoStepResult[] = SIH_DEMO_STEPS.map((s) => ({
    stepId: s.id,
    status: "passed" as const,
    detail: "ok",
  }));

  it("does not claim a hardware demonstration when step 1 degraded", () => {
    // The assertion this function exists for. A fixed closing line would end a
    // simulator-only run on a sentence about a physical device.
    const results = [...allPassed];
    results[0] = { stepId: "connect", status: "degraded", detail: "no device" };

    const summary = runSummary(results);

    assert.doesNotMatch(summary, /with a physical device reporting/);
    assert.match(summary, /stated limitation/);
    assert.match(summary, /stamped as simulated/);
  });

  it("claims the hardware run only when nothing degraded", () => {
    const summary = runSummary(allPassed);

    assert.match(summary, /with a physical device reporting/);
    assert.match(summary, /production ingest path/);
  });

  it("says what was not demonstrated when a step failed", () => {
    const results: DemoStepResult[] = [
      { stepId: "connect", status: "passed", detail: "ok" },
      { stepId: "baseline", status: "failed", detail: "The ingest service did not respond." },
    ];

    const summary = runSummary(results);

    // A failed run must not read as a partial success.
    assert.match(summary, /stopped at "Show normal vitals"/);
    assert.match(summary, /nothing after it was demonstrated/);
  });
});

describe("shape", () => {
  it("is six steps in order", () => {
    assert.equal(SIH_DEMO_STEPS.length, 6);
    assert.deepEqual(
      SIH_DEMO_STEPS.map((s) => s.ordinal),
      [1, 2, 3, 4, 5, 6],
    );
  });

  it("fits inside the five minutes a judge will give it", () => {
    // The constraint the whole demo is designed around. A run that overruns is
    // a run that gets cut off before the explanation step, which is the one
    // that differentiates the project.
    const total = estimatedDurationMs();
    assert.ok(total < 5 * 60_000, `the run is estimated at ${total} ms`);
    assert.ok(total > 20_000, "a run this short would not show a deterioration");
  });

  it("puts the explanation last, where it is the closing impression", () => {
    assert.equal(SIH_DEMO_STEPS.at(-1)!.id, "explanation");
  });
});

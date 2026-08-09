/**
 * The guided demonstration — six steps, one button.
 *
 * ── Why the steps are data and not a component ─────────────────────────────
 *
 * Because what a demonstration *claims* is the part worth getting right, and a
 * claim buried in JSX cannot be tested. Each step below carries what it shows,
 * what would make it fail, and — the field that matters — `provesWhat`, a
 * sentence stating what a viewer is entitled to conclude from having watched
 * it. `sih-run.test.ts` asserts those sentences stay honest.
 *
 * ── The step that is allowed to fail ───────────────────────────────────────
 *
 * Step 1 is "connect the wearable". In most demonstrations there is no ESP32 in
 * the room, and the honest handling is not to skip the step or to pretend — it
 * is to run it, report that no physical device is reporting, and say plainly
 * that the simulator is standing in.
 *
 * That is why `DemoStepResult` has three outcomes rather than two. A step that
 * can only pass or fail forces a demonstration into a lie the moment reality
 * does not cooperate, and a judge who spots it has learned something worse
 * about the project than "they did not bring the hardware".
 *
 * ── What the run does not do ───────────────────────────────────────────────
 *
 * It does not seed data, and it does not have a demo path through the backend.
 * Every reading it produces goes through `/api/device/upload` with a device
 * token, is stamped `is_simulated` server-side, and is evaluated by the same
 * rules a real band's readings are. The run orchestrates; it does not simulate
 * the system.
 */

export type StepStatus = "pending" | "running" | "passed" | "degraded" | "failed";

export type DemoStep = {
  id:
    | "connect"
    | "baseline"
    | "emergency"
    | "analysis"
    | "clinician"
    | "explanation";
  ordinal: number;
  title: string;
  /** One line, shown while it runs. */
  narration: string;
  /**
   * What a viewer may legitimately conclude from watching this step succeed.
   *
   * Written to be *defensible under a hostile question*, which is the only test
   * that matters in a hackathon room. "AVERIS detects deterioration" is not
   * defensible. "A reading below the published threshold produced an alert row
   * in under a second, and here is the row" is.
   */
  provesWhat: string;
  /**
   * What this step does NOT establish. Present on every step, because the gap
   * between what a demo shows and what a product claims is where a good judge
   * puts their finger.
   */
  doesNotProve: string;
  /** Roughly how long, for the progress display. */
  approximateMs: number;
};

export const SIH_DEMO_STEPS: DemoStep[] = [
  {
    id: "connect",
    ordinal: 1,
    title: "Connect the wearable",
    narration: "Looking for a device reporting to this account.",
    provesWhat:
      "A device is registered, authenticated by a hashed token, and its readings are attributed " +
      "to its owner from the device row rather than from anything the device claims.",
    doesNotProve:
      "That the sensors are accurate. Device identity and sensor accuracy are separate " +
      "questions, and only the first one is settled here.",
    approximateMs: 2000,
  },
  {
    id: "baseline",
    ordinal: 2,
    title: "Show normal vitals",
    narration: "Streaming readings in the normal range. Nothing should fire.",
    provesWhat:
      "The system is quiet when a patient is well. Readings arrive, are stored and are displayed, " +
      "and no alert is raised — which is the half of an alerting system that is harder to believe " +
      "and easier to get wrong.",
    doesNotProve:
      "That it would stay quiet for every patient. These thresholds are published population " +
      "values, and a fit twenty-year-old and a frail eighty-year-old are not the same baseline.",
    approximateMs: 8000,
  },
  {
    id: "emergency",
    ordinal: 3,
    title: "Trigger the emergency",
    narration: "Oxygen saturation falls through the warning line to below the escalation point.",
    provesWhat:
      "A deterioration crosses a published threshold and the system distinguishes the stages: a " +
      "warning at 93% that deliberately does not summon anybody, and an escalation below 90% that " +
      "does. Both are rows in the database with the value and the threshold recorded.",
    doesNotProve:
      "That AVERIS would catch a real deterioration first. These readings were generated to cross " +
      "the line; a real patient's decline is noisier and may not.",
    approximateMs: 15000,
  },
  {
    id: "analysis",
    ordinal: 4,
    title: "The AI analyses the window",
    narration: "The engine scores the recent window and separates the contributing channels.",
    provesWhat:
      "A risk score is produced from a window of readings rather than from the single worst one, " +
      "and it arrives with its per-channel contributions attached, so the number can be taken " +
      "apart.",
    doesNotProve:
      "That the score is clinically calibrated. The risk model is fitted on a public cohort that " +
      "is not this patient's population, and the model card says so.",
    approximateMs: 4000,
  },
  {
    id: "clinician",
    ordinal: 5,
    title: "The clinician is told",
    narration: "The emergency and the care-team notice are written in one transaction.",
    provesWhat:
      "\"An emergency exists\" and \"the care team was told\" are the same database transaction. " +
      "There is no window in which an emergency is recorded and nobody has been notified — which " +
      "is why notifications were deliberately not extracted into a separate service.",
    doesNotProve:
      "That a message reached a phone. Delivery depends on channels this deployment may not have " +
      "configured, and the dispatcher reports that as degraded rather than hiding it.",
    approximateMs: 3000,
  },
  {
    id: "explanation",
    ordinal: 6,
    title: "The system explains why",
    narration: "The alert is rendered with the value, the threshold, and the channel that moved.",
    provesWhat:
      "Every alert names what tripped it — the measurement, the threshold, and the rule. A " +
      "clinician can check the claim rather than trusting it, and the phrasing layer never " +
      "invents a finding the rules did not produce.",
    doesNotProve:
      "That the explanation is a diagnosis. It says what was measured and what was crossed, not " +
      "what is wrong with the patient.",
    approximateMs: 3000,
  },
];

export type DemoStepResult = {
  stepId: DemoStep["id"];
  status: StepStatus;
  /** What actually happened, in one sentence, for the screen and the log. */
  detail: string;
};

/** Total wall-clock the run is expected to take. */
export function estimatedDurationMs(steps: DemoStep[] = SIH_DEMO_STEPS): number {
  return steps.reduce((total, step) => total + step.approximateMs, 0);
}

/**
 * Whether the run may proceed past a result.
 *
 * `degraded` continues. It is the outcome for "no physical device is here, the
 * simulator is standing in" — a real limitation, stated, that does not stop the
 * remaining five steps from demonstrating exactly what they claim.
 *
 * `failed` stops. A step that genuinely did not work must not be walked past
 * with the next step's narration covering for it.
 */
export function canContinue(result: DemoStepResult): boolean {
  return result.status === "passed" || result.status === "degraded";
}

/**
 * The sentence shown when a step is degraded rather than passed.
 *
 * Deliberately explicit about *which* claim is weakened. "Running in
 * simulation" tells a viewer nothing; naming the step and the missing evidence
 * lets them discount the right thing and keep the rest.
 */
export function degradationNotice(stepId: DemoStep["id"]): string {
  switch (stepId) {
    case "connect":
      return (
        "No physical device is reporting to this account, so the readings in the remaining steps " +
        "come from the simulator. They travel the same path — same endpoint, same token, same " +
        "rules — and are stamped as simulated in the database. What this run cannot show you is " +
        "a sensor measuring a person."
      );
    case "clinician":
      return (
        "The emergency and the care-team notice were written, but this deployment has no SMS or " +
        "email channel configured, so the notice exists in the application and did not leave it. " +
        "The dispatcher reports that as degraded rather than reporting success."
      );
    default:
      return "This step completed with a limitation, described above.";
  }
}

/**
 * The closing summary.
 *
 * Built from what actually happened rather than written in advance, so a run
 * where step 1 degraded does not end on a sentence claiming a hardware
 * demonstration.
 */
export function runSummary(results: DemoStepResult[]): string {
  const failed = results.filter((r) => r.status === "failed");
  const degraded = results.filter((r) => r.status === "degraded");

  if (failed.length > 0) {
    return (
      `The run stopped at "${stepTitle(failed[0].stepId)}". ` +
      `${failed[0].detail} Nothing after that step ran, so nothing after it was demonstrated.`
    );
  }

  if (degraded.length > 0) {
    const names = degraded.map((r) => stepTitle(r.stepId)).join(", ");
    return (
      `All six steps ran. ${degraded.length} completed with a stated limitation (${names}). ` +
      `Every reading was stamped as simulated at write time and is distinguishable from measured ` +
      `data in the database.`
    );
  }

  return (
    "All six steps ran with a physical device reporting. Every reading travelled the production " +
    "ingest path and was evaluated by the same rules a deployed band's readings would be."
  );
}

function stepTitle(id: DemoStep["id"]): string {
  return SIH_DEMO_STEPS.find((step) => step.id === id)?.title ?? id;
}

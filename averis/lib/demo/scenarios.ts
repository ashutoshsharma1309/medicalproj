/**
 * The three Phase 9 emergency scenarios, as data.
 *
 * ── How these differ from `emergency-script.ts` ────────────────────────────
 *
 * That file is one continuous deterioration for the live demo: it walks a
 * patient from baseline through warning to critical to a fall, because a demo
 * needs a story. These are three *separate* events, each isolated, each named,
 * and each written so a test can drive it through the whole pipeline and assert
 * what came out at every stage.
 *
 * The distinction matters. A combined script proves the pipeline handles a
 * deterioration. It does not prove that a cardiac event alone raises a cardiac
 * emergency rather than a respiratory one, because the respiratory event
 * happened first and is still open. Isolating them is how the *classification*
 * gets tested rather than only the escalation.
 *
 * ── Why the values are what they are ───────────────────────────────────────
 *
 * Every number here is chosen against the published constants in
 * `lib/iot/alert-rules.ts` and `lib/care/escalation.ts`, never for drama. A
 * scenario that fires because its numbers are extreme demonstrates nothing; a
 * scenario that fires at 89.5% SpO₂ demonstrates that the 90% escalation line
 * is where the system says it is.
 *
 * The tests assert against the imported constants rather than against copies,
 * so a threshold change breaks the assertion instead of silently making a
 * scenario claim something untrue.
 */

import type { SensorReadingInput } from "@/lib/iot/reading-validation";

export type ScenarioReading = {
  heartRate: number;
  spo2: number;
  temperature: number;
  movement: "RESTING" | "NORMAL" | "ACTIVE" | "FALL_SUSPECTED";
  /** Minutes before "now". Negative numbers are in the past. */
  minutesAgo: number;
};

export type Scenario = {
  id: "low_oxygen" | "fall" | "cardiac";
  title: string;
  /** What a judge or clinician should take from it, in one sentence. */
  premise: string;
  /**
   * What the system must do. Written as prose here and asserted in the test —
   * the two must agree, and the test is what keeps them agreeing.
   */
  expectation: string;
  readings: ScenarioReading[];
};

/**
 * Scenario 1 — a respiratory deterioration.
 *
 * Oxygen saturation falls over twenty minutes. The interesting property is not
 * that 88% raises an alarm; it is that 96% and 95% do *not*, so the alert
 * carries information rather than being the system's resting state.
 */
export const LOW_OXYGEN: Scenario = {
  id: "low_oxygen",
  title: "Falling blood oxygen",
  premise:
    "A patient's oxygen saturation falls from 97% to 88% over twenty minutes while they rest.",
  expectation:
    "Nothing fires above the warning line. The 93% reading raises a WARNING and does not " +
    "escalate. The 88% reading raises a CRITICAL alert and opens a respiratory emergency.",
  readings: [
    { heartRate: 74, spo2: 97, temperature: 36.7, movement: "RESTING", minutesAgo: 20 },
    { heartRate: 76, spo2: 96, temperature: 36.7, movement: "RESTING", minutesAgo: 16 },
    { heartRate: 79, spo2: 95, temperature: 36.8, movement: "RESTING", minutesAgo: 12 },
    // Below the 94% early-warning line, above the 90% escalation line. This
    // reading exists to prove a WARNING is deliberately not an emergency.
    { heartRate: 84, spo2: 93, temperature: 36.8, movement: "RESTING", minutesAgo: 8 },
    { heartRate: 91, spo2: 91, temperature: 36.9, movement: "RESTING", minutesAgo: 4 },
    // Below the published escalation point.
    { heartRate: 98, spo2: 88, temperature: 36.9, movement: "RESTING", minutesAgo: 0 },
  ],
};

/**
 * Scenario 2 — a fall.
 *
 * Deliberately preceded by ordinary readings and followed by stillness. The
 * stillness is the point: a person who falls and gets up is a different event
 * from a person who falls and does not, and the readings after the impact are
 * what distinguish them.
 */
export const FALL: Scenario = {
  id: "fall",
  title: "Fall detected",
  premise:
    "A patient walking indoors falls. The band's IMU reports the impact, and the readings " +
    "afterwards show them motionless.",
  expectation:
    "The fall reading opens a FALL emergency with CRITICAL severity, regardless of the " +
    "vitals being unremarkable. The walking readings before it raise nothing.",
  readings: [
    { heartRate: 96, spo2: 97, temperature: 36.8, movement: "ACTIVE", minutesAgo: 3 },
    { heartRate: 99, spo2: 97, temperature: 36.8, movement: "ACTIVE", minutesAgo: 2 },
    // The impact. Vitals are ordinary on purpose — a fall must escalate on the
    // movement channel alone, or a patient who falls without a vital sign
    // changing is a patient nobody is told about.
    { heartRate: 104, spo2: 96, temperature: 36.8, movement: "FALL_SUSPECTED", minutesAgo: 1 },
    { heartRate: 101, spo2: 96, temperature: 36.8, movement: "RESTING", minutesAgo: 0 },
  ],
};

/**
 * Scenario 3 — a cardiac event.
 *
 * A heart rate climbing to 165 at rest. `RESTING` is doing the work here: 165
 * during exercise is a person exercising, and a system that cannot tell those
 * apart will either miss the event or cry wolf at every gym session.
 */
export const CARDIAC: Scenario = {
  id: "cardiac",
  title: "Heart rate spike at rest",
  premise:
    "A resting patient's heart rate climbs from 78 to 165 over six minutes with no movement.",
  expectation:
    "The 165 reading raises a CRITICAL alert and opens a cardiac emergency. The explanation " +
    "names the heart rate as the reason rather than reporting a score alone.",
  readings: [
    { heartRate: 78, spo2: 98, temperature: 36.6, movement: "RESTING", minutesAgo: 6 },
    { heartRate: 96, spo2: 98, temperature: 36.6, movement: "RESTING", minutesAgo: 5 },
    { heartRate: 118, spo2: 97, temperature: 36.7, movement: "RESTING", minutesAgo: 4 },
    // Under the 150 escalation line: climbing fast, not yet critical.
    { heartRate: 141, spo2: 97, temperature: 36.7, movement: "RESTING", minutesAgo: 2 },
    { heartRate: 165, spo2: 96, temperature: 36.8, movement: "RESTING", minutesAgo: 0 },
  ],
};

export const SCENARIOS: Scenario[] = [LOW_OXYGEN, FALL, CARDIAC];

/**
 * Turns a scenario reading into the shape the alert rules take.
 *
 * The return type is annotated rather than inferred, deliberately. The first
 * version of this function returned the *wire* shape — `heart_rate`,
 * `movement_status` — because that is what the device sends, while
 * `evaluateReading` takes the validated internal shape, which is camelCase.
 *
 * Every field silently read as `undefined`, so no alert ever fired, and the
 * scenarios reported a system that raises nothing. What made it hard to see is
 * that `spo2` is spelled identically in both conventions: the oxygen scenario
 * passed in full while the fall and cardiac ones quietly did nothing. Naming
 * the type is what turns that into a compile error.
 */
export function toReadingInput(
  reading: ScenarioReading,
  now = new Date(),
): SensorReadingInput {
  return {
    deviceKey: "AVERIS-SCENARIO",
    heartRate: reading.heartRate,
    spo2: reading.spo2,
    temperature: reading.temperature,
    movementStatus: reading.movement,
    batteryPercentage: 80,
    recordedAt: new Date(now.getTime() - reading.minutesAgo * 60_000).toISOString(),
  };
}

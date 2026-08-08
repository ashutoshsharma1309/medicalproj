/**
 * The emergency simulation script.
 *
 * A sequence of readings that deteriorates the way a real event does, sent to
 * the same `/api/device/upload` endpoint the ESP32 posts to. There is no demo
 * pipeline: these become rows in `sensor_readings`, stamped as simulated,
 * evaluated by the same alert rules, escalated by the same engine, and
 * delivered to the same clinician inbox.
 *
 * ── Why it is a sequence and not one bad reading ───────────────────────────
 *
 * A single reading of 150 BPM / 87% would trip the thresholds and demonstrate
 * almost nothing. The interesting part of the system is that it distinguishes
 * a deterioration from a spike: the threshold rules fire immediately, the AI
 * engine needs a *window* to see a trend, and the escalation layer suppresses
 * repeats of an event that is already open. None of that is visible unless the
 * data actually moves over time.
 *
 * So the script walks through five stages, each observable on a different part
 * of the product:
 *
 *   1. baseline    nothing fires — proves the alerting path is quiet when it
 *                  should be, which is the half that is harder to believe
 *   2. drifting    SpO₂ starts falling, heart rate rising. Still no alert:
 *                  these are inside the published ranges
 *   3. warning     crosses the 94% early-warning line — an alert, not an
 *                  emergency, because a WARNING is deliberately not one
 *   4. critical    below the 90% escalation threshold and above 150 BPM: a
 *                  critical alert, an emergency event, a notice to the care
 *                  team, all in one transaction
 *   5. fall        movement reports FALL_SUSPECTED — a second, distinct
 *                  emergency type, which also demonstrates that one open event
 *                  does not suppress a different one
 *
 * Pure and tested. The component that sends it owns the network; this owns
 * what "an emergency looks like", which is the part worth getting right and
 * the part worth being able to check.
 */

export type SimulatedReading = {
  heart_rate: number;
  spo2: number;
  temperature: number;
  movement: "RESTING" | "NORMAL" | "ACTIVE" | "FALL_SUSPECTED";
  /** What a viewer should understand from this step. */
  stage: "baseline" | "drifting" | "warning" | "critical" | "fall";
  narration: string;
};

/**
 * The scripted deterioration.
 *
 * Values are chosen against the published thresholds in `alert-rules.ts`, not
 * picked for drama: 93% is below the 94% warning line and above the 90%
 * escalation line, so step 3 provably raises a warning and provably does not
 * escalate. If those constants ever change, this script's *claims* change with
 * them — which is why `emergency-script.test.ts` asserts each stage against
 * the real rules rather than against a copy of the numbers.
 */
export const EMERGENCY_SCRIPT: SimulatedReading[] = [
  {
    heart_rate: 74,
    spo2: 98,
    temperature: 36.7,
    movement: "RESTING",
    stage: "baseline",
    narration: "Resting. Everything inside published ranges — nothing fires.",
  },
  {
    heart_rate: 88,
    spo2: 96,
    temperature: 36.9,
    movement: "NORMAL",
    stage: "drifting",
    narration: "Heart rate rising, oxygen easing down. Still in range, still no alert.",
  },
  {
    heart_rate: 104,
    spo2: 93,
    temperature: 37.3,
    movement: "NORMAL",
    stage: "warning",
    narration: "SpO₂ crosses the 94% early-warning line. A warning alert — not an emergency.",
  },
  {
    heart_rate: 138,
    spo2: 91,
    temperature: 37.8,
    movement: "NORMAL",
    stage: "warning",
    narration: "Deteriorating. Heart rate above the 120 BPM warning threshold.",
  },
  {
    heart_rate: 152,
    spo2: 87,
    temperature: 38.2,
    movement: "NORMAL",
    stage: "critical",
    narration:
      "Below the 90% escalation threshold and above 150 BPM. Critical alerts, an emergency event, and the care team notified — one transaction.",
  },
  {
    heart_rate: 148,
    spo2: 88,
    temperature: 38.1,
    movement: "FALL_SUSPECTED",
    stage: "fall",
    narration:
      "The band reports a movement pattern consistent with a fall — a second, distinct emergency.",
  },
];

/**
 * Builds the payload for one step.
 *
 * Identical in shape to what `payload.h` encodes on the ESP32, including the
 * telemetry block. `transport: "simulator"` is not decoration — it is the
 * honest label on the wire to match the provenance flag the device row
 * carries, and the server records it.
 */
export function buildSimulatedPayload(
  deviceKey: string,
  reading: SimulatedReading,
  index: number,
  now = new Date(),
): Record<string, unknown> {
  return {
    device_id: deviceKey,
    heart_rate: reading.heart_rate,
    spo2: reading.spo2,
    temperature: reading.temperature,
    movement: reading.movement,
    battery: Math.max(0, 92 - index),
    recorded_at: now.toISOString(),
    telemetry: {
      rssi: -58,
      uptime_s: 600 + index * 2,
      boot_count: 1,
      firmware: "sim-demo-1.0.0",
      transport: "simulator",
      buffered: 0,
      sensors: { pulse: "ok", thermometer: "ok", imu: "ok" },
    },
  };
}

/** Seconds between steps, so a five-minute demo has room for all six. */
export const STEP_INTERVAL_MS = 2500;

/** How long the whole script takes. */
export function scriptDurationMs(): number {
  return EMERGENCY_SCRIPT.length * STEP_INTERVAL_MS;
}

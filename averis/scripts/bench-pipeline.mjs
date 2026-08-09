#!/usr/bin/env node
/**
 * Benchmark — how long AVERIS takes to decide.
 *
 *   node --import tsx scripts/bench-pipeline.mjs
 *   node --import tsx scripts/bench-pipeline.mjs --json
 *
 * ── What this measures, and what it deliberately does not ─────────────────
 *
 * It measures the **decision pipeline**: validate a payload → evaluate the
 * threshold rules → decide whether it escalates → build the notification plan.
 * That is the path between a reading arriving and an alert existing, and it is
 * the number Phase 11 §7 asks for.
 *
 * It does **not** measure API response time, database write latency, WebSocket
 * delivery or dashboard rendering. Those need a deployed stack under load, and
 * this machine has neither. Reporting a figure for them from a laptop would be
 * a number that transfers to no deployment — the kind of benchmark that gets
 * quoted in a slide and is wrong everywhere it is repeated.
 *
 * The split is the point. What can be measured honestly is measured; what
 * cannot is named in VALIDATION_REPORT.md as not measured.
 *
 * ── Why percentiles and a warmup ──────────────────────────────────────────
 *
 * V8 optimises hot functions, so the first hundred iterations measure the
 * interpreter rather than the code. And a mean hides the tail: for an alerting
 * path the reading that matters is the one carrying a deterioration, and it is
 * not the median one.
 */

import { performance } from "node:perf_hooks";

import { validateReading } from "../lib/iot/reading-validation.ts";
import { evaluateReading } from "../lib/iot/alert-rules.ts";
import { fromAlerts } from "../lib/care/escalation.ts";
import { dispatchPlan } from "../lib/notifications/dispatch.ts";

const WARMUP = 2000;
const ITERATIONS = 20000;

const ALL_CHANNELS = { in_app: true, email: true, sms: true, push: true };

/** A payload as the ESP32 sends it. */
function payload(i) {
  // Every twentieth reading crosses the escalation point, so the benchmark
  // exercises the escalation and notification path rather than only the happy
  // path where nothing fires.
  const critical = i % 20 === 0;

  return {
    device_id: "AVR-BENCH",
    heart_rate: critical ? 168 : 70 + (i % 12),
    spo2: critical ? 88 : 96 + (i % 3),
    temperature: 36.5 + (i % 5) / 10,
    movement_status: "RESTING",
    battery_percentage: 80,
    recorded_at: new Date().toISOString(),
  };
}

/** The whole decision path for one reading. */
function pipeline(raw) {
  const validated = validateReading(raw);
  if (!validated.ok) return null;

  const alerts = evaluateReading(validated.reading);
  const emergencies = fromAlerts(
    alerts.map((a) => ({
      alertType: a.alertType,
      severity: a.severity,
      message: a.message,
      observedValue: a.observedValue,
      thresholdValue: a.thresholdValue,
    })),
  );

  if (emergencies.length === 0) return { alerts, emergencies, plan: null };

  const plan = dispatchPlan(
    {
      recipientId: "clinician-1",
      priority: "CRITICAL",
      kind: "emergency",
      title: emergencies[0].summary,
      body: emergencies[0].summary,
      emergencyId: "e-1",
    },
    ALL_CHANNELS,
  );

  return { alerts, emergencies, plan };
}

function percentile(sorted, p) {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function summarise(samples) {
  // An empty set is reported as such rather than as NaN. The first run of this
  // benchmark printed `p50 NaN µs` for the escalating path because every
  // payload was being rejected by validation — and NaN is a far weaker signal
  // than a count of zero beside a label saying so.
  if (samples.length === 0) {
    return { n: 0, note: "no samples — this path never executed" };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);

  return {
    n: sorted.length,
    min_us: round(sorted[0] * 1000),
    p50_us: round(percentile(sorted, 50) * 1000),
    p95_us: round(percentile(sorted, 95) * 1000),
    p99_us: round(percentile(sorted, 99) * 1000),
    max_us: round(sorted.at(-1) * 1000),
    mean_us: round((total / sorted.length) * 1000),
    throughput_per_second: Math.round(sorted.length / (total / 1000)),
  };
}

const round = (v) => Math.round(v * 100) / 100;

function main() {
  const asJson = process.argv.includes("--json");

  // Warmup, discarded. The first iterations measure V8 warming up, not the code.
  for (let i = 0; i < WARMUP; i += 1) pipeline(payload(i));

  const quiet = [];
  const escalating = [];
  let escalations = 0;

  for (let i = 0; i < ITERATIONS; i += 1) {
    const raw = payload(i);
    const started = performance.now();
    const result = pipeline(raw);
    const elapsed = performance.now() - started;

    if (result?.emergencies.length) {
      escalations += 1;
      escalating.push(elapsed);
    } else {
      quiet.push(elapsed);
    }
  }

  const report = {
    iterations: ITERATIONS,
    escalations,
    // Reported separately, because they are different code paths and averaging
    // them together describes neither. The escalating path is the one with a
    // clinical deadline.
    quiet_reading: summarise(quiet),
    escalating_reading: summarise(escalating),
    scope:
      "In-process decision pipeline only: validate → threshold rules → escalation → " +
      "notification plan. Does NOT include HTTP, database writes, WebSocket delivery or " +
      "rendering, which need a deployed stack under load and are listed as not measured " +
      "in VALIDATION_REPORT.md.",
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      note: "One developer machine, unloaded. Absolute figures will differ on deployment hardware; the ratio between the two paths will not.",
    },
  };

  // A run in which nothing escalated is a broken benchmark, not a fast one —
  // it means the payloads were rejected and the timings describe the rejection
  // path. Fail loudly rather than printing a flattering throughput figure.
  if (escalations === 0) {
    console.error(
      "\nERROR: no reading escalated. The payloads are being rejected before the " +
      "rules run, so these timings measure validation failure rather than the " +
      "decision pipeline.\n",
    );
    process.exitCode = 1;
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("\nAVERIS — decision pipeline benchmark");
  console.log("=".repeat(64));
  console.log(`\n${ITERATIONS.toLocaleString()} readings, ${escalations} of them escalating\n`);

  for (const [label, stats] of [
    ["Reading that raises nothing", report.quiet_reading],
    ["Reading that escalates", report.escalating_reading],
  ]) {
    if (stats.n === 0) {
      console.log(`${label}  — ${stats.note}\n`);
      continue;
    }
    console.log(`${label}  (n=${stats.n})`);
    console.log(
      `  p50 ${stats.p50_us} µs · p95 ${stats.p95_us} µs · p99 ${stats.p99_us} µs · ` +
        `max ${stats.max_us} µs`,
    );
    console.log(`  ~${stats.throughput_per_second.toLocaleString()} readings/second/core\n`);
  }

  console.log("SCOPE");
  console.log("-".repeat(64));
  console.log(report.scope);
  console.log(`\n${report.environment.note}\n`);
}

main();

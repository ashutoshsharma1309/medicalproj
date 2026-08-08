import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatUptime,
  hardwareIssues,
  latencyQuality,
  sensorRows,
  signalQuality,
  timeAgo,
  type HardwareTelemetry,
} from "../hardware-status";

const NOW = new Date("2026-08-09T12:00:00.000Z");

function telemetry(overrides: Partial<HardwareTelemetry> = {}): HardwareTelemetry {
  return {
    signalStrengthDbm: -55,
    uptimeSeconds: 3600,
    bootCount: 1,
    hardwareRevision: "esp32",
    transport: "wifi",
    sensorHealth: { pulse: "ok", thermometer: "ok", imu: "ok" },
    lastLatencyMs: 300,
    bufferedReadings: 0,
    lastBootAt: "2026-08-09T11:00:00.000Z",
    isSimulated: false,
    ...overrides,
  };
}

const HEALTHY_DEVICE = {
  connectionStatus: "ONLINE",
  batteryPercentage: 85,
  lastReadingAt: "2026-08-09T11:59:58.000Z",
};

describe("signal quality", () => {
  it("reads the usual 2.4 GHz thresholds", () => {
    assert.equal(signalQuality(-45), "excellent");
    assert.equal(signalQuality(-60), "good");
    assert.equal(signalQuality(-72), "weak");
    assert.equal(signalQuality(-88), "marginal");
    assert.equal(signalQuality(null), "unknown");
  });
});

describe("latency", () => {
  it("classifies a normal round trip", () => {
    assert.equal(latencyQuality(200), "fast");
    assert.equal(latencyQuality(3000), "normal");
    assert.equal(latencyQuality(9000), "slow");
  });

  it("calls a negative latency clock skew rather than clamping it", () => {
    // The only signal separating a device buffering through an outage from one
    // whose clock is wrong. Clamping to zero erases the difference.
    assert.equal(latencyQuality(-40000), "clock_skew");
  });

  it("tolerates small negatives without crying skew", () => {
    // Two clocks are never exactly aligned; 400ms of disagreement is normal.
    assert.equal(latencyQuality(-400), "fast");
  });
});

describe("what is wrong with this band", () => {
  it("says nothing about a healthy device", () => {
    // Not "Healthy" — a list that always has something in it is a list people
    // stop reading.
    assert.deepEqual(hardwareIssues(telemetry(), HEALTHY_DEVICE, NOW), []);
  });

  it("ranks a faulty sensor above everything else", () => {
    const issues = hardwareIssues(
      telemetry({ sensorHealth: { pulse: "faulty" }, signalStrengthDbm: -88 }),
      { ...HEALTHY_DEVICE, batteryPercentage: 20 },
      NOW,
    );

    assert.equal(issues[0].severity, "critical");
    assert.match(issues[0].summary, /Heart rate & SpO₂ sensor/);
  });

  it("does not call a band on a table a hardware fault", () => {
    const issues = hardwareIssues(
      telemetry({ sensorHealth: { pulse: "no_contact" } }),
      HEALTHY_DEVICE,
      NOW,
    );

    // Paging an engineer because someone took their band off is how the list
    // becomes noise.
    assert.equal(issues[0].severity, "info");
    assert.match(issues[0].summary, /not being worn/);
  });

  it("treats a sensor that was never fitted as information, not a fault", () => {
    const issues = hardwareIssues(
      telemetry({ sensorHealth: { thermometer: "absent" } }),
      HEALTHY_DEVICE,
      NOW,
    );

    assert.equal(issues[0].severity, "info");
    assert.match(issues[0].summary, /not fitted/);
  });

  it("names the state that produces the most confusing field reports", () => {
    const issues = hardwareIssues(
      telemetry({ signalStrengthDbm: -85 }),
      HEALTHY_DEVICE,
      NOW,
    );

    // A band at -85 dBm associates, holds an IP, and drops one uplink in
    // three: online device, chart full of holes, nobody connects the two.
    assert.ok(issues.some((i) => /dropped intermittently/.test(i.summary)));
  });

  it("reports a device that is not reporting", () => {
    const issues = hardwareIssues(
      telemetry(),
      { ...HEALTHY_DEVICE, connectionStatus: "OFFLINE" },
      NOW,
    );

    assert.equal(issues[0].severity, "critical");
    assert.match(issues[0].summary, /not currently being monitored/);
  });

  it("escalates a battery that is about to end monitoring", () => {
    const low = hardwareIssues(telemetry(), { ...HEALTHY_DEVICE, batteryPercentage: 8 }, NOW);
    const mid = hardwareIssues(telemetry(), { ...HEALTHY_DEVICE, batteryPercentage: 22 }, NOW);

    assert.equal(low[0].severity, "critical");
    assert.equal(mid[0].severity, "warning");
  });

  it("distinguishes repeated restarts from bad connectivity", () => {
    const issues = hardwareIssues(
      telemetry({ bootCount: 9, lastBootAt: "2026-08-09T11:58:00.000Z" }),
      HEALTHY_DEVICE,
      NOW,
    );

    // The two present identically and are fixed by different people.
    assert.ok(issues.some((i) => /hardware fault, not a network one/.test(i.summary)));
  });

  it("does not flag a band that booted once, long ago", () => {
    assert.deepEqual(
      hardwareIssues(
        telemetry({ bootCount: 12, lastBootAt: "2026-08-01T00:00:00.000Z" }),
        HEALTHY_DEVICE,
        NOW,
      ),
      [],
    );
  });

  it("surfaces readings the band is holding", () => {
    const issues = hardwareIssues(telemetry({ bufferedReadings: 42 }), HEALTHY_DEVICE, NOW);

    assert.match(issues[0].summary, /42 readings/);
  });
});

describe("the sensor panel", () => {
  it("lists every known sensor even when the device has said nothing", () => {
    const rows = sensorRows(telemetry({ sensorHealth: {} }));

    // An empty panel reads as "no sensors"; the true statement is "this device
    // has not told us".
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.state === "unknown"));
  });

  it("includes a sensor the firmware reported that we do not know about", () => {
    const rows = sensorRows(telemetry({ sensorHealth: { ecg: "ok" } }));

    assert.ok(rows.some((r) => r.key === "ecg" && r.state === "ok"));
  });
});

describe("formatting", () => {
  it("shows uptime in the largest informative unit", () => {
    assert.equal(formatUptime(45), "45s");
    assert.equal(formatUptime(600), "10m");
    assert.equal(formatUptime(7800), "2h 10m");
    assert.equal(formatUptime(90000), "1d 1h");
    assert.equal(formatUptime(null), "—");
  });

  it("answers the brief's 'Last Data: 1 second ago'", () => {
    assert.equal(timeAgo("2026-08-09T11:59:59.500Z", NOW), "just now");
    assert.equal(timeAgo("2026-08-09T11:59:15.000Z", NOW), "45s ago");
    assert.equal(timeAgo("2026-08-09T09:00:00.000Z", NOW), "3h ago");
    assert.equal(timeAgo(null, NOW), "never");
  });

  it("says the clock is ahead rather than claiming a reading from the future", () => {
    assert.equal(timeAgo("2026-08-09T12:00:40.000Z", NOW), "clock ahead");
  });

  it("does not crash on a malformed timestamp", () => {
    assert.equal(timeAgo("not-a-date", NOW), "unknown");
  });
});

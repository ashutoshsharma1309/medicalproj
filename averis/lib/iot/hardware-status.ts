/**
 * Reading a band's health from its telemetry.
 *
 * Pure. The hardware dashboard and the engineering view both render whatever
 * this returns, so the judgement about whether a device is healthy exists once
 * and is testable without a device.
 *
 * ── The question this file answers ─────────────────────────────────────────
 *
 * Not "is the device online" — Phase 1 already derives that from the last
 * reading, because a band that lost power cannot report itself offline. This
 * answers the next question, which is the one that costs engineering time:
 * **what is wrong with it?**
 *
 * "Device offline" sends someone to look at a whole band. "The MAX30102 stopped
 * answering while WiFi stayed up at -55 dBm" sends them to one solder joint.
 */

export type SensorState = "ok" | "absent" | "no_contact" | "faulty" | "unknown";

/** The sensors a wearable can report, and what to call them for a human. */
export const SENSOR_LABELS: Record<string, string> = {
  pulse: "Heart rate & SpO₂",
  thermometer: "Temperature",
  imu: "Motion",
};

export type HardwareTelemetry = {
  signalStrengthDbm: number | null;
  uptimeSeconds: number | null;
  bootCount: number | null;
  hardwareRevision: string | null;
  transport: string | null;
  sensorHealth: Record<string, SensorState>;
  lastLatencyMs: number | null;
  bufferedReadings: number | null;
  lastBootAt: string | null;
  isSimulated: boolean;
};

export type SignalQuality = "excellent" | "good" | "weak" | "marginal" | "unknown";

/**
 * WiFi signal, in words.
 *
 * The thresholds are the usual ones for 2.4 GHz. They matter here because
 * "marginal" is the state that produces the most confusing field reports: a
 * band at -85 dBm associates, holds an IP, and drops one uplink in three — so
 * the dashboard shows a device that is online and a patient whose chart has
 * holes in it, and nobody connects the two.
 */
export function signalQuality(dbm: number | null): SignalQuality {
  if (dbm === null) return "unknown";
  if (dbm >= -55) return "excellent";
  if (dbm >= -67) return "good";
  if (dbm >= -78) return "weak";
  return "marginal";
}

export type LatencyQuality = "fast" | "normal" | "slow" | "clock_skew" | "unknown";

/**
 * How long a reading took to arrive — and the case that is not a delay at all.
 *
 * A negative latency means the band's clock is ahead of the server's. It is
 * reported as clock skew rather than clamped to zero, because that number is
 * the only signal separating a device buffering through an outage from one
 * whose clock is simply wrong, and both look identical after a correction.
 */
export function latencyQuality(ms: number | null): LatencyQuality {
  if (ms === null) return "unknown";
  if (ms < -2000) return "clock_skew";
  if (ms <= 1500) return "fast";
  if (ms <= 5000) return "normal";
  return "slow";
}

export type HardwareIssue = {
  /** Ordered by what an engineer should look at first. */
  severity: "critical" | "warning" | "info";
  summary: string;
};

/**
 * What is wrong with this band, most serious first.
 *
 * Returns an empty list for a healthy device rather than a "Healthy" entry —
 * a list that always has something in it is a list people stop reading.
 */
export function hardwareIssues(
  telemetry: HardwareTelemetry,
  device: {
    connectionStatus: string;
    batteryPercentage: number | null;
    lastReadingAt: string | null;
  },
  now = new Date(),
): HardwareIssue[] {
  const issues: HardwareIssue[] = [];

  // A faulty sensor outranks everything else here, because it is the failure
  // that produces a chart which looks fine and is missing a channel.
  for (const [sensor, state] of Object.entries(telemetry.sensorHealth)) {
    const label = SENSOR_LABELS[sensor] ?? sensor;
    if (state === "faulty") {
      issues.push({
        severity: "critical",
        summary: `${label} sensor is answering with values that cannot be true.`,
      });
    } else if (state === "no_contact") {
      issues.push({
        severity: "info",
        // Explicitly not a fault: a band on a bedside table is a person not
        // wearing it, and paging an engineer for that trains them to ignore
        // the list.
        summary: `${label} sensor is not against skin — the band is probably not being worn.`,
      });
    } else if (state === "absent") {
      issues.push({
        severity: "info",
        summary: `${label} sensor is not fitted on this device.`,
      });
    }
  }

  if (device.connectionStatus === "OFFLINE") {
    issues.push({
      severity: "critical",
      summary: "Not reporting. This patient is not currently being monitored.",
    });
  }

  if (device.batteryPercentage !== null && device.batteryPercentage <= 10) {
    issues.push({
      severity: "critical",
      summary: `Battery at ${device.batteryPercentage}% — the band is about to stop monitoring.`,
    });
  } else if (device.batteryPercentage !== null && device.batteryPercentage <= 25) {
    issues.push({
      severity: "warning",
      summary: `Battery at ${device.batteryPercentage}%.`,
    });
  }

  const signal = signalQuality(telemetry.signalStrengthDbm);
  if (signal === "marginal") {
    issues.push({
      severity: "warning",
      summary: `Signal at ${telemetry.signalStrengthDbm} dBm. Readings will be dropped intermittently.`,
    });
  }

  if (telemetry.bufferedReadings !== null && telemetry.bufferedReadings > 0) {
    issues.push({
      severity: "warning",
      summary: `Holding ${telemetry.bufferedReadings} readings it could not deliver.`,
    });
  }

  if (latencyQuality(telemetry.lastLatencyMs) === "clock_skew") {
    issues.push({
      severity: "warning",
      summary: "The device clock is ahead of the server's. Readings may be timestamped wrongly.",
    });
  }

  // A band that reboots repeatedly presents as intermittent connectivity, and
  // the two are fixed by completely different people.
  if (telemetry.bootCount !== null && telemetry.lastBootAt) {
    const sinceBootMs = now.getTime() - new Date(telemetry.lastBootAt).getTime();
    if (sinceBootMs < 15 * 60 * 1000 && telemetry.bootCount > 3) {
      issues.push({
        severity: "warning",
        summary: `Restarted recently — ${telemetry.bootCount} boots recorded. Repeated restarts are a hardware fault, not a network one.`,
      });
    }
  }

  const rank = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * The sensors to show, in a fixed order.
 *
 * A device that has never reported sensor health returns every known sensor as
 * "unknown" rather than an empty list. An empty panel reads as "no sensors",
 * and the true statement is "this device has not told us".
 */
export function sensorRows(
  telemetry: HardwareTelemetry,
): { key: string; label: string; state: SensorState }[] {
  const known = Object.keys(SENSOR_LABELS);
  const reported = Object.keys(telemetry.sensorHealth);
  const keys = [...new Set([...known, ...reported])];

  return keys.map((key) => ({
    key,
    label: SENSOR_LABELS[key] ?? key,
    state: telemetry.sensorHealth[key] ?? "unknown",
  }));
}

/** Uptime, in the largest unit that is still informative. */
export function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

/** "1 second ago", for the freshness column the brief asks for. */
export function timeAgo(iso: string | null, now = new Date()): string {
  if (!iso) return "never";

  const deltaMs = now.getTime() - new Date(iso).getTime();
  if (Number.isNaN(deltaMs)) return "unknown";

  // A future timestamp is clock skew, not a reading from the future, and
  // "in 40 seconds" on a monitoring dashboard reads as a bug.
  if (deltaMs < -2000) return "clock ahead";
  if (deltaMs < 2000) return "just now";

  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

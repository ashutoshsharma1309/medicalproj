import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { listDevices, effectiveStatus } from "@/lib/iot/device-service";
import {
  formatUptime,
  hardwareIssues,
  latencyQuality,
  sensorRows,
  signalQuality,
  timeAgo,
} from "@/lib/iot/hardware-status";
import { Card, CardHeader, Chip, Callout } from "@/components/ui";

export const metadata = { title: "Device hardware" };
export const dynamic = "force-dynamic";

/**
 * Hardware status.
 *
 * Separate from /devices, which is about registration — issuing a token,
 * renaming a band, retiring one. This page is about whether the hardware is
 * working, which is a different question asked by a different person at a
 * different time.
 *
 * **Nothing here is a vital sign.** Every number on this page describes the
 * device: signal, uptime, latency, which sensors answered. That separation is
 * deliberate — a page mixing "the patient's SpO2 is 94%" with "the band is at
 * -70 dBm" invites reading one as evidence about the other.
 */

const STATE_TONE: Record<string, "positive" | "notice" | "critical" | "default"> = {
  ok: "positive",
  no_contact: "notice",
  faulty: "critical",
  absent: "default",
  unknown: "default",
};

const SIGNAL_LABEL: Record<string, string> = {
  excellent: "Excellent",
  good: "Good",
  weak: "Weak",
  marginal: "Marginal",
  unknown: "Unknown",
};

export default async function HardwarePage() {
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const supabase = await createClient();
  const devices = (await listDevices(supabase, account.patientProfileId)).filter(
    (d) => d.connectionStatus !== "RETIRED",
  );

  const now = new Date();

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">AVERIS Hardware</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">Device hardware</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          What your band is doing, as opposed to what it has measured. Everything on this page
          is about the device.
        </p>
      </header>

      {devices.length === 0 ? (
        <Callout tone="brand" title="No devices registered">
          Register a wearable to see its hardware status.{" "}
          <Link href="/devices" className="font-semibold underline underline-offset-2">
            Go to devices
          </Link>
        </Callout>
      ) : (
        devices.map((device) => {
          const status = effectiveStatus(device, now);
          const issues = hardwareIssues(
            device.telemetry,
            {
              connectionStatus: status,
              batteryPercentage: device.batteryPercentage,
              lastReadingAt: device.lastReadingAt,
            },
            now,
          );
          const signal = signalQuality(device.telemetry.signalStrengthDbm);
          const latency = latencyQuality(device.telemetry.lastLatencyMs);

          return (
            <Card key={device.id}>
              <CardHeader
                eyebrow={device.deviceKey}
                title={device.deviceName}
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    {device.telemetry.isSimulated && (
                      // The single most important chip on this page. Two kinds
                      // of data look identical in the table and mean completely
                      // different things.
                      <Chip tone="notice">simulated</Chip>
                    )}
                    <Chip tone={status === "ONLINE" ? "positive" : "critical"}>
                      {status === "ONLINE" ? "online" : status.toLowerCase()}
                    </Chip>
                  </div>
                }
              />

              {issues.length > 0 && (
                <ul className="divide-y divide-rule border-b border-rule">
                  {issues.map((issue) => (
                    <li key={issue.summary} className="flex items-start gap-3 px-6 py-3">
                      <span aria-hidden="true" className="mt-0.5">
                        {issue.severity === "critical" ? "■" : issue.severity === "warning" ? "▲" : "●"}
                      </span>
                      <span
                        className={`text-[14px] leading-relaxed ${
                          issue.severity === "critical" ? "text-[var(--color-critical)]" : ""
                        }`}
                      >
                        {issue.summary}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <dl className="grid grid-cols-2 gap-x-6 gap-y-4 px-6 py-5 sm:grid-cols-4">
                <Stat label="Last data" value={timeAgo(device.lastReadingAt, now)} />
                <Stat
                  label="Battery"
                  value={
                    device.batteryPercentage === null ? "—" : `${device.batteryPercentage}%`
                  }
                />
                <Stat
                  label="Signal"
                  value={
                    device.telemetry.signalStrengthDbm === null
                      ? "—"
                      : `${SIGNAL_LABEL[signal]} · ${device.telemetry.signalStrengthDbm} dBm`
                  }
                />
                <Stat
                  label="Latency"
                  value={
                    device.telemetry.lastLatencyMs === null
                      ? "—"
                      : latency === "clock_skew"
                        ? "clock ahead"
                        : `${device.telemetry.lastLatencyMs} ms`
                  }
                />
                <Stat label="Uptime" value={formatUptime(device.telemetry.uptimeSeconds)} />
                <Stat
                  label="Firmware"
                  value={device.firmwareVersion ?? "not reported"}
                />
                <Stat
                  label="Restarts"
                  value={device.telemetry.bootCount === null ? "—" : String(device.telemetry.bootCount)}
                />
                <Stat
                  label="Link"
                  value={device.telemetry.transport ?? "—"}
                />
              </dl>

              <div className="border-t border-rule px-6 py-4">
                <p className="eyebrow mb-2.5">Sensors</p>
                <ul className="flex flex-wrap gap-2">
                  {sensorRows(device.telemetry).map((sensor) => (
                    <li key={sensor.key} className="flex items-center gap-1.5">
                      {/* Shape as well as colour: AVERIS's amber and red are
                          indistinguishable under deuteranopia, and a sensor
                          panel read by colour alone is one a colourblind
                          engineer cannot use. */}
                      <span aria-hidden="true" className="mono text-[11px]">
                        {sensor.state === "ok" ? "✓" : sensor.state === "faulty" ? "✗" : "–"}
                      </span>
                      <Chip tone={STATE_TONE[sensor.state] ?? "default"}>
                        {sensor.label}
                        {sensor.state !== "ok" && ` · ${sensor.state.replace(/_/g, " ")}`}
                      </Chip>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-rule px-6 py-3.5">
                <Link
                  href={`/devices/${device.deviceKey}/diagnostics`}
                  className="text-[13.5px] text-brand hover:underline"
                >
                  Open engineering view →
                </Link>
                <Link
                  href={`/devices/${device.deviceKey}/calibration`}
                  className="text-[13.5px] text-brand hover:underline"
                >
                  Sensor calibration →
                </Link>
              </div>
            </Card>
          );
        })
      )}

      <p className="pb-2 text-[13px] leading-relaxed text-muted">
        A device shown as online has produced a reading recently. AVERIS derives that from the
        readings themselves rather than from a status the device reports, because a band that
        loses power cannot tell anyone it went offline.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[9.5px] uppercase tracking-[0.13em] text-muted">{label}</dt>
      <dd className="mono mt-0.5 text-[13.5px]">{value}</dd>
    </div>
  );
}

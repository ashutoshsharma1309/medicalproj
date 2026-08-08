import Link from "next/link";
import { notFound, redirect } from "next/navigation";
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
import { formatDate } from "@/lib/utils/format";
import { DiagnosticsStream } from "./DiagnosticsStream";

export const metadata = { title: "Device diagnostics" };
export const dynamic = "force-dynamic";

/**
 * Engineering test mode.
 *
 * For the person bringing a band up on a bench, not for a patient and not for
 * a clinician. It shows raw values, the device's own event log, and the last
 * readings exactly as stored — no smoothing, no formatting that hides a null,
 * no interpretation.
 *
 * **The most useful thing on this page is the event log.** Without it,
 * diagnosing a band means asking the person wearing it what the screen said an
 * hour ago. With it, "the IMU faulted at 14:02, it rebooted at 14:03, it has
 * rebooted nine times today" is a hardware fault someone can act on rather
 * than a report of "it keeps disconnecting".
 *
 * It is reachable by any patient who owns the device rather than gated behind
 * an engineering role. AVERIS has no such role, and inventing one to hide a
 * page showing a patient their own band's signal strength would be pretending
 * at a permission model rather than having one.
 */

const EVENT_TONE: Record<string, "critical" | "notice" | "default"> = {
  SENSOR_FAULT: "critical",
  AUTH_REJECTED: "critical",
  BUFFER_OVERFLOW: "notice",
  LOW_BATTERY: "notice",
  WENT_OFFLINE: "notice",
  SENSOR_RECOVERED: "default",
  CAME_ONLINE: "default",
  BOOT: "default",
  FIRMWARE_CHANGED: "default",
};

export default async function DiagnosticsPage(props: {
  params: Promise<{ deviceKey: string }>;
}) {
  const { deviceKey } = await props.params;
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const supabase = await createClient();
  const devices = await listDevices(supabase, account.patientProfileId);
  const device = devices.find(
    (d) => d.deviceKey.toUpperCase() === decodeURIComponent(deviceKey).toUpperCase(),
  );

  // A device key belonging to someone else renders a 404 rather than a denial:
  // "you cannot see this device" confirms the device exists.
  if (!device) notFound();

  const [readings, events] = await Promise.all([
    supabase
      .from("sensor_readings")
      .select("heart_rate, spo2, temperature, movement_status, battery_percentage, is_simulated, recorded_at, received_at")
      .eq("device_id", device.id)
      .order("recorded_at", { ascending: false })
      .limit(25)
      .then(({ data }) => data ?? []),
    supabase
      .from("device_events")
      .select("id, kind, detail, metadata, created_at")
      .eq("device_id", device.id)
      .order("created_at", { ascending: false })
      .limit(30)
      .then(({ data }) => data ?? []),
  ]);

  const now = new Date();
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

  return (
    <div className="space-y-7">
      <header>
        <Link href="/devices/hardware" className="text-[13px] text-brand hover:underline">
          ← Device hardware
        </Link>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">
          {device.deviceName}
        </h1>
        <p className="mono mt-1.5 text-[13px] text-muted">
          {device.deviceKey} · {device.deviceType.toLowerCase().replace(/_/g, " ")} ·{" "}
          {device.telemetry.hardwareRevision ?? "hardware not reported"}
        </p>
      </header>

      {device.telemetry.isSimulated && (
        <Callout tone="notice" title="Simulated device">
          Readings from this device are generated, not measured. Every row it writes is stamped
          as simulated, so a chart drawn from them stays distinguishable from a real one
          afterwards.
        </Callout>
      )}

      <Card>
        <CardHeader
          eyebrow="Live"
          title="Sensor values as reported"
          action={
            <Chip tone={status === "ONLINE" ? "positive" : "critical"}>
              {status.toLowerCase()}
            </Chip>
          }
        />
        <DiagnosticsStream
          deviceKey={device.deviceKey}
          initial={{
            heartRate: readings[0]?.heart_rate ?? null,
            spo2: readings[0]?.spo2 ?? null,
            temperature: readings[0]?.temperature ?? null,
            movementStatus: readings[0]?.movement_status ?? "UNKNOWN",
            recordedAt: readings[0]?.recorded_at ?? null,
          }}
        />
      </Card>

      <Card>
        <CardHeader eyebrow="Link" title="Communication" />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 px-6 py-5 sm:grid-cols-4">
          <Stat
            label="Signal"
            value={
              device.telemetry.signalStrengthDbm === null
                ? "—"
                : `${device.telemetry.signalStrengthDbm} dBm`
            }
            note={signalQuality(device.telemetry.signalStrengthDbm)}
          />
          <Stat
            label="Latency"
            value={
              device.telemetry.lastLatencyMs === null
                ? "—"
                : `${device.telemetry.lastLatencyMs} ms`
            }
            note={latencyQuality(device.telemetry.lastLatencyMs).replace(/_/g, " ")}
          />
          <Stat label="Transport" value={device.telemetry.transport ?? "—"} />
          <Stat
            label="Buffered"
            value={
              device.telemetry.bufferedReadings === null
                ? "—"
                : String(device.telemetry.bufferedReadings)
            }
            note={
              device.telemetry.bufferedReadings
                ? "held offline, not lost"
                : undefined
            }
          />
          <Stat label="Uptime" value={formatUptime(device.telemetry.uptimeSeconds)} />
          <Stat label="Restarts" value={device.telemetry.bootCount?.toString() ?? "—"} />
          <Stat
            label="Last boot"
            value={device.telemetry.lastBootAt ? timeAgo(device.telemetry.lastBootAt, now) : "—"}
          />
          <Stat label="Firmware" value={device.firmwareVersion ?? "—"} />
        </dl>

        <div className="border-t border-rule px-6 py-4">
          <p className="eyebrow mb-2.5">Sensors</p>
          <ul className="flex flex-wrap gap-2">
            {sensorRows(device.telemetry).map((sensor) => (
              <li key={sensor.key}>
                <Chip
                  tone={
                    sensor.state === "ok"
                      ? "positive"
                      : sensor.state === "faulty"
                        ? "critical"
                        : "default"
                  }
                >
                  {sensor.label} · {sensor.state.replace(/_/g, " ")}
                </Chip>
              </li>
            ))}
          </ul>
        </div>

        {issues.length > 0 && (
          <ul className="divide-y divide-rule border-t border-rule">
            {issues.map((issue) => (
              <li key={issue.summary} className="px-6 py-3 text-[13.5px] leading-relaxed">
                {issue.summary}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          eyebrow="History"
          title="Device event log"
          action={<span className="mono text-[12.5px] text-muted">{events.length} events</span>}
        />
        {events.length === 0 ? (
          <p className="px-6 py-5 text-[14px] text-muted">
            No events recorded. Events are written when something changes — a boot, a sensor
            fault, a firmware change — never on every reading.
          </p>
        ) : (
          <ul className="divide-y divide-rule">
            {events.map((event) => (
              <li key={event.id} className="px-6 py-3">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Chip tone={EVENT_TONE[event.kind] ?? "default"}>
                    {event.kind.toLowerCase().replace(/_/g, " ")}
                  </Chip>
                  <span className="mono text-[12px] text-muted">
                    {formatDate(event.created_at)}
                  </span>
                </div>
                {event.detail && (
                  <p className="mt-1 text-[13.5px] leading-relaxed">{event.detail}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          eyebrow="Raw"
          title="Stored readings"
          action={
            <span className="mono text-[12.5px] text-muted">newest {readings.length}</span>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-rule text-left">
                {["Recorded", "Received", "HR", "SpO2", "Temp", "Movement", "Batt", "Source"].map(
                  (header) => (
                    <th
                      key={header}
                      className="px-4 py-2.5 font-mono text-[9.5px] uppercase tracking-[0.13em] text-muted"
                    >
                      {header}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {readings.map((reading, index) => (
                <tr key={index} className="border-b border-rule last:border-0">
                  <td className="mono px-4 py-2">{formatDate(reading.recorded_at)}</td>
                  <td className="mono px-4 py-2">{formatDate(reading.received_at)}</td>
                  {/* Nulls are shown as null, not as blanks or zeroes. On an
                      engineering page the difference between "the sensor sent
                      nothing" and "the sensor sent 0" is the whole diagnosis. */}
                  <td className="mono px-4 py-2">{reading.heart_rate ?? "null"}</td>
                  <td className="mono px-4 py-2">{reading.spo2 ?? "null"}</td>
                  <td className="mono px-4 py-2">{reading.temperature ?? "null"}</td>
                  <td className="mono px-4 py-2">{reading.movement_status}</td>
                  <td className="mono px-4 py-2">{reading.battery_percentage ?? "null"}</td>
                  <td className="mono px-4 py-2">
                    {reading.is_simulated ? "sim" : "device"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="pb-2 text-[13px] leading-relaxed text-muted">
        Values on this page are shown as stored, without smoothing or rounding. The band applies
        its own filtering before transmitting — a raw sensor sample never reaches this table.
      </p>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="font-mono text-[9.5px] uppercase tracking-[0.13em] text-muted">{label}</dt>
      <dd className="mono mt-0.5 text-[13.5px]">{value}</dd>
      {note && <dd className="mono text-[10.5px] text-muted">{note}</dd>}
    </div>
  );
}

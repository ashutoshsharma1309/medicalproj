import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { listDevices, effectiveStatus, type DeviceRecord } from "@/lib/iot/device-service";
import { Card, CardHeader, Chip, Callout, DataPoint } from "@/components/ui";
import { formatDate } from "@/lib/utils/format";
import { RegisterDevice } from "./RegisterDevice";
import { retireDeviceAction } from "./actions";

export const metadata = { title: "My Devices" };
export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  WEARABLE_BAND: "Wearable band",
  PULSE_OXIMETER: "Pulse oximeter",
  SMART_WATCH: "Smart watch",
  CHEST_STRAP: "Chest strap",
  OTHER: "Device",
};

export default async function DevicesPage() {
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const supabase = await createClient();
  const devices = await listDevices(supabase, account.patientProfileId);
  const active = devices.filter((d) => d.connectionStatus !== "RETIRED");
  const retired = devices.filter((d) => d.connectionStatus === "RETIRED");

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">AVERIS Devices</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">My devices</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          Wearables registered to your account. Each one carries its own credential, so a device
          can send readings without ever holding your sign-in details.
        </p>
              <p className="mt-2 text-[14px]">
          <Link href="/devices/hardware" className="text-brand hover:underline">
            Hardware status →
          </Link>
        </p>
</header>

      {active.length === 0 && (
        <Callout tone="brand" title="No devices yet">
          Register one below to get a device token. Hardware is not required — the sensor
          simulator speaks the same contract an ESP32 will.
        </Callout>
      )}

      <Card>
        <CardHeader eyebrow="Add" title="Register a device" />
        <RegisterDevice />
      </Card>

      {active.length > 0 && (
        <Card>
          <CardHeader
            eyebrow="Connected"
            title="Your devices"
            action={
              <span className="mono text-[12.5px] text-muted">
                {active.length} {active.length === 1 ? "device" : "devices"}
              </span>
            }
          />
          <ul className="divide-y divide-rule">
            {active.map((device) => (
              <DeviceRow key={device.id} device={device} />
            ))}
          </ul>
        </Card>
      )}

      {retired.length > 0 && (
        <Card>
          <CardHeader eyebrow="Retired" title="No longer sending" />
          <ul className="divide-y divide-rule">
            {retired.map((device) => (
              <li key={device.id} className="px-6 py-4">
                <span className="text-[14.5px] font-medium text-muted">{device.deviceName}</span>
                <span className="mono ml-3 text-[12.5px] text-muted">{device.deviceKey}</span>
                <p className="mt-1 text-[12.5px] text-muted">
                  Its readings are kept; the credential no longer works.
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="pb-2 text-[13px] leading-relaxed text-muted">
        AVERIS shows measurements as devices report them. It does not interpret them, and nothing
        here replaces advice from your healthcare provider.
      </p>
    </div>
  );
}

function DeviceRow({ device }: { device: DeviceRecord }) {
  // Derived, not read from the column: a device that lost power cannot update
  // its own status, and showing "Connected" for a dead band is the one thing a
  // monitoring product must never do.
  const status = effectiveStatus(device);

  const tone =
    status === "ONLINE" ? "positive" : status === "OFFLINE" ? "critical" : "default";
  const label =
    status === "ONLINE"
      ? "Connected"
      : status === "OFFLINE"
        ? "Not reporting"
        : "Awaiting first reading";

  return (
    <li className="px-6 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div>
          <span className="text-[15px] font-medium">{device.deviceName}</span>
          <span className="mono ml-3 text-[12.5px] text-muted">{device.deviceKey}</span>
        </div>
        <Chip tone={tone}>{label}</Chip>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
        <DataPoint label="Type" value={TYPE_LABEL[device.deviceType] ?? "Device"} />
        <DataPoint
          label="Battery"
          value={device.batteryPercentage !== null ? `${device.batteryPercentage}%` : "—"}
          mono
        />
        <DataPoint
          label="Last reading"
          value={device.lastReadingAt ? formatDate(device.lastReadingAt) : "None yet"}
          mono
        />
        <DataPoint
          label="Firmware"
          value={device.firmwareVersion ?? "—"}
          mono
        />
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link
          href={`/monitoring?device=${device.deviceKey}`}
          className="text-[13.5px] font-medium text-brand hover:underline"
        >
          Live monitoring →
        </Link>

        <form action={retireDeviceAction}>
          <input type="hidden" name="deviceId" value={device.id} />
          <button type="submit" className="btn btn-ghost text-[13px]">
            Retire
          </button>
        </form>
      </div>
    </li>
  );
}

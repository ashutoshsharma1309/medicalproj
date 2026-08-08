import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { listDevices } from "@/lib/iot/device-service";
import {
  CHANNEL_LABELS,
  listSessions,
  summariseByChannel,
  type CalibrationChannel,
} from "@/lib/calibration/calibration-service";
import { ACCEPTABLE, MIN_PAIRS, REGULATORY_NOTE } from "@/lib/calibration/agreement";
import { Card, CardHeader, Chip, Callout } from "@/components/ui";
import { formatDate } from "@/lib/utils/format";
import { CalibrationForm } from "./CalibrationForm";

export const metadata = { title: "Sensor calibration" };
export const dynamic = "force-dynamic";

/**
 * Calibration for one band.
 *
 * ── What this page is careful not to say ───────────────────────────────────
 *
 * It never uses the word "accurate", and the caveat is at the top rather than
 * in a footnote. A page that shows a green tick beside "SpO₂ — passed" teaches
 * the reader that the band's oxygen readings are trustworthy, and a bench
 * comparison at normal saturation cannot support that. What it supports is
 * "this unit is not broken and reads about 1% low against a named reference",
 * which is genuinely useful and is a different sentence.
 *
 * The three-state result matters for the same reason. A channel with eight
 * measurements is neither passing nor failing — it is unmeasured — and showing
 * it as a failure would push people to record something rather than to record
 * enough.
 */
export default async function CalibrationPage(props: {
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

  // A 404 rather than a denial, matching the diagnostics page: "you cannot see
  // this device" confirms the device exists.
  if (!device) notFound();

  const sessions = await listSessions(supabase, device.id);
  const byChannel = summariseByChannel(sessions);

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">
          <Link href="/devices" className="underline underline-offset-2">
            Devices
          </Link>{" "}
          · {device.deviceKey}
        </p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">Sensor calibration</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          How this specific band compares against a reference instrument. Recorded, never
          applied — readings are stored exactly as the band reported them.
        </p>
      </header>

      {/* The caveat first, because a reader who stops after the summary table
          must still have seen it. */}
      <Callout tone="notice" title="What these figures are, and are not">
        <p className="text-[14px] leading-relaxed">{REGULATORY_NOTE}</p>
      </Callout>

      {/* ------------------------------------------------------ per channel */}
      <Card>
        <CardHeader eyebrow="The most recent session for each channel" title="Current state" />

        <div className="divide-y divide-line">
          {byChannel.map(({ channel, latest }) => {
            const bounds = ACCEPTABLE[channel];
            const unit = bounds?.unit ?? "";

            return (
              <div key={channel} className="flex flex-wrap items-start gap-x-6 gap-y-2 py-3">
                <div className="min-w-[140px]">
                  <p className="text-[15px] font-semibold">{CHANNEL_LABELS[channel]}</p>
                  {latest && (
                    <p className="mt-0.5 text-[13px] text-ink-soft">
                      {formatDate(latest.performedAt)}
                    </p>
                  )}
                </div>

                <div className="flex-1 min-w-[240px]">
                  {!latest ? (
                    <p className="text-[14px] text-ink-soft">
                      Never compared against a reference. Nothing is known about how this
                      channel reads on this unit.
                    </p>
                  ) : latest.meetsBenchBounds === null ? (
                    <p className="text-[14px] text-ink-soft">
                      {latest.pairCount} paired measurement
                      {latest.pairCount === 1 ? "" : "s"} recorded — {MIN_PAIRS} are needed
                      before agreement can be reported.
                    </p>
                  ) : (
                    <p className="text-[14px] leading-relaxed">
                      Reads{" "}
                      <strong>
                        {Math.abs(Number(latest.bias)).toFixed(1)}
                        {unit} {Number(latest.bias) >= 0 ? "above" : "below"}
                      </strong>{" "}
                      {latest.referenceInstrument}. 95% of readings fell between{" "}
                      {Number(latest.loaLower).toFixed(1)}
                      {unit} and {Number(latest.loaUpper).toFixed(1)}
                      {unit} of it.
                    </p>
                  )}
                </div>

                <div>
                  {!latest ? (
                    <Chip tone="default">Not measured</Chip>
                  ) : latest.meetsBenchBounds === null ? (
                    // Neither pass nor fail. Showing this as a failure pushes
                    // people to record something rather than enough.
                    <Chip tone="default">Incomplete</Chip>
                  ) : latest.meetsBenchBounds ? (
                    <Chip tone="positive">Within bench bounds</Chip>
                  ) : (
                    <Chip tone="critical">Outside bench bounds</Chip>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* --------------------------------------------------------- history */}
      {sessions.length > 0 && (
        <Card>
          <CardHeader
            eyebrow="Kept in full — a calibration record is evidence about a device"
            title="All sessions"
          />

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[14px]">
              <thead className="border-b border-line text-left text-[13px] text-ink-soft">
                <tr>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Channel</th>
                  <th className="py-2 pr-4 font-medium">Reference</th>
                  <th className="py-2 pr-4 font-medium">Pairs</th>
                  <th className="py-2 pr-4 font-medium">Bias</th>
                  <th className="py-2 pr-4 font-medium">95% limits</th>
                  <th className="py-2 font-medium">Worst</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => {
                  const unit = ACCEPTABLE[session.channel]?.unit ?? "";
                  return (
                    <tr key={session.id} className="border-b border-line last:border-0">
                      <td className="py-2 pr-4 whitespace-nowrap">
                        {formatDate(session.performedAt)}
                      </td>
                      <td className="py-2 pr-4">
                        {CHANNEL_LABELS[session.channel as CalibrationChannel]}
                      </td>
                      <td className="py-2 pr-4 text-ink-soft">{session.referenceInstrument}</td>
                      <td className="py-2 pr-4">{session.pairCount}</td>
                      <td className="py-2 pr-4">
                        {session.bias === null
                          ? "—"
                          : `${Number(session.bias) >= 0 ? "+" : ""}${Number(session.bias).toFixed(1)}${unit}`}
                      </td>
                      <td className="py-2 pr-4">
                        {session.loaLower === null
                          ? "—"
                          : `${Number(session.loaLower).toFixed(1)} to ${Number(session.loaUpper).toFixed(1)}${unit}`}
                      </td>
                      <td className="py-2">
                        {session.maxAbsDifference === null
                          ? "—"
                          : `${Number(session.maxAbsDifference).toFixed(1)}${unit}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------- new session */}
      <Card>
        <CardHeader
          eyebrow="Both readings at the same moment, under conditions you write down"
          title="Record a session"
        />
        <CalibrationForm deviceKey={device.deviceKey} />
      </Card>
    </div>
  );
}

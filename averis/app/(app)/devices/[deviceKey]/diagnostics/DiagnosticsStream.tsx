"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Live values on the engineering page.
 *
 * Polls rather than opening a websocket, and the reasoning is specific to what
 * this page is for. The live socket in `/monitoring` authenticates with a
 * *device token*, which is a credential an engineer bringing up a band already
 * has on their bench — but this page is reachable by the patient who owns the
 * device, and asking a patient to paste their device token to see whether
 * their band is reporting would train exactly the habit the token model exists
 * to prevent.
 *
 * So this re-reads through the session, over RLS, every two seconds: the same
 * cadence as the uplink, which means the page is never more than one reading
 * behind and never shows a value that did not come through the normal path.
 */

const POLL_MS = 2000;

export type StreamSnapshot = {
  heartRate: number | null;
  spo2: number | null;
  temperature: number | null;
  movementStatus: string;
  recordedAt: string | null;
};

export function DiagnosticsStream({
  deviceKey,
  initial,
}: {
  deviceKey: string;
  initial: StreamSnapshot;
}) {
  const router = useRouter();
  const [ticks, setTicks] = useState(0);
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!live) return;

    const timer = setInterval(() => {
      setTicks((n) => n + 1);
      router.refresh();
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [live, router]);

  const age = initial.recordedAt
    ? Math.round((Date.now() - new Date(initial.recordedAt).getTime()) / 1000)
    : null;

  return (
    <div>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-5 px-6 py-5 sm:grid-cols-4">
        <Value label="Heart rate" value={initial.heartRate} unit="BPM" />
        <Value label="SpO2" value={initial.spo2} unit="%" />
        <Value label="Temperature" value={initial.temperature} unit="°C" precision={1} />
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            Movement
          </dt>
          <dd className="mono mt-1.5 text-[16px] font-semibold leading-none">
            {initial.movementStatus.toLowerCase().replace(/_/g, " ")}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-rule px-6 py-3">
        <span className="mono text-[11.5px] text-muted">
          {age === null
            ? "no readings from this device yet"
            : `newest reading ${age}s old · ${deviceKey}`}
          {live && ticks > 0 && ` · refreshed ${ticks}×`}
        </span>

        <button
          type="button"
          onClick={() => setLive((on) => !on)}
          aria-pressed={live}
          className="mono text-[11.5px] text-brand underline-offset-2 hover:underline"
        >
          {/* Pausable, because an engineer reading a value off the screen
              should not have it change under them mid-sentence. */}
          {live ? "Pause refresh" : "Resume refresh"}
        </button>
      </div>
    </div>
  );
}

function Value({
  label,
  value,
  unit,
  precision = 0,
}: {
  label: string;
  value: number | null;
  unit: string;
  precision?: number;
}) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</dt>
      <dd className="mono mt-1.5 text-[20px] font-semibold leading-none">
        {value === null ? (
          // "null", not "—" and never 0. On an engineering page the difference
          // between a sensor that sent nothing and one that sent zero is the
          // whole diagnosis.
          <span className="text-muted">null</span>
        ) : (
          <>
            {value.toFixed(precision)}
            <span className="ml-1 text-[11px] font-normal text-muted">{unit}</span>
          </>
        )}
      </dd>
    </div>
  );
}

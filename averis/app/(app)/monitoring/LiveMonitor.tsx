"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Live vitals.
 *
 * **Nothing here invents a number.** Every value on screen arrives from a
 * device over the socket, or from the patient's stored history. Before the
 * first reading lands, the tiles say so rather than showing a placeholder that
 * looks like a measurement — a monitoring dashboard that displays plausible
 * vital signs for a patient nobody is measuring is worse than a blank one.
 *
 * **Staleness is shown, not hidden.** A socket can stay open while the device
 * behind it has stopped sending, so the tiles grey out once a reading passes
 * its freshness window. A number with no age on it is a number the reader will
 * assume is current.
 */

export type Vitals = {
  heartRate: number | null;
  spo2: number | null;
  temperature: number | null;
  movementStatus: string;
  batteryPercentage: number | null;
  recordedAt: string;
  deviceKey: string;
};

type Status = "connecting" | "live" | "reconnecting" | "offline" | "unconfigured";

/** Past this, a reading is history rather than a current value. */
const STALE_AFTER_MS = 30_000;

export function LiveMonitor({
  serviceUrl,
  initial,
}: {
  serviceUrl: string | null;
  initial: Vitals | null;
}) {
  const [vitals, setVitals] = useState<Vitals | null>(initial);
  const [status, setStatus] = useState<Status>(serviceUrl ? "connecting" : "unconfigured");
  const [token, setToken] = useState("");
  const [subscribed, setSubscribed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drives the staleness indicator. One-second ticks, not per-render, so the
  // age is honest without re-subscribing to anything.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const connect = useCallback(
    (deviceToken: string) => {
      if (!serviceUrl) return;

      const socket = new WebSocket(serviceUrl);
      socketRef.current = socket;

      socket.onopen = () => {
        // The token is sent in the first frame rather than the URL: query
        // strings end up in proxy logs and browser history, and this one is a
        // credential.
        socket.send(JSON.stringify({ token: deviceToken }));
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          if (message.type === "subscribed") {
            setStatus("live");
            setSubscribed(true);
            retryRef.current = 0;
            return;
          }

          if (message.type === "reading") {
            setVitals({
              heartRate: message.heart_rate ?? null,
              spo2: message.spo2 ?? null,
              temperature: message.temperature ?? null,
              movementStatus: message.movement_status ?? "UNKNOWN",
              batteryPercentage: message.battery_percentage ?? null,
              recordedAt: message.recorded_at,
              deviceKey: message.device_key,
            });
          }
        } catch {
          /* a malformed frame must not take the page down */
        }
      };

      socket.onclose = (event) => {
        socketRef.current = null;
        setSubscribed(false);

        // 1008 is the server refusing the token. Retrying would loop forever
        // against a credential that will never be accepted.
        if (event.code === 1008) {
          setStatus("offline");
          return;
        }

        setStatus("reconnecting");

        // Exponential backoff, capped. A dashboard left open overnight against
        // a stopped service should not spend the night reconnecting every
        // second.
        const delay = Math.min(30_000, 1000 * 2 ** retryRef.current);
        retryRef.current += 1;
        timerRef.current = setTimeout(() => connect(deviceToken), delay);
      };

      socket.onerror = () => {
        socket.close();
      };
    },
    [serviceUrl],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      socketRef.current?.close();
    };
  }, []);

  const age = vitals ? now - new Date(vitals.recordedAt).getTime() : Infinity;
  const stale = age > STALE_AFTER_MS;

  if (status === "unconfigured") {
    return (
      <div className="px-6 py-8 text-center">
        <p className="text-[15px] font-medium">Live monitoring is not configured</p>
        <p className="mx-auto mt-2 max-w-lg text-[14px] leading-relaxed text-ink-soft">
          Set <code className="mono">NEXT_PUBLIC_IOT_WS_URL</code> to the IoT service&rsquo;s
          WebSocket address and reload. Your stored readings are unaffected.
        </p>
      </div>
    );
  }

  if (!subscribed) {
    return (
      <form
        className="px-6 py-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (token.trim()) {
            setStatus("connecting");
            connect(token.trim());
          }
        }}
      >
        <label htmlFor="deviceToken" className="field-label">
          Device token
        </label>
        <div className="mt-1 flex flex-col gap-3 sm:flex-row">
          <input
            id="deviceToken"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="avd_…"
            className="field-input mono flex-1"
          />
          <button type="submit" className="btn btn-primary sm:w-44">
            {status === "connecting" ? "Connecting…" : "Start monitoring"}
          </button>
        </div>

        <p className="field-hint">
          The token issued when you registered the device. It is held in this tab only and never
          sent to the AVERIS web server.
        </p>

        {status === "offline" && (
          <p className="field-error mt-2" role="alert">
            That token was refused. Check it, or generate a new one from My Devices.
          </p>
        )}
      </form>
    );
  }

  return (
    <div className="px-6 py-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className={`h-2 w-2 rounded-full ${
              status === "live" && !stale ? "bg-[var(--color-positive)]" : "bg-[var(--color-notice)]"
            }`}
            aria-hidden="true"
          />
          <span className="text-[13.5px] font-medium">
            {status === "reconnecting"
              ? "Reconnecting…"
              : stale
                ? "No recent reading"
                : `Live from ${vitals?.deviceKey ?? "device"}`}
          </span>
        </div>

        {vitals && (
          <span className="mono text-[12.5px] text-muted">
            last reading {formatAge(age)}
          </span>
        )}
      </div>

      {!vitals ? (
        <div className="py-10 text-center">
          <p className="text-[15px] font-medium">Waiting for the first reading</p>
          <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-ink-soft">
            Nothing is shown until a device sends one. Start the simulator, or power on the
            wearable.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <VitalTile
            label="Heart rate"
            value={vitals.heartRate}
            unit="BPM"
            stale={stale}
          />
          <VitalTile label="Blood oxygen" value={vitals.spo2} unit="%" stale={stale} />
          <VitalTile
            label="Temperature"
            value={vitals.temperature}
            unit="°C"
            precision={1}
            stale={stale}
          />
          <div className={`rounded border border-rule bg-surface p-4 ${stale ? "opacity-50" : ""}`}>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Movement</p>
            <p className="mt-2 text-[20px] font-semibold leading-none">
              {humanise(vitals.movementStatus)}
            </p>
            {vitals.batteryPercentage !== null && (
              <p className="mono mt-3 text-[12px] text-muted">
                battery {vitals.batteryPercentage}%
              </p>
            )}
          </div>
        </div>
      )}

      {stale && vitals && (
        <p className="mt-4 text-[13px] leading-relaxed text-muted">
          These are the last values received, not current ones. The device may be out of range,
          powered off, or between readings.
        </p>
      )}
    </div>
  );
}

function VitalTile({
  label,
  value,
  unit,
  precision = 0,
  stale,
}: {
  label: string;
  value: number | null;
  unit: string;
  precision?: number;
  stale: boolean;
}) {
  return (
    <div className={`rounded border border-rule bg-surface p-4 ${stale ? "opacity-50" : ""}`}>
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</p>
      {value === null ? (
        // "—" rather than a zero: a zero reads as a measurement.
        <p className="mono mt-2 text-[28px] font-semibold leading-none text-muted">—</p>
      ) : (
        <p className="mono mt-2 text-[28px] font-semibold leading-none">
          {value.toFixed(precision)}
          <span className="ml-1.5 text-[14px] font-normal text-muted">{unit}</span>
        </p>
      )}
      {value === null && (
        <p className="mt-2 text-[12px] text-muted">Not reported by this device</p>
      )}
    </div>
  );
}

function humanise(status: string): string {
  return status.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

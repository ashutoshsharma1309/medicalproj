"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { VitalCard } from "./VitalCard";
import { VitalChart } from "./VitalChart";
import { classifyVital, worstStatus, STATUS_LABEL } from "@/lib/iot/vital-status";
import { windowed, WINDOW_LABEL, type SeriesPoint, type TimeWindow } from "@/lib/iot/series";

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

/** Live points held in the tab. Older data comes from the durable record. */
const MAX_BUFFERED = 7200;

export function LiveMonitor({
  serviceUrl,
  initial,
  initialSeries,
}: {
  serviceUrl: string | null;
  initial: Vitals | null;
  /** Recent stored readings, so the charts are populated before the first push. */
  initialSeries: SeriesPoint[];
}) {
  const [vitals, setVitals] = useState<Vitals | null>(initial);

  // Live points accumulate in this tab only. Bounded, because a dashboard left
  // open overnight at 0.5 Hz would otherwise hold ~43k points and grow until
  // the tab dies.
  const [series, setSeries] = useState<SeriesPoint[]>(() =>
    initialSeries.map((p) => ({ ...p })),
  );
  const [chartWindow, setChartWindow] = useState<TimeWindow>("10m");
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
            const t = new Date(message.recorded_at).getTime();

            setSeries((previous) => {
              const next = [
                ...previous,
                {
                  t,
                  heartRate: message.heart_rate ?? null,
                  spo2: message.spo2 ?? null,
                  temperature: message.temperature ?? null,
                },
              ];
              // One hour of headroom at 2 Hz. Anything older is available from
              // the history table, which reads the durable record.
              return next.length > MAX_BUFFERED ? next.slice(-MAX_BUFFERED) : next;
            });

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

  const visible = useMemo(
    () => windowed(series, chartWindow, now),
    [series, chartWindow, now],
  );

  // The worst of the three, for the banner. A card can be normal while another
  // is critical, and the header must show the one that matters.
  const overall = vitals
    ? worstStatus([
        classifyVital("heartRate", vitals.heartRate),
        classifyVital("spo2", vitals.spo2),
        classifyVital("temperature", vitals.temperature),
      ])
    : "UNKNOWN";

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
          {vitals && !stale && overall !== "UNKNOWN" && (
            <span className="text-[12.5px] text-muted">· {STATUS_LABEL[overall]}</span>
          )}
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
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <VitalCard kind="heartRate" value={vitals.heartRate} stale={stale} />
            <VitalCard kind="spo2" value={vitals.spo2} stale={stale} />
            <VitalCard kind="temperature" value={vitals.temperature} stale={stale} />

            <div
              className="rounded border border-rule bg-surface p-4"
              style={{ borderLeftWidth: "3px", borderLeftColor: "var(--color-rule)", opacity: stale ? 0.55 : 1 }}
            >
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                Activity
              </p>
              <p className="mt-2 text-[22px] font-semibold leading-none">
                {humanise(vitals.movementStatus)}
              </p>
              {vitals.batteryPercentage !== null && (
                <p className="mono mt-3 text-[12px] text-muted">
                  battery {vitals.batteryPercentage}%
                </p>
              )}
            </div>
          </div>

          {stale && (
            <p className="mt-4 text-[13px] leading-relaxed text-muted">
              These are the last values received, not current ones. The device may be out of
              range, powered off, or between readings.
            </p>
          )}

          {/* One filter row above everything it scopes — never a control inside
              a chart card, which would let two charts disagree about the window
              they are showing. */}
          <div className="mt-7 flex flex-wrap items-center gap-2 border-t border-rule pt-5">
            <span className="eyebrow mr-1">Window</span>
            {(["1m", "10m", "1h"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setChartWindow(option)}
                aria-pressed={chartWindow === option}
                className={`rounded-full border px-3 py-1.5 text-[12.5px] transition-colors ${
                  chartWindow === option
                    ? "border-brand bg-wash font-medium text-brand"
                    : "border-rule text-ink-soft hover:border-brand hover:text-brand"
                }`}
              >
                {WINDOW_LABEL[option]}
              </button>
            ))}
            <span className="mono ml-auto text-[11.5px] text-muted">
              {visible.length} {visible.length === 1 ? "reading" : "readings"}
            </span>
          </div>

          {/* Three single-series charts rather than one with three lines: heart
              rate, SpO2 and temperature have different scales, and a shared plot
              would need multiple y-axes — which invent correlations that are not
              in the data. */}
          <div className="mt-5 space-y-7">
            <VitalChart kind="heartRate" points={visible} window={chartWindow} now={now} />
            <VitalChart kind="spo2" points={visible} window={chartWindow} now={now} />
            <VitalChart kind="temperature" points={visible} window={chartWindow} now={now} />
          </div>
        </>
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

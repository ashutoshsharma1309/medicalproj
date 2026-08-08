"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Meter } from "@/components/ui/clinical";
import {
  buildSimulatedPayload,
  EMERGENCY_SCRIPT,
  STEP_INTERVAL_MS,
} from "@/lib/demo/emergency-script";

/**
 * "Simulate Emergency".
 *
 * ── What this button does, precisely ───────────────────────────────────────
 *
 * It POSTs six readings to `/api/device/upload` — the same endpoint, the same
 * JSON, and the same bearer-token authentication the ESP32 firmware uses.
 * There is no demo path through the backend. Each reading is validated,
 * stored, evaluated by the threshold rules, escalated, and fanned out to the
 * care team by exactly the code that would run for a real band.
 *
 * ── Why the browser sends them, and not the server ─────────────────────────
 *
 * The web app deliberately holds no service-role key: it talks to Postgres as
 * the signed-in user, over RLS, so a bug in a page cannot reach a chart the
 * policy would refuse. Giving it a credential that could write readings would
 * undo that for a demo button, which is not a trade worth making.
 *
 * So the *device token* is used, from the browser, exactly as a device would.
 * The token is typed in and held in component state only — never localStorage,
 * never sent to the AVERIS server, never logged. The same pattern the live
 * monitor already uses for its websocket.
 *
 * ── The honesty constraint ─────────────────────────────────────────────────
 *
 * Every reading this produces is stamped `is_simulated` at write time, because
 * the *device* is registered as a simulator. That is server-side and cannot be
 * overridden from here — a demo that could write data indistinguishable from
 * measurements would poison the one distinction the platform depends on.
 */

type Phase = "idle" | "running" | "done" | "error";

export function EmergencySimulator({
  deviceKey,
  ingestUrl,
}: {
  deviceKey: string | null;
  /** Null when NEXT_PUBLIC_IOT_HTTP_URL is not configured. */
  ingestUrl: string | null;
}) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [step, setStep] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const abortRef = useRef(false);

  const run = useCallback(async () => {
    if (!deviceKey || !ingestUrl || !token.trim()) return;

    abortRef.current = false;
    setPhase("running");
    setError(null);
    setSent(0);

    for (let i = 0; i < EMERGENCY_SCRIPT.length; i += 1) {
      if (abortRef.current) {
        setPhase("idle");
        setStep(-1);
        return;
      }

      setStep(i);

      try {
        const response = await fetch(ingestUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token.trim()}`,
          },
          body: JSON.stringify(buildSimulatedPayload(deviceKey, EMERGENCY_SCRIPT[i], i)),
        });

        if (response.status === 401 || response.status === 403) {
          // Will never succeed by retrying, so it stops rather than sending
          // five more rejected requests during a demonstration.
          setError(
            "The ingest service refused that token. Check it, or rotate the device from My Devices.",
          );
          setPhase("error");
          return;
        }

        if (!response.ok) {
          setError(`The ingest service returned ${response.status}. Is it running?`);
          setPhase("error");
          return;
        }

        setSent((n) => n + 1);
      } catch {
        // A network failure here is almost always the ingest service not
        // running or CORS not allowing this origin — both worth naming,
        // because "failed to fetch" sends people to the wrong place.
        setError(
          `Could not reach ${ingestUrl}. Start the ingest service, and make sure CORS_ORIGINS includes this origin.`,
        );
        setPhase("error");
        return;
      }

      // Re-read after each step so the dashboards move while the script runs.
      // This is what makes the demonstration watchable rather than a result.
      router.refresh();

      if (i < EMERGENCY_SCRIPT.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, STEP_INTERVAL_MS));
      }
    }

    setPhase("done");
    setStep(-1);
    router.refresh();
  }, [deviceKey, ingestUrl, token, router]);

  if (!ingestUrl) {
    return (
      <div className="px-6 py-5">
        <p className="text-[14px] leading-relaxed text-ink-soft">
          Set <code className="mono">NEXT_PUBLIC_IOT_HTTP_URL</code> to the ingest
          service&rsquo;s upload endpoint — for example{" "}
          <code className="mono">http://localhost:8000/api/device/upload</code> — to enable
          the emergency simulation.
        </p>
      </div>
    );
  }

  if (!deviceKey) {
    return (
      <div className="px-6 py-5">
        <p className="text-[14px] leading-relaxed text-ink-soft">
          Register a device with <strong>&ldquo;This is a simulator&rdquo;</strong> ticked
          first. Readings from a device that is not marked as one cannot be told apart from
          measurements afterwards, which is the distinction this whole platform rests on.
        </p>
      </div>
    );
  }

  const running = phase === "running";
  const current = step >= 0 ? EMERGENCY_SCRIPT[step] : null;

  return (
    <div className="px-6 py-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="sim-token" className="field-label">
            Device token
          </label>
          <input
            id="sim-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="avd_…"
            className="field-input mono w-full"
            disabled={running}
          />
          <p className="field-hint">
            Held in this tab only. It is never stored, never sent to AVERIS, and never logged —
            it goes straight to the ingest service, exactly as a band&rsquo;s would.
          </p>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={run}
            disabled={running || token.trim().length < 4}
            className="btn btn-primary whitespace-nowrap"
          >
            {running ? "Running…" : "Simulate emergency"}
          </button>
          {running && (
            <button
              type="button"
              onClick={() => {
                abortRef.current = true;
              }}
              className="btn btn-ghost"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="field-error mt-3" role="alert">
          {error}
        </p>
      )}

      {(running || phase === "done") && (
        <div className="mt-5">
          <Meter
            value={sent}
            max={EMERGENCY_SCRIPT.length}
            tone={phase === "done" ? "positive" : "critical"}
            label={phase === "done" ? "Sequence complete" : "Sending readings"}
            valueLabel={`${sent} of ${EMERGENCY_SCRIPT.length}`}
          />

          {current && (
            <p className="mt-3 text-[14px] leading-relaxed">
              <span className="mono mr-2 text-[11px] uppercase tracking-[0.12em] text-muted">
                {current.stage}
              </span>
              {current.narration}
            </p>
          )}

          {current && (
            <p className="mono mt-2 text-[12.5px] text-muted">
              {current.heart_rate} BPM · SpO₂ {current.spo2}% · {current.temperature}°C ·{" "}
              {current.movement.toLowerCase().replace(/_/g, " ")}
            </p>
          )}

          {phase === "done" && (
            <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
              Six readings delivered through the production pipeline. The alerts, the
              emergency events and the clinician&rsquo;s notifications below were produced by
              the same code a real band triggers.
            </p>
          )}
        </div>
      )}

      <ol className="mt-5 space-y-1.5">
        {EMERGENCY_SCRIPT.map((entry, index) => (
          <li
            key={index}
            className={`flex gap-2.5 text-[12.5px] leading-relaxed ${
              index < sent ? "text-ink-soft" : "text-muted"
            }`}
          >
            <span aria-hidden="true" className="mono">
              {index < sent ? "✓" : index === step && running ? "▸" : "·"}
            </span>
            <span>{entry.narration}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

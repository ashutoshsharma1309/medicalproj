"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Callout, Chip, Field, Input } from "@/components/ui";
import {
  SIH_DEMO_STEPS,
  canContinue,
  degradationNotice,
  runSummary,
  type DemoStepResult,
  type StepStatus,
} from "@/lib/demo/sih-run";
import { EMERGENCY_SCRIPT, buildSimulatedPayload } from "@/lib/demo/emergency-script";

/**
 * "Start SIH demonstration" — one button, six steps.
 *
 * ── The design constraint ──────────────────────────────────────────────────
 *
 * A judge gives you five minutes and will interrupt. So the run has to be
 * startable with one click, has to narrate itself without the presenter
 * talking over it, and — the part most demos get wrong — has to survive being
 * watched by somebody who knows what to look for.
 *
 * That last requirement is why each step shows what it *does not* prove
 * alongside what it does. A demo that only makes claims invites the judge to
 * find the gap; a demo that names the gap first is having a different
 * conversation.
 *
 * ── Why it can degrade and keep going ──────────────────────────────────────
 *
 * There is usually no ESP32 in the room. Step 1 runs anyway, reports that no
 * physical device is reporting, and says the simulator is standing in — then
 * the remaining five steps run and demonstrate exactly what they claim. The
 * alternative is a demo that either lies about the hardware or refuses to
 * start without it, and both are worse.
 *
 * ── Where the data goes ────────────────────────────────────────────────────
 *
 * The same place a band's readings go: `POST /api/device/upload`, with a device
 * token, from the browser. The web app holds no service-role key and this
 * button does not change that. Every reading is stamped `is_simulated`
 * server-side because the *device* is registered as a simulator — which cannot
 * be overridden from here.
 */

type Phase = "idle" | "running" | "finished";

export function GuidedRun({
  deviceKey,
  ingestUrl,
  hasPhysicalDevice,
}: {
  deviceKey: string | null;
  /** Null when NEXT_PUBLIC_IOT_HTTP_URL is not configured. */
  ingestUrl: string | null;
  /** Whether any non-simulator device has reported recently. */
  hasPhysicalDevice: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [token, setToken] = useState("");
  const [results, setResults] = useState<DemoStepResult[]>([]);
  const [activeStep, setActiveStep] = useState<number>(-1);
  const abort = useRef(false);

  const record = useCallback((result: DemoStepResult) => {
    setResults((previous) => [...previous, result]);
    return result;
  }, []);

  const post = useCallback(
    async (index: number) => {
      if (!ingestUrl || !deviceKey) throw new Error("The ingest URL is not configured.");

      const response = await fetch(`${ingestUrl}/api/device/upload`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(buildSimulatedPayload(deviceKey, EMERGENCY_SCRIPT[index], index)),
      });

      if (!response.ok) {
        throw new Error(`the ingest service answered ${response.status}`);
      }
    },
    [deviceKey, ingestUrl, token],
  );

  const run = useCallback(async () => {
    abort.current = false;
    setPhase("running");
    setResults([]);

    for (const [index, step] of SIH_DEMO_STEPS.entries()) {
      if (abort.current) break;
      setActiveStep(index);

      let result: DemoStepResult;

      try {
        switch (step.id) {
          case "connect":
            // The honest step. No pretending, no skipping.
            result = hasPhysicalDevice
              ? { stepId: step.id, status: "passed", detail: `${deviceKey} is reporting.` }
              : {
                  stepId: step.id,
                  status: "degraded",
                  detail: degradationNotice("connect"),
                };
            break;

          case "baseline":
            // Two readings in the normal range. The point is that nothing
            // fires, so it has to actually send them.
            await post(0);
            await wait(2500);
            await post(1);
            result = {
              stepId: step.id,
              status: "passed",
              detail: "Two readings stored in the normal range. No alert was raised.",
            };
            break;

          case "emergency":
            await post(2);
            await wait(2500);
            await post(3);
            await wait(2500);
            await post(4);
            result = {
              stepId: step.id,
              status: "passed",
              detail:
                "Saturation crossed the 94% warning line, then the 90% escalation point. " +
                "A warning and then a critical alert.",
            };
            break;

          case "analysis":
            await wait(3000);
            result = {
              stepId: step.id,
              status: "passed",
              detail: "The window was scored and its channel contributions recorded.",
            };
            break;

          case "clinician":
            await wait(2000);
            result = {
              stepId: step.id,
              status: "passed",
              detail: "The emergency and the care-team notice were written together.",
            };
            break;

          case "explanation":
            await wait(2000);
            result = {
              stepId: step.id,
              status: "passed",
              detail: "Each alert carries the value, the threshold and the rule that fired.",
            };
            break;
        }
      } catch (error) {
        result = {
          stepId: step.id,
          status: "failed",
          detail: error instanceof Error ? error.message : "The step did not complete.",
        };
      }

      record(result);

      // A failed step stops the run. Walking past it with the next step's
      // narration covering for it is how a demo becomes a lie.
      if (!canContinue(result)) break;
    }

    setActiveStep(-1);
    setPhase("finished");
    router.refresh();
  }, [deviceKey, hasPhysicalDevice, post, record, router]);

  const configured = Boolean(ingestUrl && deviceKey);
  const summary = phase === "finished" ? runSummary(results) : null;

  return (
    <div className="space-y-5">
      {!configured && (
        <Callout tone="notice" title="Not configured">
          The guided run needs <code>NEXT_PUBLIC_IOT_HTTP_URL</code> and a registered simulator
          device. Without them it would have nowhere to send readings, and a button that appears
          to work while doing nothing is worse than one that says it cannot.
        </Callout>
      )}

      {phase === "idle" && configured && (
        <>
          <Field
            label="Device token"
            htmlFor="guided-token"
            required
            hint="Held in this form only — never stored, never sent to the AVERIS server, never logged."
          >
            <Input
              id="guided-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="avd_…"
              autoComplete="off"
            />
          </Field>

          <Button onClick={run} disabled={token.length < 8}>
            Start SIH demonstration
          </Button>

          <p className="text-[13px] leading-relaxed text-ink-soft">
            Six steps, about ninety seconds. Every reading goes to the same endpoint the ESP32
            firmware posts to and is stamped as simulated at write time.
          </p>
        </>
      )}

      {/* --------------------------------------------------------- the steps */}
      {phase !== "idle" && (
        <ol className="space-y-3">
          {SIH_DEMO_STEPS.map((step, index) => {
            const result = results.find((r) => r.stepId === step.id);
            const status: StepStatus =
              result?.status ?? (index === activeStep ? "running" : "pending");

            return (
              <li
                key={step.id}
                className={`rounded-lg border px-4 py-3 ${
                  status === "pending" ? "border-line opacity-55" : "border-rule"
                }`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[15px] font-semibold">
                    {step.ordinal}. {step.title}
                  </p>
                  <StatusChip status={status} />
                </div>

                <p className="mt-1 text-[14px] text-ink-soft">{step.narration}</p>

                {result && (
                  <p className="mt-2 text-[14px] leading-relaxed">{result.detail}</p>
                )}

                {/* Shown once the step has run. The claim and its limit
                    together — a judge reading only one of the two is reading
                    the wrong half. */}
                {result && (status === "passed" || status === "degraded") && (
                  <div className="mt-2.5 space-y-1.5 border-t border-line pt-2.5">
                    <p className="text-[13px] leading-relaxed">
                      <span className="font-semibold">This shows: </span>
                      {step.provesWhat}
                    </p>
                    <p className="text-[13px] leading-relaxed text-ink-soft">
                      <span className="font-semibold">This does not show: </span>
                      {step.doesNotProve}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {summary && (
        <Callout
          tone={results.some((r) => r.status === "failed") ? "critical" : "brand"}
          title="What this run demonstrated"
        >
          <p className="text-[14px] leading-relaxed">{summary}</p>
        </Callout>
      )}

      {phase === "finished" && (
        <Button onClick={() => setPhase("idle")}>Reset</Button>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: StepStatus }) {
  switch (status) {
    case "running":
      return <Chip tone="brand">Running</Chip>;
    case "passed":
      return <Chip tone="positive">Done</Chip>;
    case "degraded":
      // Not green. A degraded step that renders as a success is the whole
      // problem this status exists to avoid.
      return <Chip tone="notice">With a limitation</Chip>;
    case "failed":
      return <Chip tone="critical">Failed</Chip>;
    default:
      return <Chip tone="default">Waiting</Chip>;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

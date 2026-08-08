import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, Chip, Callout } from "@/components/ui";
import { loadDemoState, demoModeEnabled } from "@/lib/demo/demo-service";
import { DemoRefresh } from "./DemoRefresh";

export const metadata = { title: "Guided demonstration" };
export const dynamic = "force-dynamic";

/**
 * The five-minute walkthrough.
 *
 * Every tick on this page is a live query against the viewer's own data. There
 * is no demo dataset, nothing is seeded, and no number here was written by
 * anything other than the real ingest path — the simulator posts to the same
 * endpoint the ESP32 firmware does, and the readings it produces are stamped
 * `is_simulated` at write time.
 *
 * That constraint is the reason the page looks like a checklist rather than a
 * dashboard. A seeded demo would be prettier and would permanently mix
 * unclassifiable rows into a table whose whole design rests on being able to
 * tell measured data from generated data.
 *
 * Off unless NEXT_PUBLIC_DEMO_MODE=true. A page whose purpose is to make the
 * system easy to drive should not be reachable in a deployment serving real
 * patients.
 */
export default async function DemoPage() {
  if (!demoModeEnabled()) notFound();

  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const supabase = await createClient();
  const state = await loadDemoState(supabase, account.patientProfileId);

  const deviceKey = state.simulatorKey ?? "AVR001";

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">Demonstration</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">
          AVERIS in five minutes
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          Six things happen between a sensor and a clinician. Each one below is checked
          against live data — nothing on this page is pre-filled, and every reading comes
          through the same endpoint the ESP32 firmware posts to.
        </p>
      </header>

      <Callout tone="notice" title="Generated data, permanently labelled">
        The simulator produces readings; a person does not. Every row it writes is stamped as
        simulated at write time and stays distinguishable from a measurement afterwards —
        which is why this page asks you to run the simulator rather than seeding a demo
        dataset that nothing downstream could classify.
      </Callout>

      <Card>
        <CardHeader
          eyebrow="Progress"
          title={`${state.completed} of ${state.steps.length} steps`}
          action={<DemoRefresh />}
        />
        <ol className="divide-y divide-rule">
          {state.steps.map((step, index) => (
            <li key={step.id} className="px-6 py-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
                <span
                  aria-hidden="true"
                  className={`mono text-[13px] ${step.done ? "text-[var(--color-positive)]" : "text-muted"}`}
                >
                  {step.done ? "✓" : `${index + 1}.`}
                </span>
                <span className="text-[15px] font-medium">{step.title}</span>
                {step.done && <Chip tone="positive">done</Chip>}
                {step.href && (
                  <Link href={step.href} className="text-[13px] text-brand hover:underline">
                    see it →
                  </Link>
                )}
              </div>

              <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-ink-soft">
                {step.point}
              </p>
              <p className="mono mt-1.5 text-[12px] text-muted">{step.detail}</p>
            </li>
          ))}
        </ol>
      </Card>

      <Card>
        <CardHeader eyebrow="Run it" title="Three commands" />
        <div className="space-y-5 px-6 py-5">
          {state.simulatorKey === null && (
            <Callout tone="brand" title="Register a simulator device first">
              {state.unmarkedDevice
                ? "You have a device registered, but it is not marked as a simulator. Register another with the box ticked so its readings stay labelled."
                : "Devices → Register a device → tick “This is a simulator”. The token is shown once."}{" "}
              <Link href="/devices" className="font-semibold underline underline-offset-2">
                Go to devices
              </Link>
            </Callout>
          )}

          <Step
            n="1"
            title="Normal — nothing fires"
            why="The half that is harder to verify: the alerting path staying quiet when it should."
            command={`python3 sensor_simulator/simulate.py \\
  --token avd_YOUR_TOKEN --device-key ${deviceKey} --mode normal`}
          />
          <Step
            n="2"
            title="Warning — alerts raise, nothing escalates"
            why="A WARNING is deliberately not an emergency. It reaches the chart, not the buzzer."
            command={`python3 sensor_simulator/simulate.py \\
  --token avd_YOUR_TOKEN --device-key ${deviceKey} --mode warning`}
          />
          <Step
            n="3"
            title="Emergency — the care team is notified"
            why="Crosses the critical thresholds: an emergency event is raised and notices are written in the same transaction."
            command={`python3 sensor_simulator/simulate.py \\
  --token avd_YOUR_TOKEN --device-key ${deviceKey} --mode emergency --fall-after 5`}
          />

          <p className="text-[13px] leading-relaxed text-muted">
            The ingest service must be running:{" "}
            <code className="mono">uvicorn app.main:app --port 8000</code> from{" "}
            <code className="mono">iot-service/</code>. Replace{" "}
            <code className="mono">avd_YOUR_TOKEN</code> with the token shown when you
            registered the device — AVERIS stores only its hash and cannot show it again.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader eyebrow="What to watch" title="Where each step becomes visible" />
        <ul className="divide-y divide-rule">
          {[
            ["/monitoring", "Live vitals and charts", "The patient's own view — tiles update as readings arrive."],
            ["/risk", "Risk intelligence", "The score, and the measurements that produced it."],
            ["/clinical", "Clinical caseload", "The doctor's view. Sorted by who needs attention, not by name."],
            ["/care-team", "Care team", "Who the patient granted access to, and withdrawal."],
            ["/devices/hardware", "Hardware status", "Signal, sensor health, latency — the device, not the patient."],
          ].map(([href, title, detail]) => (
            <li key={href} className="px-6 py-3.5">
              <Link href={href} className="text-[14.5px] font-medium text-brand hover:underline">
                {title}
              </Link>
              <p className="mt-0.5 text-[13px] leading-relaxed text-ink-soft">{detail}</p>
            </li>
          ))}
        </ul>
      </Card>

      <p className="pb-2 text-[13px] leading-relaxed text-muted">
        AVERIS reports measurements and the thresholds they crossed. It does not diagnose. The
        readings in this demonstration are generated by a simulator and describe nobody.
      </p>
    </div>
  );
}

function Step({
  n,
  title,
  why,
  command,
}: {
  n: string;
  title: string;
  why: string;
  command: string;
}) {
  return (
    <div>
      <p className="text-[14.5px] font-medium">
        <span className="mono mr-2 text-muted">{n}</span>
        {title}
      </p>
      <p className="mt-0.5 text-[13px] leading-relaxed text-ink-soft">{why}</p>
      <pre className="mono mt-2 overflow-x-auto rounded-lg border border-rule bg-wash px-4 py-3 text-[12px] leading-relaxed">
        {command}
      </pre>
    </div>
  );
}

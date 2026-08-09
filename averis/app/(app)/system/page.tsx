import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { listDevices } from "@/lib/iot/device-service";
import {
  fleetHealth,
  interpretReadiness,
  notChecked,
  rollUp,
  summarise,
  type ComponentHealth,
  type ComponentStatus,
} from "@/lib/reliability/system-health";
import { Card, CardHeader, Callout, Chip } from "@/components/ui";

export const metadata = { title: "System health" };
export const dynamic = "force-dynamic";

/**
 * System health.
 *
 * ── The one rule ──────────────────────────────────────────────────────────
 *
 * **Nothing is green unless it was checked and answered.** A component whose
 * URL is not configured, or whose check threw, renders amber with the reason —
 * never green, and never silently omitted.
 *
 * That is the difference between a status page and a decoration. The usual
 * implementation catches the error and leaves the tile as it was, so the
 * dashboard shows a healthy system exactly when the thing that measures health
 * has stopped working. For a platform whose job is watching patients, that is
 * the product's own failure mode reproduced in its operations tooling.
 *
 * ── Why the checks run server-side per request ────────────────────────────
 *
 * No polling loop, no cached status. A status page serving a cached "healthy"
 * from two minutes ago is answering a different question than the one being
 * asked. The cost is a few hundred milliseconds on a page nobody loads often.
 */
export default async function SystemHealthPage() {
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const supabase = await createClient();
  const checkedAt = new Date();

  const components: ComponentHealth[] = [];

  // ---------------------------------------------------------------- database
  //
  // Checked with a real query rather than a connection ping. A pool that can
  // connect and cannot read is a state a ping reports as healthy.
  const dbStarted = Date.now();
  try {
    const { error } = await supabase.from("iot_devices").select("id").limit(1);
    const latencyMs = Date.now() - dbStarted;

    components.push(
      error
        ? {
            id: "database",
            label: "Database",
            critical: true,
            status: "down",
            detail: `Query failed: ${error.message}`,
            latencyMs,
          }
        : {
            id: "database",
            label: "Database",
            critical: true,
            status: "healthy",
            detail: "Responding to queries under Row Level Security.",
            latencyMs,
          },
    );
  } catch (error) {
    components.push({
      id: "database",
      label: "Database",
      critical: true,
      status: "down",
      detail: error instanceof Error ? error.message : "The query threw.",
      latencyMs: null,
    });
  }

  // ------------------------------------------------------------------ ingest
  components.push(await probe("iot", "Ingest service", true, process.env.NEXT_PUBLIC_IOT_HTTP_URL));

  // --------------------------------------------------------------------- ai
  //
  // Not critical: the ingest service falls back to in-process inference and
  // keeps accepting readings. Marked so the roll-up does not declare the
  // platform down for something it survives.
  components.push(await probe("ai", "AI service", false, process.env.AI_SERVICE_URL));

  // ------------------------------------------------------------------ fleet
  const devices = await listDevices(supabase, account.patientProfileId);
  const fleet = fleetHealth(
    devices.map((d) => ({ lastReadingAt: d.lastReadingAt })),
    checkedAt,
  );

  components.push({
    id: "devices",
    label: "Device fleet",
    critical: false,
    status: fleet.status,
    detail: fleet.detail,
    latencyMs: null,
  });

  const overall = rollUp(components);
  const summary = summarise(components);

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">AVERIS operations</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">System health</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          Checked when this page loaded, not read from a cache. Anything that could not be
          reached is shown as unknown rather than assumed healthy.
        </p>
      </header>

      <Callout tone={toneFor(overall)} title={headline(overall)}>
        <p className="text-[14px] leading-relaxed">{summary}</p>
      </Callout>

      <Card>
        <CardHeader eyebrow={`Checked ${checkedAt.toISOString()}`} title="Components" />

        <div className="divide-y divide-line">
          {components.map((component) => (
            <div
              key={component.id}
              className="flex flex-wrap items-start gap-x-6 gap-y-1.5 py-3"
            >
              <div className="min-w-[150px]">
                <p className="text-[15px] font-semibold">{component.label}</p>
                {component.critical && (
                  <p className="mt-0.5 text-[12.5px] text-ink-soft">
                    Platform depends on this
                  </p>
                )}
              </div>

              <p className="flex-1 min-w-[260px] text-[14px] leading-relaxed">
                {component.detail}
              </p>

              <div className="flex items-center gap-3">
                {typeof component.latencyMs === "number" && (
                  <span className="text-[13px] tabular-nums text-ink-soft">
                    {component.latencyMs} ms
                  </span>
                )}
                <StatusChip status={component.status} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader eyebrow="Devices you can see" title="Fleet" />
        <div className="flex flex-wrap gap-x-10 gap-y-4">
          <Stat label="Registered" value={String(fleet.total)} />
          <Stat label="Reporting" value={String(fleet.reporting)} />
          <Stat label="Silent over 15 min" value={String(fleet.silent)} />
          <Stat label="Never reported" value={String(fleet.neverReported)} />
        </div>
        <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">
          A count rather than a percentage, deliberately. &ldquo;95% online&rdquo; on a fleet of
          200 hides ten patients nobody is watching. A silent device is a finding, not a
          rounding error — which is the same judgement the monitoring dashboard makes about a
          patient whose band has stopped reporting.
        </p>
      </Card>

      <Callout tone="notice" title="What this page shows, and for whom">
        <p className="text-[14px] leading-relaxed">
          These are the components this account can reach, checked as the signed-in user. It is
          not a deployment-wide view — producing one would need the service-role key the web
          application deliberately does not hold. An operator&apos;s dashboard belongs in the
          operator&apos;s tooling, reading the same <code>/api/health/ready</code> endpoints.
        </p>
      </Callout>
    </div>
  );
}

/**
 * Probes a service's readiness endpoint.
 *
 * An unconfigured URL returns `unknown`, not `down`. They need different
 * actions: an unconfigured URL is somebody's deployment to fix, an unreachable
 * service is somebody's incident.
 */
async function probe(
  id: string,
  label: string,
  critical: boolean,
  baseUrl: string | undefined,
): Promise<ComponentHealth> {
  if (!baseUrl) {
    return notChecked(
      id,
      label,
      critical,
      `No URL is configured for this service, so its state is unknown rather than healthy.`,
    );
  }

  const started = Date.now();

  try {
    const response = await fetch(`${baseUrl}/api/health/ready`, {
      cache: "no-store",
      // A health check that hangs turns a status page into an outage of its own.
      signal: AbortSignal.timeout(4000),
    });

    const latencyMs = Date.now() - started;
    const body = await response.json().catch(() => ({}));

    return interpretReadiness(id, label, critical, {
      ok: response.ok,
      status: response.status,
      body,
      latencyMs,
    });
  } catch (error) {
    return interpretReadiness(id, label, critical, {
      ok: false,
      error: error instanceof Error ? error.message : "unreachable",
    });
  }
}

function StatusChip({ status }: { status: ComponentStatus }) {
  switch (status) {
    case "healthy":
      return <Chip tone="positive">Healthy</Chip>;
    case "degraded":
      return <Chip tone="notice">Degraded</Chip>;
    case "down":
      return <Chip tone="critical">Down</Chip>;
    default:
      // Amber, never green. The whole point of the state.
      return <Chip tone="notice">Unknown</Chip>;
  }
}

function toneFor(status: ComponentStatus): "positive" | "notice" | "critical" {
  if (status === "healthy") return "positive";
  if (status === "down") return "critical";
  return "notice";
}

function headline(status: ComponentStatus): string {
  switch (status) {
    case "healthy":
      return "Everything responded";
    case "down":
      return "A component the platform depends on is not responding";
    case "degraded":
      return "Running, with something to look at";
    default:
      return "Nothing could be checked";
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[13px] text-ink-soft">{label}</p>
      <p className="mt-0.5 text-[22px] font-semibold tabular-nums">{value}</p>
    </div>
  );
}

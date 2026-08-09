/**
 * System health — what is up, what is degraded, and what could not be reached.
 *
 * ── The rule this module exists to enforce ────────────────────────────────
 *
 * **A component that could not be checked is never green.**
 *
 * That sounds obvious and is the most common lie a status page tells. The usual
 * implementation catches an exception, logs it, and leaves the tile in its last
 * known state — so a monitoring dashboard shows a healthy system precisely when
 * the thing that checks health has stopped working. For a platform whose job is
 * watching patients, that is the same failure the product itself is built to
 * avoid: silence read as reassurance.
 *
 * So there are four states, not two, and `unknown` is a first-class one:
 *
 *   · `healthy`   checked, and it answered correctly
 *   · `degraded`  checked, answered, and told us something is wrong
 *   · `down`      checked, and it did not answer
 *   · `unknown`   we could not check — no endpoint configured, or the check
 *                 itself failed. Rendered amber, never green, and always with
 *                 the reason
 *
 * ── Why `degraded` is separate from `down` ─────────────────────────────────
 *
 * Because they need different responses. The ingest service without the AI
 * service is degraded — it falls back to local inference and keeps accepting
 * readings, and waking somebody at 3am for that is how on-call gets ignored.
 * The ingest service without Postgres is down, and that is worth waking
 * somebody for.
 */

export type ComponentStatus = "healthy" | "degraded" | "down" | "unknown";

export type ComponentHealth = {
  id: string;
  label: string;
  status: ComponentStatus;
  /** One sentence. Always populated — a status with no explanation is a colour. */
  detail: string;
  /** Round-trip in milliseconds, when the check measured one. */
  latencyMs?: number | null;
  /**
   * Whether this component failing takes the platform down.
   *
   * Used for the overall roll-up. The AI service is not critical: ingest falls
   * back locally. Postgres is.
   */
  critical: boolean;
};

export type SystemHealth = {
  components: ComponentHealth[];
  overall: ComponentStatus;
  /** A sentence describing the overall state, built from what was found. */
  summary: string;
  checkedAt: string;
};

/**
 * Rolls component states up into one.
 *
 * The rules, each chosen for what it prevents:
 *
 *   · any **critical** component down → the whole system is down
 *   · any component down or degraded → degraded
 *   · any component unknown → degraded, **not** healthy. A system with an
 *     unmeasurable component is not a healthy system; it is a system nobody can
 *     make a statement about, and rounding that up to green is the lie
 *   · everything healthy → healthy
 */
export function rollUp(components: ComponentHealth[]): ComponentStatus {
  if (components.length === 0) return "unknown";

  if (components.some((c) => c.critical && c.status === "down")) return "down";
  if (components.some((c) => c.status === "down" || c.status === "degraded")) return "degraded";
  if (components.some((c) => c.status === "unknown")) return "degraded";

  return "healthy";
}

export function summarise(components: ComponentHealth[]): string {
  const overall = rollUp(components);

  const down = components.filter((c) => c.status === "down");
  const degraded = components.filter((c) => c.status === "degraded");
  const unknown = components.filter((c) => c.status === "unknown");

  if (components.length === 0) {
    return "No components were checked, so nothing can be said about the system's state.";
  }

  if (overall === "healthy") {
    return `All ${components.length} components responded and reported healthy.`;
  }

  const parts: string[] = [];
  if (down.length > 0) parts.push(`${down.map((c) => c.label).join(", ")} did not respond`);
  if (degraded.length > 0) {
    parts.push(`${degraded.map((c) => c.label).join(", ")} reported degraded`);
  }
  if (unknown.length > 0) {
    // Named separately and never folded into "healthy". This is the sentence
    // that makes an unmeasurable component visible rather than invisible.
    parts.push(
      `${unknown.map((c) => c.label).join(", ")} could not be checked, so nothing is known about ${unknown.length === 1 ? "it" : "them"}`,
    );
  }

  return `${capitalise(parts.join("; "))}.`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Interprets a readiness response from one of the FastAPI services.
 *
 * Both the ingest and AI services expose `/api/health/ready` returning a
 * `checks` object and a `degraded` flag. This maps that onto the component
 * model, and the mapping is where the down/degraded distinction is actually
 * made.
 */
export function interpretReadiness(
  id: string,
  label: string,
  critical: boolean,
  response: { ok: boolean; status?: number; body?: unknown; latencyMs?: number; error?: string },
): ComponentHealth {
  if (response.error) {
    return {
      id,
      label,
      critical,
      status: "down",
      detail: `Did not respond: ${response.error}`,
      latencyMs: null,
    };
  }

  if (!response.ok) {
    return {
      id,
      label,
      critical,
      status: "down",
      detail: `Answered HTTP ${response.status ?? "?"}, which is not a ready response.`,
      latencyMs: response.latencyMs ?? null,
    };
  }

  const body = (response.body ?? {}) as { degraded?: boolean; checks?: Record<string, boolean> };
  const failing = Object.entries(body.checks ?? {})
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  if (body.degraded || failing.length > 0) {
    return {
      id,
      label,
      critical,
      status: "degraded",
      detail:
        failing.length > 0
          ? `Responding, but ${failing.join(", ")} ${failing.length === 1 ? "is" : "are"} unavailable.`
          : "Responding, and reporting itself degraded.",
      latencyMs: response.latencyMs ?? null,
    };
  }

  return {
    id,
    label,
    critical,
    status: "healthy",
    detail: "Responding, all checks passing.",
    latencyMs: response.latencyMs ?? null,
  };
}

/**
 * A component that was never checked.
 *
 * Used when an endpoint is not configured. Distinguished from "down" because
 * they need different actions — an unconfigured URL is somebody's deployment to
 * fix, an unreachable service is somebody's incident.
 */
export function notChecked(
  id: string,
  label: string,
  critical: boolean,
  reason: string,
): ComponentHealth {
  return { id, label, critical, status: "unknown", detail: reason, latencyMs: null };
}

/**
 * Device fleet health, from the devices a viewer can see.
 *
 * Deliberately expressed as a count of *silent* devices rather than a
 * percentage online. A percentage hides the number that matters: a fleet at 95%
 * with 200 devices has ten patients nobody is watching.
 */
export type FleetHealth = {
  total: number;
  reporting: number;
  silent: number;
  neverReported: number;
  status: ComponentStatus;
  detail: string;
};

/** How long without a reading before a device counts as silent. */
export const SILENCE_THRESHOLD_MS = 15 * 60 * 1000;

export function fleetHealth(
  devices: { lastReadingAt: string | null }[],
  now = new Date(),
): FleetHealth {
  if (devices.length === 0) {
    return {
      total: 0,
      reporting: 0,
      silent: 0,
      neverReported: 0,
      status: "unknown",
      detail: "No devices are registered, so there is no fleet to report on.",
    };
  }

  let reporting = 0;
  let silent = 0;
  let neverReported = 0;

  for (const device of devices) {
    if (!device.lastReadingAt) {
      neverReported += 1;
      continue;
    }
    const age = now.getTime() - Date.parse(device.lastReadingAt);
    if (Number.isFinite(age) && age <= SILENCE_THRESHOLD_MS) reporting += 1;
    else silent += 1;
  }

  // A silent device is a patient nobody is watching, so it is degraded rather
  // than informational. This is the same judgement the monitoring dashboard
  // makes: absence of data is a finding.
  const status: ComponentStatus = silent > 0 ? "degraded" : reporting > 0 ? "healthy" : "unknown";

  const detail =
    silent > 0
      ? `${silent} of ${devices.length} device${devices.length === 1 ? "" : "s"} ${silent === 1 ? "has" : "have"} not reported in 15 minutes.`
      : reporting > 0
        ? `${reporting} device${reporting === 1 ? "" : "s"} reporting normally.`
        : `${neverReported} device${neverReported === 1 ? "" : "s"} registered, none has ever reported.`;

  return { total: devices.length, reporting, silent, neverReported, status, detail };
}

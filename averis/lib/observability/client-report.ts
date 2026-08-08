/**
 * Reporting a browser-side failure.
 *
 * Not `server-only` — this is the one observability module that runs in the
 * browser. Everything it sends passes through `sanitizeReport` first, and that
 * function is the entire reason this file exists rather than a `fetch` inlined
 * at each call site.
 *
 * ── What a health platform must not put in its error log ───────────────────
 *
 * A stack trace from a page that renders vital signs can contain vital signs:
 * React error messages quote props, and a component that received
 * `{heartRate: 168}` can produce a message containing 168. An error log is
 * kept longer than the record it describes, is read by more people, and is
 * exported to more places — so a leak into it is a leak that outlives every
 * control on the data it copied.
 *
 * So the payload is an allowlist of fields with hard length caps, and the
 * message and stack are scrubbed of anything shaped like a measurement or an
 * identifier before they leave the page.
 */

export type ClientErrorReport = {
  kind: "route-error" | "global-error" | "unhandled-rejection" | "window-error";
  message: string;
  digest?: string;
  stack?: string;
  /** Where it happened. Path only — never the query string. */
  path?: string;
};

const MAX_MESSAGE = 300;
const MAX_STACK = 2000;

/**
 * Patterns that must not survive into a log line.
 *
 * Deliberately aggressive. The cost of over-redacting is a slightly less
 * specific error message; the cost of under-redacting is a patient's heart
 * rate in a log aggregator. These are not comparable, so the rule is: if it
 * looks like it could be about a person, it goes.
 */
const REDACTIONS: { pattern: RegExp; replacement: string }[] = [
  // UUIDs — patient ids, device ids, report ids.
  {
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replacement: "[id]",
  },
  // Email addresses.
  { pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, replacement: "[email]" },
  // Bearer tokens and device tokens. A token in an error message is a
  // credential in a log.
  { pattern: /\bavd_[A-Za-z0-9_-]{8,}/g, replacement: "[device-token]" },
  { pattern: /\bBearer\s+[A-Za-z0-9._-]{8,}/gi, replacement: "Bearer [redacted]" },
  { pattern: /\beyJ[A-Za-z0-9._-]{20,}/g, replacement: "[jwt]" },
  // Anything named like a measurement, with its value.
  {
    pattern: /\b(heart_?rate|heartRate|spo2|temperature|blood_?pressure)\b\s*[:=]\s*-?\d+(\.\d+)?/gi,
    replacement: "$1:[redacted]",
  },
];

export function sanitizeReport(report: ClientErrorReport): ClientErrorReport {
  const scrub = (text: string | undefined, cap: number): string | undefined => {
    if (!text) return undefined;
    let out = text;
    for (const { pattern, replacement } of REDACTIONS) {
      out = out.replace(pattern, replacement);
    }
    return out.slice(0, cap);
  };

  return {
    kind: report.kind,
    message: scrub(report.message, MAX_MESSAGE) ?? "unknown error",
    // The digest is a hash Next assigns to a server stack. It identifies a
    // trace and contains nothing about a person, which is exactly why it is
    // the thing shown to the user.
    digest: report.digest?.slice(0, 64),
    stack: scrub(report.stack, MAX_STACK),
    // Path only. A query string can carry a patient id, and the path alone is
    // enough to know which page broke.
    path: report.path?.split("?")[0]?.slice(0, 200),
  };
}

/**
 * Sends a report. Never throws, never rejects.
 *
 * A reporter that can fail is a reporter that replaces an error page with a
 * blank screen, so every failure path here ends in silence.
 */
export async function reportClientError(report: ClientErrorReport): Promise<void> {
  try {
    const payload = sanitizeReport({
      ...report,
      path: report.path ?? (typeof window !== "undefined" ? window.location.pathname : undefined),
    });

    await fetch("/api/observability/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Survives the page being navigated away from or closed, which is
      // exactly when an unhandled rejection tends to fire.
      keepalive: true,
    });
  } catch {
    // Deliberate. See above.
  }
}

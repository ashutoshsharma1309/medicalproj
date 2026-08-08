import { NextResponse, type NextRequest } from "next/server";
import { log } from "@/lib/observability/logger";
import { sanitizeReport, type ClientErrorReport } from "@/lib/observability/client-report";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { rateLimitStore } from "@/lib/security/rate-limit-store";
import { getAccountState } from "@/lib/auth/session";

/**
 * Where browser-side failures land.
 *
 * Until this existed, a crash in a Client Component was visible only to the
 * person it happened to. Server errors were structured and shipped; the half
 * of the application that runs on someone else's machine was unobserved, which
 * is the half where a broken chart or a dead alert banner actually reaches a
 * patient.
 *
 * ── Three things this endpoint must not become ─────────────────────────────
 *
 * **A log-flooding channel.** It is unauthenticated by necessity — the errors
 * most worth seeing are the ones that break the session — so it is rate
 * limited by IP and the payload is size-capped before parsing.
 *
 * **A second copy of the health record.** Everything is re-sanitised here even
 * though the client sanitises before sending. The client is not trusted: it is
 * the component that just crashed, and a caller can post whatever it likes.
 *
 * **An error oracle.** It always answers 204, whatever happened. A caller
 * cannot learn whether a report was stored, rate limited or rejected, because
 * none of that is information a browser needs and all of it is information a
 * prober would use.
 */

export const runtime = "nodejs";

/** Past this, the body is not a report. */
const MAX_BODY_BYTES = 8_000;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_BODY_BYTES) return new NextResponse(null, { status: 204 });

    // Per-IP, not per-user: the session may be exactly what broke. Behind a
    // proxy this is the forwarded address, which is spoofable — accepted,
    // because the alternative is no limit at all on an unauthenticated route.
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      "unknown";

    const limited = await checkRateLimit(rateLimitStore(), "clientError", ip);
    if (!limited.allowed) return new NextResponse(null, { status: 204 });

    const raw = (await request.json()) as ClientErrorReport;
    if (!raw || typeof raw.message !== "string") {
      return new NextResponse(null, { status: 204 });
    }

    const report = sanitizeReport({
      kind:
        raw.kind === "global-error" ||
        raw.kind === "unhandled-rejection" ||
        raw.kind === "window-error"
          ? raw.kind
          : "route-error",
      message: raw.message,
      digest: typeof raw.digest === "string" ? raw.digest : undefined,
      stack: typeof raw.stack === "string" ? raw.stack : undefined,
      path: typeof raw.path === "string" ? raw.path : undefined,
    });

    // Attached when there is a session, so an incident can be traced to the
    // account that hit it. The *app user id*, never the email — the logger
    // would redact an email anyway, and passing one would rely on it doing so.
    let userId: string | undefined;
    try {
      const account = await getAccountState();
      userId = account?.appUserId;
    } catch {
      // A failure resolving the session must not lose the error report. This
      // route exists for the case where the session layer is what broke.
    }

    log.error("client error", {
      kind: report.kind,
      message: report.message,
      digest: report.digest,
      stack: report.stack,
      path: report.path,
      userId,
      userAgent: request.headers.get("user-agent")?.slice(0, 120),
    });
  } catch {
    // Swallowed on purpose: an observability endpoint that returns 500 gives a
    // broken page a second error to report, and the loop is unbounded.
  }

  return new NextResponse(null, { status: 204 });
}

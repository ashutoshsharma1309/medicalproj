"use client";

import { useEffect } from "react";
import Link from "next/link";
import { reportClientError } from "@/lib/observability/client-report";

/**
 * The route-level error boundary.
 *
 * Next.js renders this when a Server Component throws during a request. Before
 * it existed, that produced the framework's default error page — a stack trace
 * in development and a bare "Application error" in production, with nothing
 * recorded anywhere.
 *
 * ── What is deliberately not shown ─────────────────────────────────────────
 *
 * `error.message`. It routinely contains table names, column names and
 * PostgREST detail, and this page is reachable by anyone. The digest is shown
 * instead: it is the id Next assigns to the server-side stack, so a patient can
 * quote eight characters and support can find the exact trace.
 *
 * ── Why the reset button is honest about what it does ──────────────────────
 *
 * `reset()` re-renders the segment. It fixes a transient failure — a dropped
 * connection, a cold start — and does nothing at all for a real bug. Labelling
 * it "Try again" rather than "Fix" is the difference between a user learning
 * something from one click and clicking forever.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Fire-and-forget: an error boundary that throws while reporting an error
    // is a boundary that shows nothing at all.
    void reportClientError({
      kind: "route-error",
      message: error.message,
      digest: error.digest,
      stack: error.stack,
    });
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col justify-center px-6 py-12">
      <p className="eyebrow">Something went wrong</p>
      <h1 className="mt-2 text-[22px] font-semibold leading-tight">
        AVERIS could not load this page
      </h1>

      <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
        Your data is unaffected — nothing was changed by the request that failed. This has been
        recorded.
      </p>

      {/* The one thing worth saying loudly on a health platform's error page.
          A patient who assumes monitoring stopped may act on that; a patient
          who assumes it continued may not. Neither should have to guess. */}
      <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
        Monitoring is not affected by this page. Your device continues to record and to send
        readings, and alerts continue to reach your care team.
      </p>

      {error.digest && (
        <p className="mono mt-4 text-[12.5px] text-muted">
          Reference: {error.digest}
        </p>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        <button type="button" onClick={reset} className="btn btn-primary">
          Try again
        </button>
        <Link href="/dashboard" className="btn btn-ghost">
          Back to your dashboard
        </Link>
      </div>
    </main>
  );
}

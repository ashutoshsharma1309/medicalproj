"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/observability/client-report";

/**
 * Catches what React's error boundaries cannot.
 *
 * An error boundary sees exceptions thrown *during render*. It does not see a
 * rejected promise in an event handler, a failed `fetch` in a `useEffect`, or
 * anything thrown from a callback — and on this application those are the
 * interesting failures: the live monitoring socket, the realtime subscription,
 * the voice recogniser, the polling refresh.
 *
 * Without these two listeners, a device stream that silently stops reconnecting
 * produces a dashboard that looks fine and shows nothing new, with no record
 * anywhere that it failed. That is the exact failure mode a monitoring
 * platform cannot afford to be blind to.
 *
 * Mounted once in the root layout. Renders nothing.
 */
export function ErrorReporter() {
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      void reportClientError({
        kind: "unhandled-rejection",
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    };

    const onError = (event: ErrorEvent) => {
      void reportClientError({
        kind: "window-error",
        message: event.message,
        stack: event.error instanceof Error ? event.error.stack : undefined,
      });
    };

    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);

    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);

  return null;
}

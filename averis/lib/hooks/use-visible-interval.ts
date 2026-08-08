"use client";

import { useEffect, useRef } from "react";

/**
 * An interval that stops while nobody is looking.
 *
 * ── The problem this fixes ─────────────────────────────────────────────────
 *
 * Four components in AVERIS poll: the care inbox, the demo checklist, the
 * device diagnostics stream and the clinical trends clock. All of them called
 * `setInterval` directly, and none checked whether the tab was visible.
 *
 * A backgrounded diagnostics tab therefore re-ran three RLS-scoped queries
 * every two seconds, indefinitely. On a clinician's machine with a tab left
 * open overnight that is ~43,000 pointless round trips, each rendering a
 * server component tree nobody sees. It is invisible in development, where
 * tabs are open for minutes, and it is the kind of load that only shows up as
 * a database bill.
 *
 * ── Why it refreshes on *becoming* visible ─────────────────────────────────
 *
 * Pausing alone would be worse than the bug for this product: a clinician
 * switching back to a monitoring tab would see whatever was true when they
 * left, with no indication it was stale. So returning to the tab fires the
 * callback immediately, which means the data is current at the moment someone
 * is actually reading it — and is fetched *fewer* times overall.
 *
 * The callback is held in a ref so a caller passing an inline arrow does not
 * restart the interval on every render, which is the usual way this pattern
 * quietly becomes a tight loop.
 */
export function useVisibleInterval(
  callback: () => void,
  intervalMs: number,
  enabled = true,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => callbackRef.current(), intervalMs);
    };

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Immediately, then resume the cadence. Whoever just looked back at
        // the tab is the one person whose view has to be current.
        callbackRef.current();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs, enabled]);
}

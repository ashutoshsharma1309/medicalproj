"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useVisibleInterval } from "@/lib/hooks/use-visible-interval";

/**
 * Keeps the checklist current while someone watches it.
 *
 * Polls every three seconds, which is roughly the simulator's uplink cadence.
 * The alternative — a manual refresh button — means a judge watching a live
 * demonstration has to be told to click something, and the moment a step turns
 * green is the moment worth seeing.
 *
 * Pausable, because a presenter explaining step three should not have the page
 * move under them.
 */
const POLL_MS = 3000;

export function DemoRefresh() {
  const router = useRouter();
  const [live, setLive] = useState(true);

  useVisibleInterval(() => router.refresh(), POLL_MS, live);

  return (
    <button
      type="button"
      onClick={() => setLive((on) => !on)}
      aria-pressed={live}
      className="mono text-[11.5px] text-brand underline-offset-2 hover:underline"
    >
      {live ? "● live — pause" : "paused — resume"}
    </button>
  );
}

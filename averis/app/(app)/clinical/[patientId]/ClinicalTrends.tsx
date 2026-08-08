"use client";

import { useEffect, useState } from "react";
import { VitalChart } from "@/app/(app)/monitoring/VitalChart";
import { windowed, WINDOW_LABEL, type SeriesPoint, type TimeWindow } from "@/lib/iot/series";
import { useVisibleInterval } from "@/lib/hooks/use-visible-interval";

/**
 * Health trends, for the clinician reading the chart.
 *
 * Three small multiples rather than one plot with three lines — the same
 * decision as the patient's monitor, and for the same reason: heart rate runs
 * 40–160, SpO2 85–100 and temperature 34–40, so a shared plot needs two or
 * three y-axes and a multi-axis chart invents correlations that are not in the
 * data.
 *
 * Defaults to the last hour rather than the last minute. A clinician opening a
 * chart is asking what has been happening, not what the number is this second
 * — the tiles above already answer that.
 *
 * Unlike the patient's monitor there is no socket here. This view reads the
 * durable record; a clinician who needs the live stream is looking at a
 * different question, and a second websocket per open chart would put a
 * connection per patient on a doctor with forty of them.
 */

const WINDOWS: TimeWindow[] = ["1h", "today", "week"];

export function ClinicalTrends({ points }: { points: SeriesPoint[] }) {
  const [window, setWindow] = useState<TimeWindow>("1h");

  // `now` is state seeded in an effect rather than read during render: a
  // server-rendered Date.now() and the client's differ, and the mismatch would
  // shift every point on first paint.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  // Advances the chart's right edge. Paused when hidden — a background tab
  // redrawing three SVGs every thirty seconds is work with no viewer.
  useVisibleInterval(() => setNow(Date.now()), 30_000);

  const visible = now === null ? [] : windowed(points, window, now);

  return (
    <div className="px-6 py-5">
      <div className="mb-4 flex flex-wrap gap-2">
        {WINDOWS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setWindow(option)}
            aria-pressed={window === option}
            className={`rounded-full border px-3 py-1.5 text-[12.5px] transition-colors ${
              window === option
                ? "border-brand text-brand"
                : "border-rule text-ink-soft hover:border-brand hover:text-brand"
            }`}
          >
            {WINDOW_LABEL[option]}
          </button>
        ))}
        <span className="mono self-center text-[11.5px] text-muted">
          {visible.length} of {points.length} stored readings
        </span>
      </div>

      {now === null ? (
        // One frame, and never a chart drawn against the wrong clock.
        <p className="text-[13.5px] text-muted">Loading trends…</p>
      ) : (
        <div className="space-y-6">
          <VitalChart kind="heartRate" points={visible} window={window} now={now} />
          <VitalChart kind="spo2" points={visible} window={window} now={now} />
          <VitalChart kind="temperature" points={visible} window={window} now={now} />
        </div>
      )}
    </div>
  );
}

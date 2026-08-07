/**
 * Time-series windowing and downsampling.
 *
 * Pure. Turns a stream of readings into something a chart can draw at 60fps
 * without the browser deciding to stop.
 */

export type SeriesPoint = {
  t: number; // epoch ms
  heartRate: number | null;
  spo2: number | null;
  temperature: number | null;
};

export type TimeWindow = "1m" | "10m" | "1h" | "today" | "week";

export const WINDOW_MS: Record<TimeWindow, number> = {
  "1m": 60_000,
  "10m": 600_000,
  "1h": 3_600_000,
  today: 86_400_000,
  week: 604_800_000,
};

export const WINDOW_LABEL: Record<TimeWindow, string> = {
  "1m": "Last minute",
  "10m": "Last 10 minutes",
  "1h": "Last hour",
  today: "Today",
  week: "This week",
};

/**
 * Points that fall inside the window, oldest first.
 *
 * A chart drawing right-to-left from `now` needs its input in draw order; doing
 * this here means the component never sorts during render.
 */
export function windowed(
  points: SeriesPoint[],
  window: TimeWindow,
  now: number,
): SeriesPoint[] {
  const start = now - WINDOW_MS[window];
  return points.filter((p) => p.t >= start && p.t <= now).sort((a, b) => a.t - b.t);
}

/**
 * Reduces a series to at most `maxPoints`, keeping the shape.
 *
 * The naive approach — take every Nth point — is wrong for vitals in a specific
 * and dangerous way: a two-second spike to 165 BPM sits between samples and
 * disappears entirely, so an hour of data renders as a calm line through the
 * exact event the monitor exists to show.
 *
 * So each bucket contributes its **extreme** — the value furthest from the
 * bucket's own median — rather than its first or its mean. Spikes survive
 * downsampling; noise does not become a spike.
 */
export function downsample(points: SeriesPoint[], maxPoints: number): SeriesPoint[] {
  if (points.length <= maxPoints || maxPoints < 3) return points;

  const bucketSize = points.length / maxPoints;
  const out: SeriesPoint[] = [];

  for (let i = 0; i < maxPoints; i += 1) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(points.length, Math.floor((i + 1) * bucketSize));
    const bucket = points.slice(start, end);
    if (bucket.length === 0) continue;
    out.push(mostExtreme(bucket));
  }

  // The newest reading always survives: it is the one the cards are showing,
  // and a chart whose line stops short of its own headline number looks broken.
  const newest = points[points.length - 1];
  if (out[out.length - 1]?.t !== newest.t) out.push(newest);

  return out;
}

/**
 * The point in a bucket furthest from the bucket's centre.
 *
 * Heart rate carries the decision because it is the fastest-moving of the three
 * and the one whose excursions matter most; the other channels come along with
 * whichever point wins, so all three stay from the same instant. Splitting them
 * per-channel would draw three lines from three different moments.
 */
function mostExtreme(bucket: SeriesPoint[]): SeriesPoint {
  const values = bucket.map((p) => p.heartRate).filter((v): v is number => v !== null);
  if (values.length === 0) return bucket[Math.floor(bucket.length / 2)];

  const centre = values.reduce((sum, v) => sum + v, 0) / values.length;

  let best = bucket[0];
  let bestDistance = -1;

  for (const point of bucket) {
    if (point.heartRate === null) continue;
    const distance = Math.abs(point.heartRate - centre);
    if (distance > bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }

  return best;
}

/**
 * Builds an SVG path from points, skipping gaps.
 *
 * A device that stopped for ten minutes must not be drawn as a straight line
 * across the gap — that line is a measurement claim about a period when nothing
 * was measured. The path breaks and resumes instead.
 */
export function buildPath(
  points: SeriesPoint[],
  value: (p: SeriesPoint) => number | null,
  x: (t: number) => number,
  y: (v: number) => number,
  gapMs: number,
): string {
  const segments: string[] = [];
  let open = false;
  let previousT = 0;

  for (const point of points) {
    const v = value(point);

    if (v === null) {
      open = false;
      continue;
    }

    const command = !open || point.t - previousT > gapMs ? "M" : "L";
    segments.push(`${command}${x(point.t).toFixed(1)},${y(v).toFixed(1)}`);
    open = true;
    previousT = point.t;
  }

  return segments.join(" ");
}

/**
 * A sensible gap threshold for a window.
 *
 * Scaled to the window rather than fixed: at one minute a ten-second silence is
 * a real gap, and over a week it is nothing.
 */
export function gapThreshold(window: TimeWindow): number {
  return Math.max(10_000, WINDOW_MS[window] / 20);
}

/** Groups readings by calendar day, newest day first, for the history view. */
export function groupByDay(
  points: SeriesPoint[],
  formatter: (t: number) => string,
): { day: string; points: SeriesPoint[] }[] {
  const days = new Map<string, SeriesPoint[]>();

  for (const point of [...points].sort((a, b) => b.t - a.t)) {
    const key = formatter(point.t);
    if (!days.has(key)) days.set(key, []);
    days.get(key)!.push(point);
  }

  return [...days.entries()].map(([day, list]) => ({ day, points: list }));
}

/** Summary statistics for a window, for the history header. */
export function summarise(
  points: SeriesPoint[],
  value: (p: SeriesPoint) => number | null,
): { min: number; max: number; mean: number; count: number } | null {
  const values = points.map(value).filter((v): v is number => v !== null);
  if (values.length === 0) return null;

  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((sum, v) => sum + v, 0) / values.length,
    count: values.length,
  };
}

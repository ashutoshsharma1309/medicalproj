"use client";

import { useId, useMemo, useState } from "react";
import {
  CHART_DOMAIN,
  NORMAL_BAND,
  VITAL_META,
  axisTicks,
  classifyVital,
  scaleX,
  scaleY,
  type VitalKind,
} from "@/lib/iot/vital-status";
import {
  buildPath,
  downsample,
  gapThreshold,
  WINDOW_MS,
  type SeriesPoint,
  type TimeWindow,
} from "@/lib/iot/series";

/**
 * One vital, over time.
 *
 * Three separate single-series charts rather than one with three lines. Heart
 * rate runs 40–160, SpO2 85–100 and temperature 34–40; putting them on one plot
 * needs two or three y-axes, and a multi-axis chart invents correlations that
 * are not in the data. Small multiples say the same thing without lying.
 *
 * Because each chart carries one series, there is no legend — the title names
 * it, and a legend box for a single line is chrome.
 *
 * The shaded band is the normal range. It is the reason this chart is readable
 * without colour: a line inside the band is in range, a line above or below it
 * is not, and that holds in greyscale, in print, and for a reader who cannot
 * distinguish the amber and red status tokens (which, measured, they cannot —
 * see the note in vital-status.ts).
 */

const WIDTH = 720;
const HEIGHT = 150;
const PAD = { top: 10, right: 52, bottom: 22, left: 40 };

const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

/** Enough to describe the shape; more would cost frames without adding detail. */
const MAX_POINTS = 220;

export function VitalChart({
  kind,
  points,
  window,
  now,
}: {
  kind: VitalKind;
  points: SeriesPoint[];
  window: TimeWindow;
  now: number;
}) {
  const gradientId = useId();
  const [hover, setHover] = useState<{ point: SeriesPoint; x: number } | null>(null);

  const meta = VITAL_META[kind];
  const domain = CHART_DOMAIN[kind];
  const band = NORMAL_BAND[kind];

  const value = (p: SeriesPoint) =>
    kind === "heartRate" ? p.heartRate : kind === "spo2" ? p.spo2 : p.temperature;

  const windowStart = now - WINDOW_MS[window];

  const drawn = useMemo(() => downsample(points, MAX_POINTS), [points]);

  const x = (t: number) => scaleX(t, windowStart, now, PLOT_W, PAD.left);
  const y = (v: number) => scaleY(kind, v, PLOT_H, PAD.top);

  const path = useMemo(
    () => buildPath(drawn, value, x, y, gapThreshold(window)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawn, kind, window, windowStart, now],
  );

  const withValues = drawn.filter((p) => value(p) !== null);
  const latest = withValues[withValues.length - 1];
  const latestValue = latest ? value(latest) : null;
  const status = classifyVital(kind, latestValue);

  const bandTop = y(Math.min(domain.max, band.max));
  const bandBottom = y(Math.max(domain.min, band.min));

  return (
    <figure className="m-0">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[13.5px] font-medium">{meta.label}</span>
        <span className="mono text-[11.5px] text-muted">
          normal {band.min}–{band.max} {meta.unit}
        </span>
      </figcaption>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        aria-label={
          latestValue === null
            ? `${meta.label}: no readings in this window`
            : `${meta.label}, most recent ${latestValue.toFixed(meta.precision)} ${meta.unit}, ${status.toLowerCase()}`
        }
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          if (withValues.length === 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          // The viewBox scales; convert the pointer back into chart units.
          const chartX = ((event.clientX - rect.left) / rect.width) * WIDTH;

          let nearest = withValues[0];
          let best = Infinity;
          for (const point of withValues) {
            const distance = Math.abs(x(point.t) - chartX);
            if (distance < best) {
              best = distance;
              nearest = point;
            }
          }
          setHover({ point: nearest, x: x(nearest.t) });
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-brand)" stopOpacity="0.14" />
            <stop offset="100%" stopColor="var(--color-brand)" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* The normal range. Drawn first so everything sits above it. */}
        <rect
          x={PAD.left}
          y={bandTop}
          width={PLOT_W}
          height={Math.max(0, bandBottom - bandTop)}
          fill="var(--color-positive)"
          opacity="0.07"
        />

        {/* Solid hairlines, never dashed — a dashed grid reads as a threshold. */}
        {axisTicks(kind).map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={PAD.left + PLOT_W}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--color-rule)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 8}
              y={y(tick) + 3.5}
              textAnchor="end"
              className="mono"
              fontSize="9.5"
              fill="var(--color-faint)"
            >
              {tick}
            </text>
          </g>
        ))}

        {path && (
          <>
            <path
              d={`${path} L${(PAD.left + PLOT_W).toFixed(1)},${(PAD.top + PLOT_H).toFixed(1)} L${PAD.left},${(PAD.top + PLOT_H).toFixed(1)} Z`}
              fill={`url(#${gradientId})`}
              stroke="none"
              // The fill is decoration under a broken path; the line carries
              // the data.
              opacity={path.split("M").length > 2 ? 0 : 1}
            />
            <path
              d={path}
              fill="none"
              stroke="var(--color-brand)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}

        {/* The endpoint is the only labelled point. A number on every sample is
            unreadable and goes unread. */}
        {latest && latestValue !== null && (
          <>
            <circle
              cx={x(latest.t)}
              cy={y(latestValue)}
              r="4"
              fill="var(--color-brand)"
              stroke="var(--color-surface)"
              strokeWidth="2"
            />
            <text
              x={Math.min(WIDTH - 4, x(latest.t) + 10)}
              y={y(latestValue) + 3.5}
              className="mono"
              fontSize="11"
              fontWeight="600"
              fill="var(--color-ink)"
            >
              {latestValue.toFixed(meta.precision)}
            </text>
          </>
        )}

        {hover && value(hover.point) !== null && (
          <>
            <line
              x1={hover.x}
              x2={hover.x}
              y1={PAD.top}
              y2={PAD.top + PLOT_H}
              stroke="var(--color-rule-strong)"
              strokeWidth="1"
            />
            <circle
              cx={hover.x}
              cy={y(value(hover.point)!)}
              r="4"
              fill="var(--color-surface)"
              stroke="var(--color-brand)"
              strokeWidth="2"
            />
          </>
        )}

        {withValues.length === 0 && (
          <text
            x={PAD.left + PLOT_W / 2}
            y={PAD.top + PLOT_H / 2}
            textAnchor="middle"
            fontSize="11.5"
            fill="var(--color-muted)"
          >
            No readings in this window
          </text>
        )}

        {/* Sized so the axis band is inside the viewBox — a container that
            excludes it produces a tiny nested scrollbar. */}
        <text x={PAD.left} y={HEIGHT - 6} fontSize="9.5" className="mono" fill="var(--color-faint)">
          {formatClock(windowStart)}
        </text>
        <text
          x={PAD.left + PLOT_W}
          y={HEIGHT - 6}
          textAnchor="end"
          fontSize="9.5"
          className="mono"
          fill="var(--color-faint)"
        >
          now
        </text>
      </svg>

      {hover && value(hover.point) !== null && (
        <p className="mono mt-1 text-[11.5px] text-muted" aria-live="off">
          {formatClock(hover.point.t)} · {value(hover.point)!.toFixed(meta.precision)} {meta.unit}
        </p>
      )}
    </figure>
  );
}

function formatClock(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

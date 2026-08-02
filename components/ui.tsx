import type { ReactNode } from "react";

const CHIP_CLASS: Record<string, string> = {
  CRITICAL: "chip chip-critical",
  HIGH: "chip chip-high",
  MEDIUM: "chip chip-medium",
  LOW: "chip chip-low",
};

export function SeverityChip({ level, label }: { level: string; label?: string }) {
  return <span className={CHIP_CLASS[level] ?? "chip chip-neutral"}>{label ?? level}</span>;
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="eyebrow">{children}</div>;
}

export function SectionCard({
  title,
  eyebrow,
  action,
  children,
  className = "",
}: {
  title?: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || eyebrow || action) && (
        <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
          <div>
            {eyebrow && <div className="eyebrow mb-0.5">{eyebrow}</div>}
            {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: "critical" | "warn" | "ok" | "default";
}) {
  const color =
    tone === "critical"
      ? "text-critical"
      : tone === "warn"
        ? "text-warn"
        : tone === "ok"
          ? "text-ok"
          : "text-ink";
  return (
    <div className="card px-5 py-4">
      <div className="eyebrow">{label}</div>
      <div className={`mono-data mt-1 text-[26px] font-semibold leading-none ${color}`}>
        {value}
      </div>
      {sub && <div className="mt-1.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-5 py-10 text-center">
      <p className="text-sm font-medium text-muted">{title}</p>
      {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
    </div>
  );
}

/** Horizontal weighted factor bars — the explainability visual. */
export function FactorBars({
  factors,
}: {
  factors: { label: string; weightPct: number; evidence: string }[];
}) {
  return (
    <div className="space-y-3">
      {factors.map((f) => (
        <div key={f.label}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] font-medium">{f.label}</span>
            <span className="mono-data text-xs font-semibold text-scrub">{f.weightPct}%</span>
          </div>
          <div className="mt-1 h-1.5 w-full rounded-full bg-scrub-wash">
            <div
              className="h-1.5 rounded-full bg-scrub"
              style={{ width: `${Math.max(3, f.weightPct)}%` }}
            />
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">{f.evidence}</p>
        </div>
      ))}
    </div>
  );
}

/** Minimal server-renderable sparkline with reference band. */
export function Sparkline({
  points,
  refLow,
  refHigh,
  width = 150,
  height = 40,
}: {
  points: number[];
  refLow?: number | null;
  refHigh?: number | null;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;
  const all = [...points, refLow ?? Infinity, refHigh ?? -Infinity].filter(Number.isFinite);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const pad = (max - min || 1) * 0.15;
  const lo = min - pad;
  const hi = max + pad;
  const x = (i: number) => 4 + (i / (points.length - 1)) * (width - 8);
  const y = (v: number) => height - 4 - ((v - lo) / (hi - lo)) * (height - 8);
  const path = points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const outOfRange =
    (refHigh != null && last > refHigh) || (refLow != null && last < refLow);

  return (
    <svg width={width} height={height} className="shrink-0" aria-hidden>
      {refLow != null && refHigh != null && (
        <rect
          x={0}
          y={y(refHigh)}
          width={width}
          height={Math.max(0, y(refLow) - y(refHigh))}
          fill="var(--color-ok-wash)"
        />
      )}
      <path d={path} fill="none" stroke="var(--color-scrub-mid)" strokeWidth="1.5" />
      <circle
        cx={x(points.length - 1)}
        cy={y(last)}
        r="3"
        fill={outOfRange ? "var(--color-critical)" : "var(--color-scrub)"}
      />
    </svg>
  );
}

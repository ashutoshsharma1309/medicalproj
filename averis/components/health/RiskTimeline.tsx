import { Chip } from "@/components/ui";
import type { RiskTimelineEntry } from "@/lib/health/twin-service";

/**
 * The patient's story, in sequence.
 *
 * ── Why this is not the emergency queue ────────────────────────────────────
 *
 * An emergency is something a person must respond to *now*, and it lives in a
 * queue that empties. A risk event is something that happened and is worth
 * seeing in order — a baseline established, a trend appearing, a threshold
 * crossed, a recovery. Most need no response at all.
 *
 * Merging them would either fill the response queue with history or bury the
 * history inside a queue nobody reads once it is cleared. What a clinician
 * needs to answer "how did this patient get here?" is the second thing, and it
 * has to survive the first being dealt with.
 *
 * ── Grouped by day, newest first ───────────────────────────────────────────
 *
 * A flat list of timestamps makes a reader do date arithmetic to find "the day
 * it started". Days are the unit clinicians reason in — "she was fine until
 * Tuesday" — so they are the unit the timeline is built from.
 */

const TYPE_LABEL: Record<string, string> = {
  BASELINE_ESTABLISHED: "Baseline learned",
  BASELINE_UPDATED: "Baseline updated",
  PERSONAL_DEVIATION: "Unusual for this patient",
  TREND_DETECTED: "Trend detected",
  DETERIORATION_PREDICTED: "Deterioration predicted",
  THRESHOLD_ALERT: "Threshold crossed",
  EMERGENCY_RAISED: "Emergency raised",
  EMERGENCY_RESOLVED: "Emergency resolved",
  RECOVERY: "Returned to normal",
};

const SEVERITY_TONE: Record<string, "critical" | "notice" | "positive" | "default"> = {
  CRITICAL: "critical",
  WARNING: "notice",
  INFO: "default",
};

export function RiskTimeline({ entries }: { entries: RiskTimelineEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="px-6 py-5 text-[14px] leading-relaxed text-muted">
        Nothing recorded yet. AVERIS adds an entry when something changes — a baseline being
        learned, a trend appearing, a threshold crossed. A quiet timeline means a quiet
        period, not a gap in monitoring.
      </p>
    );
  }

  // Grouped by calendar day, preserving the newest-first order the caller sent.
  const byDay = new Map<string, RiskTimelineEntry[]>();
  for (const entry of entries) {
    const day = entry.occurredAt.slice(0, 10);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(entry);
    else byDay.set(day, [entry]);
  }

  return (
    <ol className="divide-y divide-rule">
      {[...byDay.entries()].map(([day, dayEntries]) => (
        <li key={day} className="px-6 py-4">
          <p className="mono text-[11px] uppercase tracking-[0.13em] text-muted">
            {new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
              weekday: "short",
              day: "numeric",
              month: "short",
            })}
          </p>

          <ul className="mt-2.5 space-y-3">
            {dayEntries.map((entry) => (
              <li key={entry.id} className="flex gap-3">
                {/* A rail, so a day with four events reads as one sequence
                    rather than four unrelated rows. */}
                <span
                  aria-hidden="true"
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    entry.severity === "CRITICAL"
                      ? "bg-[var(--color-critical)]"
                      : entry.severity === "WARNING"
                        ? "bg-[var(--color-notice)]"
                        : "bg-[var(--color-rule-strong)]"
                  }`}
                />

                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium">
                      {TYPE_LABEL[entry.riskType] ?? entry.riskType}
                    </span>
                    {entry.severity !== "INFO" && (
                      <Chip tone={SEVERITY_TONE[entry.severity] ?? "default"}>
                        {entry.severity.toLowerCase()}
                      </Chip>
                    )}
                    <span className="mono text-[11px] text-muted">
                      {new Date(entry.occurredAt).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>

                  {/* The explanation carries its own numbers by convention, so
                      a timeline entry is checkable without opening anything. */}
                  <p className="mt-0.5 text-[13.5px] leading-relaxed text-ink-soft">
                    {entry.explanation}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, RiskEventType, TrendMetric } from "@/lib/supabase/database.types";
import {
  computeBaseline,
  personalFindings,
  type ExcludedPeriod,
  type PersonalBaseline,
  type PersonalFinding,
} from "./baseline";
import {
  compareToBaseline,
  detectDeterioration,
  type ChannelTrend,
  type DeteriorationFinding,
} from "./deterioration";

/**
 * The vitals Health Twin — reading it, and the story it tells.
 *
 * ── Naming, because there are two twins ────────────────────────────────────
 *
 * `lib/services/twin/` is the **records twin**: conditions, medications,
 * documents, assembled from what a patient confirmed. This is the **vitals
 * twin**: what their body usually does, learned from the sensor stream. They
 * describe the same person from different evidence and are deliberately not
 * merged — one is a record of statements, the other a description of
 * measurements, and a component that blended them could not say which kind of
 * claim it was making.
 *
 * ── How long a window ──────────────────────────────────────────────────────
 *
 * Baselines learn from 30 days ending 48 hours ago. The gap is the anchor: if
 * the window ran to now, a patient declining over the last two days would have
 * that decline folded into their own "normal", and the deviation that should
 * have been reported would cancel itself.
 */

export const BASELINE_WINDOW_DAYS = 30;
/** How far back the baseline window stops. The anchor gap. */
export const BASELINE_ANCHOR_LAG_HOURS = 48;
/** The recent window compared against the anchor. */
export const RECENT_WINDOW_DAYS = 7;

export type StoredBaseline = {
  id: string;
  heartRate: { median: number; low: number; high: number; iqr: number } | null;
  spo2: { median: number; low: number; high: number; iqr: number } | null;
  temperature: { median: number; low: number; high: number; iqr: number } | null;
  windowStart: string;
  windowEnd: string;
  daysCovered: number;
  sampleCount: number;
  excludedSamples: number;
  confidence: number;
  calculatedAt: string;
};

export type RiskTimelineEntry = {
  id: string;
  riskType: string;
  severity: string;
  explanation: string;
  evidence: Record<string, unknown>;
  occurredAt: string;
};

export type VitalsTwin = {
  baseline: StoredBaseline | null;
  /** Why there is no baseline, when there is none. */
  baselineUnavailable: string | null;
  current: {
    heartRate: number | null;
    spo2: number | null;
    temperature: number | null;
    recordedAt: string;
  } | null;
  /** How the newest reading compares to this patient's own normal. */
  deviations: PersonalFinding[];
  trends: ChannelTrend[];
  deteriorations: DeteriorationFinding[];
  timeline: RiskTimelineEntry[];
};

/**
 * Reads the twin for display. Computes nothing and stores nothing.
 *
 * Baselines and trends are written by `refreshTwin`, which runs on a schedule
 * rather than on a page load — a dashboard that recomputed a 30-day baseline on
 * every render would scan tens of thousands of rows to show one number.
 */
export async function loadVitalsTwin(
  supabase: SupabaseClient<Database>,
  patientId: string,
  now = new Date(),
): Promise<VitalsTwin> {
  const recentSince = new Date(now.getTime() - RECENT_WINDOW_DAYS * 86_400_000).toISOString();

  const [baselineRow, trendRows, timelineRows, recent] = await Promise.all([
    supabase
      .from("patient_baselines")
      .select("*")
      .eq("patient_id", patientId)
      .order("calculated_at", { ascending: false })
      .limit(1)
      .then(({ data }) => data?.[0] ?? null),
    supabase
      .from("health_trends")
      .select("metric, direction, trend_value, total_change, fit, days_observed, concerning, created_at")
      .eq("patient_id", patientId)
      .order("created_at", { ascending: false })
      .limit(9)
      .then(({ data }) => data ?? []),
    supabase
      .from("risk_events")
      .select("id, risk_type, severity, explanation, evidence, occurred_at")
      .eq("patient_id", patientId)
      .order("occurred_at", { ascending: false })
      .limit(40)
      .then(({ data }) => data ?? []),
    supabase
      .from("sensor_readings")
      .select("heart_rate, spo2, temperature, recorded_at")
      .eq("patient_id", patientId)
      .gte("recorded_at", recentSince)
      .order("recorded_at", { ascending: false })
      .limit(2000)
      .then(({ data }) => data ?? []),
  ]);

  const baseline = baselineRow ? toStoredBaseline(baselineRow) : null;
  const newest = recent[0] ?? null;

  // Only the newest trend per metric. Older rows are history, and showing three
  // conflicting directions for the same channel is worse than showing one.
  const seen = new Set<string>();
  const trends: ChannelTrend[] = [];
  for (const row of trendRows) {
    if (seen.has(row.metric)) continue;
    seen.add(row.metric);
    trends.push({
      channel: metricToChannel(row.metric),
      direction: row.direction as ChannelTrend["direction"],
      slopePerDay: Number(row.trend_value),
      totalChange: Number(row.total_change ?? 0),
      fit: Number(row.fit ?? 0),
      days: [],
      concerning: row.concerning,
    });
  }

  let deviations: PersonalFinding[] = [];
  let deteriorations: DeteriorationFinding[] = [];

  if (baseline && newest) {
    const asPersonal = toPersonalBaseline(baseline);
    deviations = personalFindings(asPersonal, {
      heartRate: newest.heart_rate,
      spo2: newest.spo2,
      temperature: newest.temperature,
    });
    deteriorations = compareToBaseline(asPersonal, recent);
  }

  return {
    baseline,
    baselineUnavailable: baseline
      ? null
      : "AVERIS has not learned this patient's baseline yet. It needs several days of readings across at least three separate days before it will describe a normal.",
    current: newest
      ? {
          heartRate: newest.heart_rate,
          spo2: newest.spo2,
          temperature: newest.temperature,
          recordedAt: newest.recorded_at,
        }
      : null,
    deviations,
    trends,
    deteriorations,
    timeline: timelineRows.map((row) => ({
      id: row.id,
      riskType: row.risk_type,
      severity: row.severity,
      explanation: row.explanation,
      evidence: (row.evidence ?? {}) as Record<string, unknown>,
      occurredAt: row.occurred_at,
    })),
  };
}

/**
 * Recomputes the baseline and trends, and writes what changed.
 *
 * Called from the worker rather than from a request. It reads a month of
 * readings; doing that on a page load would make the dashboard's speed a
 * function of how long the patient has been monitored.
 *
 * Returns what it wrote so a caller can log it, and writes nothing when
 * nothing is worth writing — a fresh baseline every hour would fill the table
 * with rows describing the same person.
 */
export async function refreshTwin(
  supabase: SupabaseClient<Database>,
  patientId: string,
  now = new Date(),
): Promise<{ baselineWritten: boolean; trendsWritten: number; eventsWritten: number }> {
  const windowEnd = new Date(now.getTime() - BASELINE_ANCHOR_LAG_HOURS * 3600_000);
  const windowStart = new Date(windowEnd.getTime() - BASELINE_WINDOW_DAYS * 86_400_000);

  const [samples, exclusions, previous] = await Promise.all([
    supabase
      .from("sensor_readings")
      .select("heart_rate, spo2, temperature, recorded_at")
      .eq("patient_id", patientId)
      .gte("recorded_at", windowStart.toISOString())
      .order("recorded_at", { ascending: true })
      .limit(20_000)
      .then(({ data }) => data ?? []),
    loadExclusions(supabase, patientId, windowStart, now),
    supabase
      .from("patient_baselines")
      .select("id, avg_heart_rate, avg_spo2, avg_temperature, calculated_at")
      .eq("patient_id", patientId)
      .order("calculated_at", { ascending: false })
      .limit(1)
      .then(({ data }) => data?.[0] ?? null),
  ]);

  const baseline = computeBaseline(samples, {
    exclude: exclusions,
    excludeAfter: windowEnd.toISOString(),
  });

  let baselineWritten = false;
  let baselineId: string | null = previous?.id ?? null;

  if (baseline && worthWriting(baseline, previous)) {
    const { data } = await supabase
      .from("patient_baselines")
      .insert(toRow(patientId, baseline))
      .select("id")
      .maybeSingle();

    baselineId = data?.id ?? null;
    baselineWritten = true;
  }

  // Trends run over the whole window including the recent past — unlike the
  // baseline, a trend *wants* to see the last two days, because that is where
  // a decline shows up.
  const { trends, findings } = detectDeterioration(samples);

  const trendRows = trends.map((trend) => ({
    patient_id: patientId,
    metric: channelToMetric(trend.channel),
    direction: trend.direction,
    trend_value: trend.slopePerDay,
    total_change: trend.totalChange,
    fit: trend.fit,
    days_observed: Math.max(2, trend.days.length),
    concerning: trend.concerning,
    window_start: windowStart.toISOString(),
    window_end: now.toISOString(),
  }));

  if (trendRows.length > 0) {
    await supabase.from("health_trends").insert(trendRows);
  }

  // Typed rather than Record<string, unknown>: the risk_type values are an
  // enum in the database, and a typo would otherwise fail at runtime on a
  // background job nobody is watching.
  const events: Database["public"]["Tables"]["risk_events"]["Insert"][] = [];

  if (baselineWritten) {
    events.push({
      patient_id: patientId,
      risk_type: (previous ? "BASELINE_UPDATED" : "BASELINE_ESTABLISHED") as RiskEventType,
      severity: "INFO",
      explanation: describeBaseline(baseline!),
      evidence: {
        days: baseline!.daysCovered,
        samples: baseline!.totalSamples,
        excluded: baseline!.excludedSamples,
        confidence: baseline!.confidence,
      },
      baseline_id: baselineId,
      occurred_at: now.toISOString(),
    });
  }

  for (const finding of findings) {
    events.push({
      patient_id: patientId,
      risk_type: "TREND_DETECTED",
      severity: finding.severity === "CONCERNING" ? "WARNING" : "INFO",
      explanation: finding.message,
      evidence: {
        metric: channelToMetric(finding.channel),
        slopePerDay: finding.trend.slopePerDay,
        totalChange: finding.trend.totalChange,
        fit: finding.trend.fit,
      },
      occurred_at: now.toISOString(),
    });
  }

  if (events.length > 0) {
    await supabase.from("risk_events").insert(events);
  }

  return {
    baselineWritten,
    trendsWritten: trendRows.length,
    eventsWritten: events.length,
  };
}

/**
 * Periods the baseline must not learn from.
 *
 * An open emergency and the hours around a critical alert are, by definition,
 * the patient not being themselves. A baseline that absorbed them would raise
 * its own idea of normal toward the illness — and then report nothing the next
 * time it happened.
 */
async function loadExclusions(
  supabase: SupabaseClient<Database>,
  patientId: string,
  from: Date,
  to: Date,
): Promise<ExcludedPeriod[]> {
  const [emergencies, criticalAlerts] = await Promise.all([
    supabase
      .from("emergency_events")
      .select("created_at, resolved_at, event_type")
      .eq("patient_id", patientId)
      .gte("created_at", from.toISOString())
      .then(({ data }) => data ?? []),
    supabase
      .from("alerts")
      .select("created_at, alert_type")
      .eq("patient_id", patientId)
      .eq("severity", "CRITICAL")
      .gte("created_at", from.toISOString())
      .then(({ data }) => data ?? []),
  ]);

  const periods: ExcludedPeriod[] = [];

  for (const emergency of emergencies) {
    periods.push({
      from: emergency.created_at,
      // An unresolved emergency excludes everything since it started.
      to: emergency.resolved_at ?? to.toISOString(),
      reason: `emergency: ${emergency.event_type}`,
    });
  }

  for (const alert of criticalAlerts) {
    // An hour either side. A critical reading is rarely an isolated instant,
    // and the minutes around it are part of the same episode.
    const at = Date.parse(alert.created_at);
    periods.push({
      from: new Date(at - 3600_000).toISOString(),
      to: new Date(at + 3600_000).toISOString(),
      reason: `critical alert: ${alert.alert_type}`,
    });
  }

  return periods;
}

/**
 * Whether a newly computed baseline is worth storing.
 *
 * A baseline recomputed nightly that has not moved is noise in a table whose
 * value is being a record of change. Written when there is no previous one, or
 * when a channel has shifted by enough that a clinician reading the timeline
 * would want to know.
 */
function worthWriting(
  baseline: PersonalBaseline,
  previous: { avg_heart_rate: number | null; avg_spo2: number | null; avg_temperature: number | null } | null,
): boolean {
  if (!previous) return true;

  const moved = (a: number | null | undefined, b: number | null, by: number) =>
    a !== null && a !== undefined && b !== null && Math.abs(a - Number(b)) >= by;

  return (
    moved(baseline.channels.heartRate?.median, previous.avg_heart_rate, 2) ||
    moved(baseline.channels.spo2?.median, previous.avg_spo2, 1) ||
    moved(baseline.channels.temperature?.median, previous.avg_temperature, 0.2)
  );
}

function describeBaseline(baseline: PersonalBaseline): string {
  const parts: string[] = [];
  const hr = baseline.channels.heartRate;
  const spo2 = baseline.channels.spo2;
  const temp = baseline.channels.temperature;

  if (hr) parts.push(`heart rate ${hr.median} BPM (${hr.low}–${hr.high})`);
  if (spo2) parts.push(`blood oxygen ${spo2.median}% (${spo2.low}–${spo2.high})`);
  if (temp) parts.push(`temperature ${temp.median}°C (${temp.low}–${temp.high})`);

  return (
    `Personal baseline learned from ${baseline.daysCovered} days of monitoring: ` +
    `${parts.join(", ")}.`
  );
}

/* ------------------------------------------------------------- conversions */

function metricToChannel(metric: string): ChannelTrend["channel"] {
  return metric === "HEART_RATE" ? "heartRate" : metric === "SPO2" ? "spo2" : "temperature";
}

function channelToMetric(channel: ChannelTrend["channel"]): TrendMetric {
  return channel === "heartRate" ? "HEART_RATE" : channel === "spo2" ? "SPO2" : "TEMPERATURE";
}

type BaselineRow = {
  id: string;
  avg_heart_rate: number | null;
  avg_spo2: number | null;
  avg_temperature: number | null;
  heart_rate_low: number | null;
  heart_rate_high: number | null;
  spo2_low: number | null;
  spo2_high: number | null;
  temperature_low: number | null;
  temperature_high: number | null;
  heart_rate_iqr: number | null;
  spo2_iqr: number | null;
  temperature_iqr: number | null;
  window_start: string;
  window_end: string;
  days_covered: number;
  sample_count: number;
  excluded_samples: number;
  confidence: number;
  calculated_at: string;
};

function toStoredBaseline(row: BaselineRow): StoredBaseline {
  const channel = (
    median: number | null,
    low: number | null,
    high: number | null,
    iqr: number | null,
  ) =>
    median === null
      ? null
      : {
          median: Number(median),
          low: Number(low ?? median),
          high: Number(high ?? median),
          iqr: Number(iqr ?? 0),
        };

  return {
    id: row.id,
    heartRate: channel(row.avg_heart_rate, row.heart_rate_low, row.heart_rate_high, row.heart_rate_iqr),
    spo2: channel(row.avg_spo2, row.spo2_low, row.spo2_high, row.spo2_iqr),
    temperature: channel(row.avg_temperature, row.temperature_low, row.temperature_high, row.temperature_iqr),
    windowStart: row.window_start,
    windowEnd: row.window_end,
    daysCovered: row.days_covered,
    sampleCount: row.sample_count,
    excludedSamples: row.excluded_samples,
    confidence: Number(row.confidence),
    calculatedAt: row.calculated_at,
  };
}

/** Back into the shape the pure module works with. */
export function toPersonalBaseline(stored: StoredBaseline): PersonalBaseline {
  const channels: PersonalBaseline["channels"] = {};

  if (stored.heartRate) {
    channels.heartRate = { channel: "heartRate", ...stored.heartRate, samples: stored.sampleCount };
  }
  if (stored.spo2) {
    channels.spo2 = { channel: "spo2", ...stored.spo2, samples: stored.sampleCount };
  }
  if (stored.temperature) {
    channels.temperature = {
      channel: "temperature",
      ...stored.temperature,
      samples: stored.sampleCount,
    };
  }

  return {
    channels,
    windowStart: stored.windowStart,
    windowEnd: stored.windowEnd,
    daysCovered: stored.daysCovered,
    totalSamples: stored.sampleCount,
    excludedSamples: stored.excludedSamples,
    confidence: stored.confidence,
  };
}

function toRow(patientId: string, baseline: PersonalBaseline) {
  const hr = baseline.channels.heartRate;
  const spo2 = baseline.channels.spo2;
  const temp = baseline.channels.temperature;

  return {
    patient_id: patientId,
    avg_heart_rate: hr?.median ?? null,
    heart_rate_low: hr?.low ?? null,
    heart_rate_high: hr?.high ?? null,
    heart_rate_iqr: hr?.iqr ?? null,
    avg_spo2: spo2?.median ?? null,
    spo2_low: spo2?.low ?? null,
    spo2_high: spo2?.high ?? null,
    spo2_iqr: spo2?.iqr ?? null,
    avg_temperature: temp?.median ?? null,
    temperature_low: temp?.low ?? null,
    temperature_high: temp?.high ?? null,
    temperature_iqr: temp?.iqr ?? null,
    window_start: baseline.windowStart,
    window_end: baseline.windowEnd,
    days_covered: baseline.daysCovered,
    sample_count: baseline.totalSamples,
    excluded_samples: baseline.excludedSamples,
    confidence: baseline.confidence,
  };
}

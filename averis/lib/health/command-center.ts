import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { calculateHealthScore, type HealthScore } from "./health-score";
import { effectiveStatus } from "@/lib/iot/device-service";

/**
 * Everything the patient's command centre needs, in one pass.
 *
 * ── Why this is one function and not six page-level queries ────────────────
 *
 * The dashboard was six independent `await`s in the page body. Each was
 * correct; together they were six sequential round trips before first paint,
 * and the health score needs four of them anyway. Collapsing them into one
 * `Promise.all` removes the waterfall — which on a page a patient opens to
 * find out whether they are alright is the difference between "instant" and
 * "a moment of doubt".
 *
 * Everything is RLS-scoped. The `patientId` argument narrows the query; it is
 * not the access control, which is the policy.
 */

export type CommandCenter = {
  score: HealthScore;
  latest: {
    heartRate: number | null;
    spo2: number | null;
    temperature: number | null;
    movementStatus: string;
    recordedAt: string;
  } | null;
  deviceReporting: boolean;
  deviceCount: number;
  lastReadingAt: string | null;
  insights: {
    id: string;
    message: string;
    severity: string;
    createdAt: string;
  }[];
  alerts: {
    id: string;
    alertType: string;
    severity: string;
    message: string;
    status: string;
    createdAt: string;
  }[];
  emergencies: {
    id: string;
    eventType: string;
    status: string;
    summary: string;
    createdAt: string;
  }[];
  risk: {
    score: number;
    level: string;
    confidence: number | null;
    reasons: string[];
    contributions: unknown[];
    assessedAt: string;
  } | null;
};

/** How far back the command centre looks. */
export const WINDOW_HOURS = 6;

export async function loadCommandCenter(
  supabase: SupabaseClient<Database>,
  patientId: string,
  now = new Date(),
): Promise<CommandCenter> {
  const since = new Date(now.getTime() - WINDOW_HOURS * 3600_000).toISOString();

  const [readings, alerts, emergencies, prediction, insights, devices] = await Promise.all([
    supabase
      .from("sensor_readings")
      .select("heart_rate, spo2, temperature, movement_status, recorded_at")
      .eq("patient_id", patientId)
      .gte("recorded_at", since)
      .order("recorded_at", { ascending: false })
      // Six hours at 0.5 Hz is ~10,800 rows. The score needs the shape, not
      // every sample, and the charts downsample anyway — so this is bounded at
      // something a page can hold without the query becoming the slow part.
      .limit(1500)
      .then(({ data }) => data ?? []),
    supabase
      .from("alerts")
      .select("id, alert_type, severity, message, status, created_at")
      .eq("patient_id", patientId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(20)
      .then(({ data }) => data ?? []),
    supabase
      .from("emergency_events")
      .select("id, event_type, status, summary, created_at")
      .eq("patient_id", patientId)
      .order("created_at", { ascending: false })
      .limit(10)
      .then(({ data }) => data ?? []),
    supabase
      .from("health_predictions")
      .select("risk_score, risk_category, confidence_score, explanation, created_at")
      .eq("patient_id", patientId)
      .eq("prediction_type", "VITAL_DETERIORATION")
      .order("created_at", { ascending: false })
      .limit(1)
      .then(({ data }) => data?.[0] ?? null),
    supabase
      .from("ai_insights")
      .select("id, message, severity, created_at")
      .eq("patient_id", patientId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5)
      .then(({ data }) => data ?? []),
    supabase
      .from("iot_devices")
      .select("connection_status, last_reading_at")
      .eq("patient_id", patientId)
      .neq("connection_status", "RETIRED")
      .then(({ data }) => data ?? []),
  ]);

  // Derived, never read from the column: a device that lost power cannot
  // report itself offline, and "Connected" over a dead band is the one thing a
  // monitoring product must not show.
  const reporting = devices.some(
    (d) =>
      effectiveStatus(
        { connectionStatus: d.connection_status as never, lastReadingAt: d.last_reading_at },
        now,
      ) === "ONLINE",
  );

  const lastReadingAt =
    devices
      .map((d) => d.last_reading_at)
      .filter((t): t is string => Boolean(t))
      .sort()
      .at(-1) ?? null;

  const openEmergencies = emergencies.filter((e) =>
    ["NEW", "ACKNOWLEDGED", "IN_PROGRESS"].includes(e.status),
  ).length;

  const explanation = (prediction?.explanation ?? {}) as {
    explanation?: unknown;
    contributions?: unknown;
  };

  const risk = prediction
    ? {
        score: Number(prediction.risk_score),
        level: prediction.risk_category as string,
        confidence:
          prediction.confidence_score === null ? null : Number(prediction.confidence_score),
        reasons: Array.isArray(explanation.explanation)
          ? explanation.explanation.filter((r): r is string => typeof r === "string")
          : [],
        contributions: Array.isArray(explanation.contributions) ? explanation.contributions : [],
        assessedAt: prediction.created_at,
      }
    : null;

  const score = calculateHealthScore({
    readings,
    alerts: alerts.map((a) => ({ severity: a.severity })),
    openEmergencies,
    risk: risk ? { score: risk.score, level: risk.level } : null,
    deviceReporting: reporting,
    windowHours: WINDOW_HOURS,
    now: now.getTime(),
  });

  const newest = readings[0] ?? null;

  return {
    score,
    latest: newest
      ? {
          heartRate: newest.heart_rate,
          spo2: newest.spo2,
          temperature: newest.temperature,
          movementStatus: newest.movement_status,
          recordedAt: newest.recorded_at,
        }
      : null,
    deviceReporting: reporting,
    deviceCount: devices.length,
    lastReadingAt,
    insights: insights.map((i) => ({
      id: i.id,
      message: i.message,
      severity: i.severity,
      createdAt: i.created_at,
    })),
    alerts: alerts.map((a) => ({
      id: a.id,
      alertType: a.alert_type,
      severity: a.severity,
      message: a.message,
      status: a.status,
      createdAt: a.created_at,
    })),
    emergencies: emergencies.map((e) => ({
      id: e.id,
      eventType: e.event_type,
      status: e.status,
      summary: e.summary,
      createdAt: e.created_at,
    })),
    risk,
  };
}

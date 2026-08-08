import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

import {
  computeImpact,
  emptyMetrics,
  type AlertRow,
  type EmergencyRow,
  type ImpactMetrics,
  type ReadingRow,
} from "./impact-metrics";

/**
 * Loading the impact figures.
 *
 * Every query runs as the signed-in user, so Row Level Security decides what is
 * counted. That has a consequence worth stating plainly on the page: **these
 * are the viewer's own figures, not the deployment's.** A patient sees what
 * their band has produced; a clinician sees their caseload.
 *
 * The alternative — a service-role count across every patient — would need the
 * key the web app deliberately does not have, and would show one patient a
 * number derived from every other patient's data. A deployment-wide figure is
 * an operator's metric and belongs in the operator's tooling.
 *
 * `alerts.reading_id` is what makes detection latency measurable at all: the
 * alert points at the reading that tripped it, so the interval is a join rather
 * than a guess. Alerts whose reading has since aged out under the retention
 * policy come back with a null and are reported as untraceable rather than
 * dropped.
 */

/** Bounded. An impact panel is not worth an unbounded scan of a hot table. */
const READING_SAMPLE_LIMIT = 5000;

export async function loadImpact(
  supabase: SupabaseClient<Database>,
  patientId: string,
): Promise<ImpactMetrics> {
  const [readings, alerts, emergencies] = await Promise.all([
    supabase
      .from("sensor_readings")
      .select("patient_id, is_simulated, recorded_at, received_at")
      .eq("patient_id", patientId)
      .order("recorded_at", { ascending: false })
      .limit(READING_SAMPLE_LIMIT)
      .then(({ data }) => data ?? []),

    supabase
      .from("alerts")
      .select("severity, created_at, acknowledged_at, reading_id")
      .eq("patient_id", patientId)
      .order("created_at", { ascending: false })
      .limit(1000)
      .then(({ data }) => data ?? []),

    supabase
      .from("emergency_events")
      .select("created_at, acknowledged_at, status")
      .eq("patient_id", patientId)
      .order("created_at", { ascending: false })
      .limit(1000)
      .then(({ data }) => data ?? []),
  ]);

  if (readings.length === 0 && alerts.length === 0 && emergencies.length === 0) {
    return emptyMetrics();
  }

  const readingRows: ReadingRow[] = readings.map((row) => ({
    isSimulated: Boolean(row.is_simulated),
    patientId: row.patient_id,
    recordedAt: row.recorded_at,
    receivedAt: row.received_at ?? null,
  }));

  // The readings that triggered the alerts, fetched by id rather than embedded.
  //
  // A PostgREST embed would be one query instead of two, and it would also only
  // reach readings inside the sample above — an alert from six weeks ago points
  // at a reading well outside the 5,000-row window, and it would silently come
  // back untraceable. Asking for exactly the ids the alerts name is the version
  // that measures every alert it can.
  const triggerIds = alerts
    .map((row) => row.reading_id)
    .filter((id): id is number => id !== null && id !== undefined);

  const triggers = new Map<number, { receivedAt: string | null; isSimulated: boolean }>();

  if (triggerIds.length > 0) {
    const { data } = await supabase
      .from("sensor_readings")
      .select("id, received_at, is_simulated")
      .in("id", triggerIds);

    for (const row of data ?? []) {
      triggers.set(row.id, {
        receivedAt: row.received_at ?? null,
        isSimulated: Boolean(row.is_simulated),
      });
    }
  }

  const alertRows: AlertRow[] = alerts.map((row) => {
    // Absent when the reading has aged out under the retention policy. Reported
    // as untraceable rather than dropped, so the count of what could not be
    // measured stays visible.
    const trigger = row.reading_id != null ? triggers.get(row.reading_id) : undefined;

    return {
      severity: row.severity as AlertRow["severity"],
      // An alert inherits provenance from the reading that caused it. An alert
      // raised by a simulated reading is a simulated alert, and counting it as
      // measured would be the exact mixing this module exists to prevent.
      isSimulated: Boolean(trigger?.isSimulated),
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at ?? null,
      triggeredByReceivedAt: trigger?.receivedAt ?? null,
    };
  });

  const emergencyRows: EmergencyRow[] = emergencies.map((row) => ({
    // emergency_events carries no provenance column of its own. It is derived
    // from whether this deployment has any measured data at all, which is a
    // coarse answer and is marked as such on the page rather than presented as
    // a per-row fact.
    isSimulated: readingRows.every((r) => r.isSimulated),
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at ?? null,
    status: row.status,
  }));

  return computeImpact(readingRows, alertRows, emergencyRows);
}

export { IMPACT_DISCLAIMER, provenanceCaption } from "./impact-metrics";
export type { ImpactMetrics } from "./impact-metrics";

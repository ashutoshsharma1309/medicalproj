import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * A caregiver's watchlist.
 *
 * Built from a different starting point than the clinician's caseload, and the
 * difference is not stylistic. `loadCaseload` begins at `patient_profiles`,
 * which a doctor may read. The narrowest caregiver grant — VIEW_ALERTS —
 * deliberately may not read that table at all, so beginning there would return
 * an empty list to exactly the people this page exists for.
 *
 * So it begins at the assignment, which a caregiver can always read because it
 * is a row about them, and layers on only what their permission level allows.
 * Nothing here checks that permission before querying: RLS returns null for
 * what they may not see, and the UI says "not shared with you" rather than
 * pretending the data is missing. A caregiver who cannot see vitals should be
 * told that, not shown an empty chart that reads as a broken device.
 */

export type CaregiverPermission = "VIEW_ALERTS" | "VIEW_VITALS" | "FULL";

export type WatchedPatient = {
  patientId: string;
  fullName: string;
  relationship: string | null;
  permission: CaregiverPermission;
  openEmergencies: number;
  worstSeverity: "INFO" | "WARNING" | "CRITICAL" | null;
  /** Null when the grant does not include vitals — not when there are none. */
  latestVitals: {
    heartRate: number | null;
    spo2: number | null;
    temperature: number | null;
    recordedAt: string;
  } | null;
  lastSyncAt: string | null;
};

const SEVERITY_RANK: Record<string, number> = { INFO: 1, WARNING: 2, CRITICAL: 3 };

export async function loadWatchlist(
  supabase: SupabaseClient<Database>,
  caregiverUserId: string,
): Promise<WatchedPatient[]> {
  const { data: assignments } = await supabase
    .from("patient_caregiver_assignments")
    .select("patient_id, relationship, permission_level")
    .eq("caregiver_id", caregiverUserId)
    .eq("status", "ACTIVE");

  if (!assignments || assignments.length === 0) return [];

  const patientIds = assignments.map((a) => a.patient_id);

  const [directory, emergencies, readings, devices] = await Promise.all([
    // Names come through the RPC rather than a profiles → users join, because
    // a VIEW_ALERTS caregiver cannot read patient_profiles at all and would
    // otherwise get a watchlist of UUIDs.
    supabase.rpc("care_patient_directory"),
    supabase
      .from("emergency_events")
      .select("patient_id, severity, status")
      .in("patient_id", patientIds)
      .in("status", ["NEW", "ACKNOWLEDGED", "IN_PROGRESS"]),
    supabase
      .from("sensor_readings")
      .select("patient_id, heart_rate, spo2, temperature, recorded_at")
      .in("patient_id", patientIds)
      .order("recorded_at", { ascending: false })
      .limit(500),
    supabase
      .from("iot_devices")
      .select("patient_id, last_reading_at")
      .in("patient_id", patientIds),
  ]);

  const nameByPatient = new Map(
    (directory.data ?? []).map((row) => [row.patient_id, row.full_name]),
  );

  const emergencyByPatient = new Map<
    string,
    { count: number; worst: "INFO" | "WARNING" | "CRITICAL" | null }
  >();
  for (const row of emergencies.data ?? []) {
    const current = emergencyByPatient.get(row.patient_id) ?? { count: 0, worst: null };
    current.count += 1;
    if ((SEVERITY_RANK[row.severity] ?? 0) > (SEVERITY_RANK[current.worst ?? ""] ?? 0)) {
      current.worst = row.severity;
    }
    emergencyByPatient.set(row.patient_id, current);
  }

  type Reading = NonNullable<typeof readings.data>[number];
  const latestReading = new Map<string, Reading>();
  for (const row of readings.data ?? []) {
    if (!latestReading.has(row.patient_id)) latestReading.set(row.patient_id, row);
  }

  const lastSyncByPatient = new Map<string, string | null>();
  for (const row of devices.data ?? []) {
    const existing = lastSyncByPatient.get(row.patient_id) ?? null;
    if (!existing || (row.last_reading_at ?? "") > existing) {
      lastSyncByPatient.set(row.patient_id, row.last_reading_at);
    }
  }

  return assignments
    .map((assignment) => {
      const emergency = emergencyByPatient.get(assignment.patient_id);
      const reading = latestReading.get(assignment.patient_id);

      return {
        patientId: assignment.patient_id,
        // A caregiver whose grant somehow returns no identity still gets a row
        // rather than a silently shorter list — a missing person is worse than
        // an unnamed one.
        fullName: nameByPatient.get(assignment.patient_id) ?? "Patient",
        relationship: assignment.relationship,
        permission: assignment.permission_level as CaregiverPermission,
        openEmergencies: emergency?.count ?? 0,
        worstSeverity: emergency?.worst ?? null,
        latestVitals: reading
          ? {
              heartRate: reading.heart_rate,
              spo2: reading.spo2,
              temperature: reading.temperature,
              recordedAt: reading.recorded_at,
            }
          : null,
        lastSyncAt: lastSyncByPatient.get(assignment.patient_id) ?? null,
      } satisfies WatchedPatient;
    })
    .sort(
      (a, b) =>
        (SEVERITY_RANK[b.worstSeverity ?? ""] ?? 0) - (SEVERITY_RANK[a.worstSeverity ?? ""] ?? 0) ||
        b.openEmergencies - a.openEmergencies ||
        a.fullName.localeCompare(b.fullName),
    );
}

/** What a permission level actually grants, in the caregiver's words. */
export const PERMISSION_DESCRIPTION: Record<CaregiverPermission, string> = {
  VIEW_ALERTS: "Emergency alerts only",
  VIEW_VITALS: "Emergency alerts and live vitals",
  FULL: "Full access to their monitoring record",
};

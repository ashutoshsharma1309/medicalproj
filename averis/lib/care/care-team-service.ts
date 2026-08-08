import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { effectiveStatus, type ConnectionStatus } from "@/lib/iot/device-service";

/**
 * The clinician's view of their caseload.
 *
 * This file deliberately does not check which patients the doctor may see.
 * That rule lives in `private.can_access_patient()` and is applied by RLS to
 * every query below — so a doctor querying "all patients" receives only their
 * own, and a second check here would be a copy of an authorization rule that
 * can drift out of agreement with the first.
 *
 * What it does own is **ordering**, which is the actual clinical problem. A
 * list of forty patients sorted by name is a list nobody can triage.
 */

export type {
  CaseloadPatient,
  RiskLevel,
} from "./triage";

import {
  triageOrder,
  type CaseloadPatient,
  type RiskLevel,
} from "./triage";
import { severityRank } from "./triage";
export { triageOrder, triageReason, riskRank, severityRank } from "./triage";

export async function loadCaseload(
  supabase: SupabaseClient<Database>,
): Promise<CaseloadPatient[]> {
  // RLS narrows every one of these to the caller's assigned patients.
  const [profiles, identities, predictions, emergencies, alerts, devices, readings] =
    await Promise.all([
    supabase.from("patient_profiles").select("id, user_id, date_of_birth"),
    supabase.from("users").select("id, full_name"),
    supabase
      .from("health_predictions")
      .select("patient_id, risk_score, risk_category, created_at")
      .eq("prediction_type", "VITAL_DETERIORATION")
      .order("created_at", { ascending: false }),
    supabase
      .from("emergency_events")
      .select("patient_id, severity, status")
      .in("status", ["NEW", "ACKNOWLEDGED", "IN_PROGRESS"]),
    supabase.from("alerts").select("patient_id, status").eq("status", "ACTIVE"),
    supabase
      .from("iot_devices")
      .select("patient_id, connection_status, last_reading_at, last_connected_at, device_key, device_name, device_type, id, battery_percentage, firmware_version, created_at"),
    supabase
      .from("sensor_readings")
      .select("patient_id, heart_rate, spo2, temperature, recorded_at")
      .order("recorded_at", { ascending: false })
      .limit(2000),
  ]);

  const nameByUserId = new Map(
    (identities.data ?? []).map((u) => [u.id, u.full_name]),
  );

  const latestPrediction = firstPerPatient(predictions.data ?? [], (r) => r.patient_id);
  const latestReading = firstPerPatient(readings.data ?? [], (r) => r.patient_id);

  const emergencyByPatient = new Map<string, { count: number; worst: "INFO" | "WARNING" | "CRITICAL" | null }>();
  for (const row of emergencies.data ?? []) {
    const current = emergencyByPatient.get(row.patient_id) ?? { count: 0, worst: null };
    current.count += 1;
    if (severityRank(row.severity as never) > severityRank(current.worst)) {
      current.worst = row.severity as never;
    }
    emergencyByPatient.set(row.patient_id, current);
  }

  const alertsByPatient = new Map<string, number>();
  for (const row of alerts.data ?? []) {
    alertsByPatient.set(row.patient_id, (alertsByPatient.get(row.patient_id) ?? 0) + 1);
  }

  const deviceByPatient = firstPerPatient(devices.data ?? [], (r) => r.patient_id);

  return (profiles.data ?? [])
    .map((profile) => {
      const prediction = latestPrediction.get(profile.id);
      const reading = latestReading.get(profile.id);
      const device = deviceByPatient.get(profile.id);
      const emergency = emergencyByPatient.get(profile.id);

      return {
        patientId: profile.id,
        fullName: nameByUserId.get(profile.user_id) ?? "Unnamed patient",
        age: ageFrom(profile.date_of_birth),
        riskLevel: (prediction?.risk_category as RiskLevel) ?? null,
        riskScore: prediction ? Number(prediction.risk_score) : null,
        riskAssessedAt: prediction?.created_at ?? null,
        openEmergencies: emergency?.count ?? 0,
        worstEmergencySeverity: emergency?.worst ?? null,
        openAlerts: alertsByPatient.get(profile.id) ?? 0,
        latestVitals: reading
          ? {
              heartRate: reading.heart_rate,
              spo2: reading.spo2,
              temperature: reading.temperature,
              recordedAt: reading.recorded_at,
            }
          : null,
        // Derived, not read: a device that lost power cannot report itself
        // offline, and showing "Connected" for a dead band is the failure a
        // monitoring platform must not have.
        deviceStatus: device
          ? effectiveStatus({
              connectionStatus: device.connection_status as ConnectionStatus,
              lastReadingAt: device.last_reading_at,
            })
          : null,
        lastSyncAt: device?.last_reading_at ?? null,
      } satisfies CaseloadPatient;
    })
    .sort(triageOrder);
}

/** Keeps the first row per patient from an already-ordered list. */
function firstPerPatient<T>(rows: T[], key: (row: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    if (!out.has(id)) out.set(id, row);
  }
  return out;
}

function ageFrom(dateOfBirth: string | null): number | null {
  if (!dateOfBirth) return null;
  const born = new Date(dateOfBirth);
  if (Number.isNaN(born.getTime())) return null;

  const now = new Date();
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - born.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < born.getUTCDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

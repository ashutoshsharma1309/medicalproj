import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Demo mode.
 *
 * ── What this is not ───────────────────────────────────────────────────────
 *
 * It is not a mock, a fixture set, or a screen with pre-baked numbers on it.
 * There is no demo data table, nothing is inserted by this module, and no
 * component anywhere renders a value that did not come through the real
 * ingest path.
 *
 * What it is: a **live checklist**. Each step below runs a real query against
 * the viewer's own data and reports what is actually true right now. The demo
 * is driven by the simulator — the same HTTP client the ESP32 replaces — so
 * what a judge watches is the production pipeline with a generated input, not
 * a demonstration mode that bypasses it.
 *
 * ── Why it is built this way ───────────────────────────────────────────────
 *
 * A demo mode that seeds convincing patient data is the most tempting thing to
 * build here and the most damaging. AVERIS stores measured and generated
 * readings in one table and separates them with a flag stamped at write time.
 * Anything inserted directly would bypass that flag and produce rows nothing
 * downstream could classify — so the first person to run the demo would
 * permanently poison the distinction the whole platform depends on.
 *
 * Driving the simulator instead costs a terminal window and keeps every row
 * honest: registered as a simulator, stamped `is_simulated`, visibly labelled
 * wherever it appears.
 */

export type DemoStep = {
  id: string;
  title: string;
  /** What a judge should understand from this step. */
  point: string;
  done: boolean;
  /** What is true right now — never a promise about what will be. */
  detail: string;
  /** Where to look when it happens. */
  href?: string;
};

export type DemoState = {
  steps: DemoStep[];
  /** The simulator device to drive, if the patient has registered one. */
  simulatorKey: string | null;
  /** True when a device is registered but not marked as a simulator. */
  unmarkedDevice: boolean;
  completed: number;
};

export async function loadDemoState(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
): Promise<DemoState> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const [devices, readings, prediction, alerts, emergencies, doctors] = await Promise.all([
    supabase
      .from("iot_devices")
      .select("device_key, is_simulated, connection_status, last_reading_at")
      .eq("patient_id", patientProfileId)
      .neq("connection_status", "RETIRED"),
    supabase
      .from("sensor_readings")
      .select("id, heart_rate, spo2, recorded_at, is_simulated")
      .eq("patient_id", patientProfileId)
      .gte("recorded_at", since)
      .order("recorded_at", { ascending: false })
      .limit(200),
    supabase
      .from("health_predictions")
      .select("risk_score, risk_category, created_at")
      .eq("patient_id", patientProfileId)
      .eq("prediction_type", "VITAL_DETERIORATION")
      .order("created_at", { ascending: false })
      .limit(1)
      .then(({ data }) => data?.[0] ?? null),
    supabase
      .from("alerts")
      .select("id, severity, alert_type, created_at")
      .eq("patient_id", patientProfileId)
      .gte("created_at", since),
    supabase
      .from("emergency_events")
      .select("id, event_type, status, created_at")
      .eq("patient_id", patientProfileId)
      .gte("created_at", since),
    supabase
      .from("patient_doctor_assignments")
      .select("id, status")
      .eq("patient_id", patientProfileId)
      .eq("status", "ACTIVE"),
  ]);

  const deviceRows = devices.data ?? [];
  const simulator = deviceRows.find((d) => d.is_simulated) ?? null;
  const readingRows = readings.data ?? [];
  const alertRows = alerts.data ?? [];
  const criticalAlerts = alertRows.filter((a) => a.severity === "CRITICAL");
  const emergencyRows = emergencies.data ?? [];
  const doctorRows = doctors.data ?? [];

  const newest = readingRows[0] ?? null;
  const newestAgeSeconds = newest
    ? Math.round((Date.now() - Date.parse(newest.recorded_at)) / 1000)
    : null;

  const steps: DemoStep[] = [
    {
      id: "device",
      title: "A device is registered",
      point:
        "Every reading is authenticated by a device token AVERIS stores only as a hash. " +
        "Nothing can write into a chart without one.",
      done: simulator !== null,
      detail: simulator
        ? `${simulator.device_key} registered as a simulator.`
        : deviceRows.length > 0
          ? "A device is registered, but not marked as a simulator. Register one with the box ticked."
          : "No device yet.",
      href: "/devices",
    },
    {
      id: "streaming",
      title: "Readings are arriving",
      point:
        "The simulator speaks the same HTTP contract the ESP32 firmware does. " +
        "Swapping one for the other changes nothing else in the system.",
      // Two minutes, not "any reading ever": this step is about the stream
      // being live now, which is the thing a judge is watching for.
      done: newestAgeSeconds !== null && newestAgeSeconds < 120,
      detail:
        newest === null
          ? "No readings in the last hour."
          : `${readingRows.length} readings in the last hour, newest ${newestAgeSeconds}s ago` +
            `${newest.heart_rate !== null ? ` — ${newest.heart_rate} BPM` : ""}` +
            `${newest.spo2 !== null ? `, SpO₂ ${newest.spo2}%` : ""}.`,
      href: "/monitoring",
    },
    {
      id: "risk",
      title: "The AI engine has scored the stream",
      point:
        "Risk is computed from the readings by a rule-and-model engine, and every score " +
        "carries the measurements that produced it. Nothing is a black box.",
      done: prediction !== null,
      detail: prediction
        ? `Latest assessment ${Math.round(Number(prediction.risk_score) * 100)}% (${prediction.risk_category}).`
        : "No assessment yet — the engine runs on a window of readings.",
      href: "/monitoring",
    },
    {
      id: "alert",
      title: "A threshold was crossed",
      point:
        "Alerts are rules, not predictions. Each one names the value measured and the " +
        "threshold it crossed, so a patient can check it.",
      done: alertRows.length > 0,
      detail:
        alertRows.length === 0
          ? "No alerts — run the simulator in warning or emergency mode."
          : `${alertRows.length} alert${alertRows.length === 1 ? "" : "s"}, ` +
            `${criticalAlerts.length} critical.`,
      href: "/monitoring",
    },
    {
      id: "emergency",
      title: "An emergency reached a person",
      point:
        "A critical finding is escalated into an event that stays in a clinician's queue " +
        "until someone responds. Raising it and notifying the care team are one transaction.",
      done: emergencyRows.length > 0,
      detail:
        emergencyRows.length === 0
          ? "No emergency events — emergency mode crosses the critical thresholds."
          : `${emergencyRows.length} event${emergencyRows.length === 1 ? "" : "s"}: ` +
            emergencyRows
              .map((e) => `${e.event_type.toLowerCase().replace(/_/g, " ")} (${e.status.toLowerCase()})`)
              .join(", "),
      href: "/monitoring",
    },
    {
      id: "clinician",
      title: "A clinician can see it",
      point:
        "The doctor sees only patients assigned to them, and the patient granted that " +
        "access themselves. Row Level Security enforces it in the database, not in the UI.",
      done: doctorRows.length > 0,
      detail:
        doctorRows.length === 0
          ? "No clinician assigned yet — grant access from Care team."
          : `${doctorRows.length} clinician${doctorRows.length === 1 ? "" : "s"} can see this chart.`,
      href: "/care-team",
    },
  ];

  return {
    steps,
    simulatorKey: simulator?.device_key ?? null,
    unmarkedDevice: simulator === null && deviceRows.length > 0,
    completed: steps.filter((s) => s.done).length,
  };
}

/**
 * Whether demo mode is available at all.
 *
 * Off unless explicitly enabled. A guided tour is exactly the sort of surface
 * that should not exist in a production deployment: it is a page whose whole
 * purpose is to make the system easy to drive, and "easy to drive" is not a
 * property a patient-facing health platform wants unattended.
 */
export function demoModeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === "true";
}

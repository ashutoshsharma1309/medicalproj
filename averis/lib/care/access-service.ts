import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { CaregiverPermission } from "./caregiver-service";

/**
 * Who can see my health data — from the patient's side.
 *
 * The counterpart to every "care team reads assigned patient" policy in the
 * schema. Those decide what a clinician may open; this is where the patient
 * decides whether there is anything to open, and it exists because access
 * granted through a support request is not consent.
 *
 * Revocation is a status change, not a delete. The row stays so the audit
 * trail can still explain why that doctor could read this chart last month —
 * deleting it would make past access unexplainable, which is the opposite of
 * what a record of consent is for.
 */

export type AssignedDoctor = {
  assignmentId: string;
  doctorId: string;
  fullName: string;
  specialization: string | null;
  hospitalName: string | null;
  status: "ACTIVE" | "PENDING" | "REVOKED";
  assignedAt: string;
  revokedAt: string | null;
};

export type AssignedCaregiver = {
  assignmentId: string;
  caregiverId: string;
  fullName: string | null;
  email: string | null;
  relationship: string | null;
  permission: CaregiverPermission;
  status: "ACTIVE" | "PENDING" | "REVOKED";
  assignedAt: string;
  revokedAt: string | null;
};

export async function listMyDoctors(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
): Promise<AssignedDoctor[]> {
  const { data } = await supabase
    .from("patient_doctor_assignments")
    .select("id, doctor_id, status, assigned_at, revoked_at")
    .eq("patient_id", patientProfileId)
    .order("assigned_at", { ascending: false });

  if (!data || data.length === 0) return [];

  // Only ACTIVE assignments make the doctor's profile readable — that is what
  // the `doctors` policy says. So a revoked entry keeps its dates and loses its
  // name, which is the honest rendering: the patient withdrew access, and the
  // clinician's details stopped being theirs to see.
  const { data: profiles } = await supabase
    .from("doctors")
    .select("id, full_name, specialization, hospital_name");

  const byId = new Map((profiles ?? []).map((d) => [d.id, d]));

  return data.map((row) => {
    const doctor = byId.get(row.doctor_id);
    return {
      assignmentId: row.id,
      doctorId: row.doctor_id,
      fullName: doctor?.full_name ?? "Clinician",
      specialization: doctor?.specialization ?? null,
      hospitalName: doctor?.hospital_name ?? null,
      status: row.status,
      assignedAt: row.assigned_at,
      revokedAt: row.revoked_at,
    };
  });
}

export async function listMyCaregivers(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
): Promise<AssignedCaregiver[]> {
  const { data } = await supabase
    .from("patient_caregiver_assignments")
    .select("id, caregiver_id, relationship, permission_level, status, assigned_at, revoked_at")
    .eq("patient_id", patientProfileId)
    .order("assigned_at", { ascending: false });

  if (!data || data.length === 0) return [];

  // A patient can read the `users` row of someone they made a caregiver only
  // through the identity policy, which runs the other way round. So the name
  // may be absent, and the email the patient typed is what identifies the row
  // to them anyway.
  const { data: people } = await supabase
    .from("users")
    .select("id, full_name, email")
    .in("id", data.map((row) => row.caregiver_id));

  const byId = new Map((people ?? []).map((u) => [u.id, u]));

  return data.map((row) => {
    const person = byId.get(row.caregiver_id);
    return {
      assignmentId: row.id,
      caregiverId: row.caregiver_id,
      fullName: person?.full_name ?? null,
      email: person?.email ?? null,
      relationship: row.relationship,
      permission: row.permission_level as CaregiverPermission,
      status: row.status,
      assignedAt: row.assigned_at,
      revokedAt: row.revoked_at,
    };
  });
}

/**
 * Withdrawing access.
 *
 * Both statements are needed: the CHECK constraint refuses a REVOKED row with
 * no `revoked_at`, precisely so "revoked" cannot become a label with no moment
 * attached to it.
 */
export async function revokeDoctor(
  supabase: SupabaseClient<Database>,
  assignmentId: string,
): Promise<void> {
  const { error } = await supabase
    .from("patient_doctor_assignments")
    .update({ status: "REVOKED", revoked_at: new Date().toISOString() })
    .eq("id", assignmentId);

  if (error) throw new Error(`Could not withdraw access: ${error.message}`);
}

export async function revokeCaregiver(
  supabase: SupabaseClient<Database>,
  assignmentId: string,
): Promise<void> {
  const { error } = await supabase
    .from("patient_caregiver_assignments")
    .update({ status: "REVOKED", revoked_at: new Date().toISOString() })
    .eq("id", assignmentId);

  if (error) throw new Error(`Could not withdraw access: ${error.message}`);
}

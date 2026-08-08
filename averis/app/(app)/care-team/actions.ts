"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit/audit-service";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { rateLimitStore } from "@/lib/security/rate-limit-store";
import { revokeCaregiver, revokeDoctor } from "@/lib/care/access-service";
import type { CaregiverPermission } from "@/lib/care/caregiver-service";

/**
 * Granting and withdrawing access to a health record.
 *
 * Every action here derives the patient from the session. None of them takes a
 * patient id, so there is no parameter an attacker could substitute to attach
 * a clinician to somebody else's record — and the INSERT policy independently
 * refuses a row whose patient_id is not the caller's.
 *
 * All of them are audited. Consent is the one thing in AVERIS whose history
 * matters as much as its current value: "who could see my data in March" is a
 * question a patient is entitled to an answer to.
 */

export type DoctorLookupState = {
  found: {
    id: string;
    fullName: string;
    specialization: string | null;
    hospitalName: string | null;
    verified: boolean;
  } | null;
  message: string | null;
  error: string | null;
};

// Module-private: a "use server" file may only export async functions.
const EMPTY_LOOKUP: DoctorLookupState = { found: null, message: null, error: null };

/**
 * Step one: identify the clinician.
 *
 * Separate from granting on purpose. A patient typing a licence number into a
 * box and being told "access granted" has not consented to anything — they
 * have not seen who they granted it to. This returns a name, and the grant is
 * a second, deliberate click.
 */
export async function findDoctorAction(
  _previous: DoctorLookupState,
  formData: FormData,
): Promise<DoctorLookupState> {
  const license = String(formData.get("license") ?? "").trim();
  if (license.length < 3) {
    return { ...EMPTY_LOOKUP, error: "Enter the clinician's full licence number." };
  }

  const account = await requireUser();
  if (!account.patientProfileId) {
    return { ...EMPTY_LOOKUP, error: "Complete your health profile first." };
  }

  const limited = await checkRateLimit(
    rateLimitStore(),
    "careTeamChange",
    account.patientProfileId,
  );
  if (!limited.allowed) {
    return {
      ...EMPTY_LOOKUP,
      error: "You have made a lot of changes recently. Try again in a little while.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("find_doctor_by_license", { p_license: license });

  if (error) {
    return { ...EMPTY_LOOKUP, error: "Could not look that licence up. Try again." };
  }

  const doctor = data?.[0];
  if (!doctor) {
    return {
      ...EMPTY_LOOKUP,
      error:
        "No clinician on AVERIS has that licence number. Check it with them — AVERIS matches it exactly.",
    };
  }

  return {
    found: {
      id: doctor.id,
      fullName: doctor.full_name,
      specialization: doctor.specialization,
      hospitalName: doctor.hospital_name,
      verified: doctor.verified,
    },
    message: null,
    error: null,
  };
}

/** Step two: the grant itself. */
export async function assignDoctorAction(
  _previous: DoctorLookupState,
  formData: FormData,
): Promise<DoctorLookupState> {
  const doctorId = String(formData.get("doctorId") ?? "");
  if (!doctorId) return { ...EMPTY_LOOKUP, error: "Choose a clinician first." };

  const account = await requireUser();
  if (!account.patientProfileId) {
    return { ...EMPTY_LOOKUP, error: "Complete your health profile first." };
  }

  const supabase = await createClient();

  // ACTIVE rather than PENDING. The consent is the patient's to give, and
  // requiring the clinician to accept before anyone can be monitored delays
  // care for no safety gain — the doctor can decline by revoking.
  const { error } = await supabase.from("patient_doctor_assignments").insert({
    patient_id: account.patientProfileId,
    doctor_id: doctorId,
    status: "ACTIVE",
    assigned_by: account.appUserId,
  });

  if (error) {
    const already = /duplicate|unique/i.test(error.message);
    return {
      ...EMPTY_LOOKUP,
      error: already
        ? "That clinician already appears in your care team."
        : "Could not grant access. Try again.",
    };
  }

  await recordAudit(supabase, account.authUserId, {
    action: "CARE_TEAM_UPDATED",
    resourceType: "PROFILE",
    metadata: { outcome: "doctor_assigned" },
  });

  revalidatePath("/care-team");
  return { found: null, message: "Access granted. They can now see your monitoring data.", error: null };
}

export type CaregiverInviteState = { message: string | null; error: string | null };

const EMPTY_INVITE: CaregiverInviteState = { message: null, error: null };

export async function inviteCaregiverAction(
  _previous: CaregiverInviteState,
  formData: FormData,
): Promise<CaregiverInviteState> {
  const email = String(formData.get("email") ?? "").trim();
  const relationship = String(formData.get("relationship") ?? "").trim();
  const permission = String(formData.get("permission") ?? "VIEW_ALERTS") as CaregiverPermission;

  if (!email.includes("@")) {
    return { message: null, error: "Enter the email address they signed up with." };
  }
  if (!["VIEW_ALERTS", "VIEW_VITALS", "FULL"].includes(permission)) {
    return { message: null, error: "Choose what they should be able to see." };
  }

  const account = await requireUser();
  if (!account.patientProfileId) {
    return { message: null, error: "Complete your health profile first." };
  }

  // The rate limit that matters. invite_caregiver reports whether an address
  // has an account, and this is what keeps that from being a bulk lookup.
  const limited = await checkRateLimit(
    rateLimitStore(),
    "careTeamChange",
    account.patientProfileId,
  );
  if (!limited.allowed) {
    return {
      message: null,
      error: "You have made a lot of changes recently. Try again in a little while.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("invite_caregiver", {
    p_email: email,
    p_relationship: relationship || null,
    p_permission: permission,
  });

  if (error) return { message: null, error: "Could not add them. Try again." };

  switch (data) {
    case "ASSIGNED":
      await recordAudit(supabase, account.authUserId, {
        action: "CARE_TEAM_UPDATED",
        resourceType: "PROFILE",
        metadata: { outcome: "caregiver_assigned" },
      });
      revalidatePath("/care-team");
      return { message: "Added. They will be notified when something needs attention.", error: null };
    case "SELF":
      return { message: null, error: "That is your own account." };
    case "NO_ACCOUNT":
      return {
        message: null,
        error: "Nobody has signed up to AVERIS with that address yet. Ask them to create an account first.",
      };
    default:
      return { message: null, error: "Complete your health profile first." };
  }
}

export async function revokeDoctorAction(formData: FormData): Promise<void> {
  const assignmentId = String(formData.get("assignmentId") ?? "");
  if (!assignmentId) return;

  const account = await requireUser();
  const supabase = await createClient();

  await revokeDoctor(supabase, assignmentId);
  await recordAudit(supabase, account.authUserId, {
    action: "CARE_TEAM_UPDATED",
    resourceType: "PROFILE",
    metadata: { outcome: "doctor_revoked" },
  });

  revalidatePath("/care-team");
}

export async function revokeCaregiverAction(formData: FormData): Promise<void> {
  const assignmentId = String(formData.get("assignmentId") ?? "");
  if (!assignmentId) return;

  const account = await requireUser();
  const supabase = await createClient();

  await revokeCaregiver(supabase, assignmentId);
  await recordAudit(supabase, account.authUserId, {
    action: "CARE_TEAM_UPDATED",
    resourceType: "PROFILE",
    metadata: { outcome: "caregiver_revoked" },
  });

  revalidatePath("/care-team");
}

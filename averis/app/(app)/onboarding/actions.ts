"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { onboardingSchema } from "@/lib/validation/patient";
import type { BloodGroup, GenderIdentity } from "@/lib/supabase/database.types";

export type OnboardingResult = { ok: boolean; error: string | null };

/**
 * Creates the patient's profile and health information.
 *
 * Authorization is re-established here via `requireUser()`. Server Actions are
 * POSTs to their host route, so proxy coverage alone is not a guarantee.
 */
export async function completeOnboardingAction(
  payload: unknown,
): Promise<OnboardingResult> {
  const account = await requireUser();

  const parsed = onboardingSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check your answers and try again." };
  }
  const data = parsed.data;

  const supabase = await createClient();

  // Keep the display name on the identity record in step with onboarding.
  const { error: userError } = await supabase
    .from("users")
    .update({ full_name: data.fullName })
    .eq("id", account.appUserId);
  if (userError) return { ok: false, error: "We couldn't save your name. Try again." };

  // upsert on the unique user_id so a retry after a partial failure is safe.
  const { data: profile, error: profileError } = await supabase
    .from("patient_profiles")
    .upsert(
      {
        user_id: account.appUserId,
        date_of_birth: data.dateOfBirth,
        gender: data.gender as GenderIdentity,
        phone_number: data.phoneNumber,
        blood_group: data.bloodGroup as BloodGroup,
        emergency_contact: data.emergencyContact || null,
      },
      { onConflict: "user_id" },
    )
    .select("id")
    .single();

  if (profileError || !profile) {
    return { ok: false, error: "We couldn't save your profile. Check the details and try again." };
  }

  const { error: healthError } = await supabase.from("patient_health_information").upsert(
    {
      patient_id: profile.id,
      allergies: data.allergies,
      existing_conditions: data.existingConditions,
      current_medications: data.currentMedications,
      medical_notes: data.medicalNotes || null,
    },
    { onConflict: "patient_id" },
  );

  if (healthError) {
    return { ok: false, error: "We couldn't save your health information. Try again." };
  }

  revalidatePath("/dashboard");
  revalidatePath("/onboarding");
  return { ok: true, error: null };
}

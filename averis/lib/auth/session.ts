import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type AccountState = {
  authUserId: string;
  email: string;
  /** public.users row id */
  appUserId: string;
  fullName: string | null;
  profileImage: string | null;
  role: string;
  /** null until onboarding completes */
  patientProfileId: string | null;
  /**
   * Whether this account has a clinician profile, and whether anyone has made
   * them a caregiver.
   *
   * Both are *navigation* facts, not authorization. Nothing is permitted
   * because one of these is true — RLS decides that — but a doctor whose
   * account has no patient profile of their own would otherwise see an
   * application with no navigation in it at all, which is how the clinical
   * dashboard ends up reachable only by typing the URL.
   */
  isClinician: boolean;
  isCaregiver: boolean;
};

/**
 * Returns the signed-in account, or redirects to /login.
 *
 * Every protected page and Server Action calls this. `proxy.ts` also gates
 * routes, but Server Actions are POSTs to their host route — relying on the
 * proxy alone would let a matcher change silently remove authorization.
 */
export async function requireUser(): Promise<AccountState> {
  const state = await getAccountState();
  if (!state) redirect("/login");
  return state;
}

export async function getAccountState(): Promise<AccountState | null> {
  const supabase = await createClient();

  // getUser() re-validates the JWT with the auth server, unlike getSession().
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: appUser } = await supabase
    .from("users")
    .select("id, email, full_name, profile_image, role")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!appUser) {
    // The auth trigger provisions this row; a missing row means the account is
    // mid-provision. Treat as signed out rather than rendering a broken shell.
    return null;
  }

  const [profile, doctor, caregiverFor] = await Promise.all([
    supabase.from("patient_profiles").select("id").eq("user_id", appUser.id).maybeSingle(),
    supabase.from("doctors").select("id").eq("user_id", appUser.id).maybeSingle(),
    // Counted rather than fetched: the layout needs "any", and reading the
    // assignments themselves on every page render would be a page's worth of
    // work for a link.
    supabase
      .from("patient_caregiver_assignments")
      .select("id", { count: "exact", head: true })
      .eq("caregiver_id", appUser.id)
      .eq("status", "ACTIVE"),
  ]);

  return {
    authUserId: user.id,
    email: appUser.email,
    appUserId: appUser.id,
    fullName: appUser.full_name,
    profileImage: appUser.profile_image,
    role: appUser.role,
    patientProfileId: profile.data?.id ?? null,
    isClinician: Boolean(doctor.data),
    isCaregiver: (caregiverFor.count ?? 0) > 0,
  };
}

/** Where a signed-in patient belongs right now. */
export function landingRouteFor(state: AccountState): string {
  return state.patientProfileId ? "/dashboard" : "/onboarding";
}

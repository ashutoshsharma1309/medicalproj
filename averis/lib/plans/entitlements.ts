import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  checkDocumentQuota,
  checkQuestionQuota,
  dayStart,
  hasFeature,
  limitsFor,
  monthStart,
  type Plan,
  type PlanLimits,
  type QuotaCheck,
  type SubscriptionState,
} from "./limits";

/**
 * Reading and enforcing entitlements.
 *
 * Usage is counted from the tables that already record the work — uploaded
 * documents and stored conversations — rather than from a separate counter.
 *
 * That is a deliberate trade. A counter column is one increment away from
 * drifting out of agreement with reality, and when it does the failure is
 * silent in the worst direction: a patient who deleted five documents still
 * cannot upload, or one who hit an error path gets free capacity. Counting the
 * rows is slower and cannot disagree with itself.
 *
 * Every query here is scoped to the caller's own id, and the underlying tables
 * are RLS-protected regardless.
 */

export type Entitlements = {
  plan: Plan;
  status: SubscriptionState;
  limits: PlanLimits;
};

export async function readEntitlements(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Entitlements> {
  const { data } = await supabase
    .from("subscriptions")
    .select("plan, subscription_status")
    .eq("user_id", userId)
    .maybeSingle();

  // A missing row means FREE. The migration backfills every user and a trigger
  // covers new ones, so this should not happen — but defaulting to the paid
  // tier on a read failure would be the wrong way to be wrong.
  const plan = (data?.plan ?? "FREE") as Plan;
  const status = (data?.subscription_status ?? "ACTIVE") as SubscriptionState;

  return { plan, status, limits: limitsFor(plan, status) };
}

export async function documentQuota(
  supabase: SupabaseClient<Database>,
  userId: string,
  patientProfileId: string,
  now = new Date(),
): Promise<QuotaCheck> {
  const { plan, status } = await readEntitlements(supabase, userId);

  const { count } = await supabase
    .from("medical_documents")
    .select("id", { count: "exact", head: true })
    .eq("patient_id", patientProfileId)
    .gte("uploaded_at", monthStart(now));

  return checkDocumentQuota(plan, status, count ?? 0);
}

export async function questionQuota(
  supabase: SupabaseClient<Database>,
  userId: string,
  patientProfileId: string,
  now = new Date(),
): Promise<QuotaCheck> {
  const { plan, status } = await readEntitlements(supabase, userId);

  const { count } = await supabase
    .from("ai_conversations")
    .select("id", { count: "exact", head: true })
    .eq("patient_id", patientProfileId)
    .gte("created_at", dayStart(now));

  return checkQuestionQuota(plan, status, count ?? 0);
}

export async function canUseFeature(
  supabase: SupabaseClient<Database>,
  userId: string,
  feature: "riskIntelligence" | "aiHealthSummary",
): Promise<boolean> {
  const { plan, status } = await readEntitlements(supabase, userId);
  return hasFeature(plan, status, feature);
}

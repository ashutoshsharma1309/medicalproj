import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The care team's inbox.
 *
 * Read and dismiss only, like `notification-service`, and for the same reason:
 * no client role has INSERT on `care_notifications`. These rows are written
 * inside `private.raise_emergency()`, which runs as the service role — a
 * browser that could write here could tell a doctor a patient had collapsed.
 *
 * Every read below is scoped by RLS to the signed-in recipient. The `.eq()` on
 * recipient_id is *not* the access control; it is there so a doctor who is also
 * a caregiver does not pay for a full-table scan the policy would filter
 * anyway.
 */

export type CareNotice = {
  id: string;
  patientId: string;
  emergencyId: string | null;
  severity: "INFO" | "WARNING" | "CRITICAL";
  title: string;
  body: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
};

export async function listCareNotices(
  supabase: SupabaseClient<Database>,
  recipientId: string,
  limit = 25,
): Promise<CareNotice[]> {
  const { data, error } = await supabase
    .from("care_notifications")
    .select("id, patient_id, emergency_id, severity, title, body, href, read_at, created_at")
    .eq("recipient_id", recipientId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Could not read your alerts: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    patientId: row.patient_id,
    emergencyId: row.emergency_id,
    severity: row.severity,
    title: row.title,
    body: row.body,
    href: row.href,
    readAt: row.read_at,
    createdAt: row.created_at,
  }));
}

export async function unreadCareCount(
  supabase: SupabaseClient<Database>,
  recipientId: string,
): Promise<number> {
  const { count } = await supabase
    .from("care_notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_id", recipientId)
    .is("read_at", null);

  return count ?? 0;
}

/**
 * Dismissal.
 *
 * Not scoped by recipient here — the UPDATE policy already restricts which
 * rows this can touch, and a second copy of the predicate is a second thing to
 * keep in step.
 *
 * Dismissing a notice does **not** touch the emergency it points at. They are
 * different claims: "I have seen this message" and "somebody has dealt with
 * this patient". Collapsing them would let an emergency be closed by clearing
 * a notification, which is precisely the outcome the workflow exists to
 * prevent.
 */
export async function dismissCareNotice(
  supabase: SupabaseClient<Database>,
  noticeId: string,
): Promise<void> {
  const { error } = await supabase
    .from("care_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", noticeId);

  if (error) throw new Error(`Could not dismiss the alert: ${error.message}`);
}

export async function dismissAllCareNotices(
  supabase: SupabaseClient<Database>,
  recipientId: string,
): Promise<void> {
  const { error } = await supabase
    .from("care_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("recipient_id", recipientId)
    .is("read_at", null);

  if (error) throw new Error(`Could not dismiss your alerts: ${error.message}`);
}

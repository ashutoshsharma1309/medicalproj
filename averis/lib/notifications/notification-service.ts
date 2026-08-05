import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Notifications.
 *
 * Read and dismiss only. There is no `create` here on purpose: no client role
 * has insert on the table, so a notification can only originate from the
 * worker, which connects with elevated credentials. Something in the browser
 * that could write here could tell a patient their report finished processing
 * when it had not — and a health platform's notifications are trusted
 * precisely because they are not user-generated.
 *
 * Delivery is in-app only. Email and push are named as future work in the
 * brief and are deliberately not stubbed: a notification channel that silently
 * does nothing is worse than an absent one, because the code reads as though
 * patients are being told and they are not.
 */

export type Notification = {
  id: string;
  kind: "DOCUMENT_PROCESSED" | "DOCUMENT_FAILED" | "INSIGHT_GENERATED" | "PROFILE_UPDATED";
  title: string;
  body: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
};

export async function listNotifications(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
  limit = 20,
): Promise<Notification[]> {
  const { data, error } = await supabase
    .from("notifications")
    .select("id, kind, title, body, href, read_at, created_at")
    .eq("patient_id", patientProfileId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Could not read your notifications: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    href: row.href,
    readAt: row.read_at,
    createdAt: row.created_at,
  }));
}

export async function unreadCount(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
): Promise<number> {
  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("patient_id", patientProfileId)
    .is("read_at", null);

  return count ?? 0;
}

/** Dismissal. The only field a patient may change. */
export async function markRead(
  supabase: SupabaseClient<Database>,
  notificationId: string,
): Promise<void> {
  // Not scoped by patient here: the UPDATE policy already restricts the rows
  // this can touch, and repeating the predicate would be a second copy of the
  // rule that can drift from the first.
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId);

  if (error) throw new Error(`Could not dismiss the notification: ${error.message}`);
}

export async function markAllRead(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
): Promise<void> {
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("patient_id", patientProfileId)
    .is("read_at", null);

  if (error) throw new Error(`Could not dismiss your notifications: ${error.message}`);
}

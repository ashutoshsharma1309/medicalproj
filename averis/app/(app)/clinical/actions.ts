"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { dismissAllCareNotices, dismissCareNotice } from "@/lib/care/care-inbox-service";

/**
 * Dismissing an alert.
 *
 * Deliberately the only write the inbox has. Acknowledging and resolving the
 * emergency itself live on the patient's chart, because those are clinical
 * acts that belong next to the evidence for them — an emergency that can be
 * closed from a notification list is one that gets closed without anyone
 * looking at the patient.
 */

export async function dismissNotice(formData: FormData): Promise<void> {
  const noticeId = String(formData.get("noticeId") ?? "");
  if (!noticeId) return;

  await requireUser();
  const supabase = await createClient();

  await dismissCareNotice(supabase, noticeId);
  revalidatePath("/clinical");
  revalidatePath("/care");
}

export async function dismissAllNotices(): Promise<void> {
  const account = await requireUser();
  const supabase = await createClient();

  await dismissAllCareNotices(supabase, account.appUserId);
  revalidatePath("/clinical");
  revalidatePath("/care");
}

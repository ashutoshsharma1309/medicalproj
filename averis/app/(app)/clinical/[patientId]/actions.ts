"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit/audit-service";

/**
 * The emergency response workflow.
 *
 * NEW → ACKNOWLEDGED → IN_PROGRESS → RESOLVED.
 *
 * Authorization is RLS's: only a doctor with an ACTIVE assignment can update a
 * patient's emergency, and the policy carries both USING and WITH CHECK so the
 * row cannot be moved to another patient while being updated. This file adds
 * no ownership check of its own, for the same reason as everywhere else in
 * AVERIS — a second copy of the rule is a second thing to keep in step.
 *
 * What it does enforce is attribution: resolving names the person who resolved
 * it, because the database constraint refuses a resolution with nobody
 * attached. "Resolved by nobody" is how an emergency gets closed without
 * anyone having looked at the patient.
 */

export async function acknowledgeEmergency(formData: FormData): Promise<void> {
  const eventId = String(formData.get("eventId") ?? "");
  const patientId = String(formData.get("patientId") ?? "");
  if (!eventId) return;

  const account = await requireUser();
  const supabase = await createClient();

  await supabase
    .from("emergency_events")
    .update({
      status: "ACKNOWLEDGED",
      acknowledged_by: account.appUserId,
      acknowledged_at: new Date().toISOString(),
    })
    .eq("id", eventId);

  await recordAudit(supabase, account.authUserId, {
    action: "EMERGENCY_ACKNOWLEDGED",
    resourceType: "EMERGENCY",
    resourceId: eventId,
    metadata: { outcome: "acknowledged" },
  });

  revalidatePath(`/clinical/${patientId}`);
}

export async function startResponse(formData: FormData): Promise<void> {
  const eventId = String(formData.get("eventId") ?? "");
  const patientId = String(formData.get("patientId") ?? "");
  if (!eventId) return;

  const account = await requireUser();
  const supabase = await createClient();

  await supabase.from("emergency_events").update({ status: "IN_PROGRESS" }).eq("id", eventId);

  await recordAudit(supabase, account.authUserId, {
    action: "EMERGENCY_ACKNOWLEDGED",
    resourceType: "EMERGENCY",
    resourceId: eventId,
    metadata: { outcome: "response_started" },
  });

  revalidatePath(`/clinical/${patientId}`);
}

export async function resolveEmergency(formData: FormData): Promise<void> {
  const eventId = String(formData.get("eventId") ?? "");
  const patientId = String(formData.get("patientId") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (!eventId) return;

  const account = await requireUser();
  const supabase = await createClient();

  await supabase
    .from("emergency_events")
    .update({
      status: "RESOLVED",
      // Both required by a CHECK constraint: an unattributed resolution is
      // rejected by the database, not merely discouraged here.
      resolved_by: account.appUserId,
      resolved_at: new Date().toISOString(),
      resolution_note: note || null,
    })
    .eq("id", eventId);

  await recordAudit(supabase, account.authUserId, {
    action: "EMERGENCY_RESOLVED",
    resourceType: "EMERGENCY",
    resourceId: eventId,
    metadata: { outcome: "resolved" },
  });

  revalidatePath(`/clinical/${patientId}`);
}

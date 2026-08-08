"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit/audit-service";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { rateLimitStore } from "@/lib/security/rate-limit-store";
import { generateReport, storeReport } from "@/lib/care/report-service";
import { askAboutPatient } from "@/lib/care/assistant-service";
import type { AssistantAnswer } from "@/lib/care/assistant";

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

/**
 * Generating a patient summary.
 *
 * The window is fixed by the caller's choice of hours and never by a patient
 * id from the form — the id is used only to scope the read, and RLS decides
 * whether that read returns anything. A clinician without an active assignment
 * generates a summary of an empty window rather than someone else's chart.
 *
 * Rate-limited because each call is an outbound model request, and audited
 * because a summary is a clinical artefact that someone put their name on.
 */
export async function generateReportAction(formData: FormData): Promise<void> {
  const patientId = String(formData.get("patientId") ?? "");
  const windowHours = Number(formData.get("windowHours") ?? 24);
  if (!patientId) return;

  const account = await requireUser();
  const supabase = await createClient();

  const limited = await checkRateLimit(rateLimitStore(), "healthReport", account.appUserId);
  if (!limited.allowed) return;

  const report = await generateReport(supabase, patientId, {
    windowHours: [6, 24, 72].includes(windowHours) ? windowHours : 24,
  });

  await storeReport(supabase, patientId, account.appUserId, report);

  await recordAudit(supabase, account.authUserId, {
    action: "HEALTH_REPORT_GENERATED",
    resourceType: "REPORT",
    resourceId: patientId,
    metadata: {
      outcome: report.guardrailTriggered ? "guardrail_rewritten" : "generated",
      model: report.generatedWith,
      recordCount: report.sections.readingCount,
      guardrailTriggered: report.guardrailTriggered,
    },
  });

  revalidatePath(`/clinical/${patientId}`);
}

export type AssistantState = {
  question: string;
  answer: (AssistantAnswer & { generatedBy: string }) | null;
  error: string | null;
};

export const EMPTY_ASSISTANT: AssistantState = { question: "", answer: null, error: null };

/**
 * Asking about a patient.
 *
 * The patient id comes from the form and is used only to scope an RLS-bound
 * read — a clinician asking about someone they are not assigned to gets an
 * answer built from an empty context ("no readings"), not a refusal, because a
 * refusal would confirm the patient exists.
 *
 * The question text is never audited, only its length and the intent it was
 * classified as. A clinician's questions about a patient are as sensitive as
 * the chart they are about.
 */
export async function askAssistantAction(
  _previous: AssistantState,
  formData: FormData,
): Promise<AssistantState> {
  const patientId = String(formData.get("patientId") ?? "");
  const question = String(formData.get("question") ?? "").trim();

  if (question.length < 3) {
    return { ...EMPTY_ASSISTANT, error: "Ask a question about this patient's monitoring data." };
  }
  if (!patientId) return { ...EMPTY_ASSISTANT, error: "No patient selected." };

  const account = await requireUser();

  const limited = await checkRateLimit(rateLimitStore(), "careAssistant", account.appUserId);
  if (!limited.allowed) {
    return {
      ...EMPTY_ASSISTANT,
      error: `You have asked a lot of questions recently. Try again in about ${Math.ceil(
        limited.retryAfterMs / 60000,
      )} minutes.`,
    };
  }

  try {
    const supabase = await createClient();
    const answer = await askAboutPatient(supabase, patientId, question, "CLINICIAN");

    await recordAudit(supabase, account.authUserId, {
      action: "AI_QUESTION_ASKED",
      resourceType: "CONVERSATION",
      resourceId: patientId,
      metadata: {
        questionLength: question.length,
        outcome: answer.intent,
        model: answer.generatedBy,
        abstained: answer.declined,
      },
    });

    return { question, answer, error: null };
  } catch {
    return {
      ...EMPTY_ASSISTANT,
      error: "Something went wrong reading this patient's monitoring data. Try again.",
    };
  }
}

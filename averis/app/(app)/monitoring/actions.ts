"use server";

import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit/audit-service";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { rateLimitStore } from "@/lib/security/rate-limit-store";
import { askAboutPatient } from "@/lib/care/assistant-service";
import type { AssistantAnswer } from "@/lib/care/assistant";

/**
 * The patient asking about their own monitoring.
 *
 * Takes no patient id at all — it comes from the session. There is no
 * parameter here an attacker could substitute, which is a stronger property
 * than the clinical version can have (a doctor genuinely does need to name
 * which of their patients they mean).
 */

export type MonitoringAskState = {
  question: string;
  answer: (AssistantAnswer & { generatedBy: string }) | null;
  error: string | null;
};

export const EMPTY_ASK: MonitoringAskState = { question: "", answer: null, error: null };

export async function askAboutMyMonitoring(
  _previous: MonitoringAskState,
  formData: FormData,
): Promise<MonitoringAskState> {
  const question = String(formData.get("question") ?? "").trim();
  if (question.length < 3) {
    return { ...EMPTY_ASK, error: "Ask a question about your monitoring." };
  }

  const account = await requireUser();
  if (!account.patientProfileId) {
    return { ...EMPTY_ASK, error: "Complete your health profile first." };
  }

  const limited = await checkRateLimit(
    rateLimitStore(),
    "careAssistant",
    account.patientProfileId,
  );
  if (!limited.allowed) {
    return {
      ...EMPTY_ASK,
      error: `You have asked a lot of questions recently. Try again in about ${Math.ceil(
        limited.retryAfterMs / 60000,
      )} minutes.`,
    };
  }

  try {
    const supabase = await createClient();
    const answer = await askAboutPatient(
      supabase,
      account.patientProfileId,
      question,
      "PATIENT",
    );

    // The question text is not recorded, only its shape — a patient's
    // questions are as sensitive as the data they ask about.
    await recordAudit(supabase, account.authUserId, {
      action: "AI_QUESTION_ASKED",
      resourceType: "CONVERSATION",
      metadata: {
        questionLength: question.length,
        outcome: answer.intent,
        model: answer.generatedBy,
        abstained: answer.declined,
      },
    });

    return { question, answer, error: null };
  } catch {
    return { ...EMPTY_ASK, error: "Something went wrong reading your monitoring data. Try again." };
  }
}

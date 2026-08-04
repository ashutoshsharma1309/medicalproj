"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { askAveris } from "@/lib/rag/rag-service";
import type { GroundedAnswer } from "@/lib/rag/types";

/**
 * Asking a question.
 *
 * The action takes no patient identifier — it derives one from the session,
 * so there is no parameter an attacker could substitute. Combined with the
 * RLS-scoped retrieval underneath, cross-patient access has no representation
 * at any layer of this call.
 */

export type AskState = {
  answer: GroundedAnswer | null;
  error: string | null;
};

export async function askAction(
  _previous: AskState,
  formData: FormData,
): Promise<AskState> {
  const question = String(formData.get("question") ?? "").trim();

  if (question.length < 3) {
    return { answer: null, error: "Ask a question about your records." };
  }

  const account = await requireUser();
  if (!account.patientProfileId) {
    return { answer: null, error: "Complete your health profile first." };
  }

  try {
    const supabase = await createClient();
    const answer = await askAveris(supabase, account.patientProfileId, question);
    revalidatePath("/intelligence");
    return { answer, error: null };
  } catch (error) {
    // The underlying message can name tables and columns; a patient gets a
    // sentence they can act on instead.
    const message =
      error instanceof Error && /model|embedding/i.test(error.message)
        ? "The language model AVERIS uses is not available right now. Try again shortly."
        : "Something went wrong looking through your records. Try again.";
    return { answer: null, error: message };
  }
}

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  assembleReport,
  describeReport,
  enforceNoClinicalJudgement,
  type ReportSections,
} from "./report";
import {
  buildAssistantPrompt,
  classifyIntent,
  deterministicAnswer,
  groundsFrom,
  systemPromptFor,
  type AssistantAnswer,
  type Audience,
} from "./assistant";

/**
 * Answering a question about monitoring data.
 *
 * The context is the same `ReportSections` the summary is built from — one
 * assembly, used by both, so the assistant cannot tell a clinician something
 * the summary of the same window contradicts.
 *
 * **An out-of-scope question never reaches the model.** It is refused from the
 * classification, before a prompt is built and before a request is made. A
 * refusal that depends on the model honouring its system prompt is a refusal
 * that can be talked out of, and "should I stop my beta blocker" is exactly
 * the question someone will keep rephrasing until something answers.
 */

/** How much history a question is answered from. */
const CONTEXT_HOURS = 24;

export async function askAboutPatient(
  supabase: SupabaseClient<Database>,
  patientId: string,
  question: string,
  audience: Audience,
  now: Date = new Date(),
): Promise<AssistantAnswer & { generatedBy: string }> {
  const intent = classifyIntent(question);

  // Before any context is loaded: an answer AVERIS must not give does not
  // need a patient's data assembled to refuse it.
  if (intent === "OUT_OF_SCOPE") {
    return {
      ...deterministicAnswer(intent, emptySections(now), audience),
      generatedBy: "rule",
    };
  }

  const sections = await loadContext(supabase, patientId, now);
  const fallback = deterministicAnswer(intent, sections, audience);

  if (intent === "UNSUPPORTED" || sections.readingCount === 0) {
    return { ...fallback, generatedBy: "rule" };
  }

  try {
    const provider = await import("@/lib/ai/provider");
    if (!provider.isAiConfigured()) return { ...fallback, generatedBy: "deterministic" };

    const raw = await provider.aiComplete({
      messages: [
        { role: "system", content: systemPromptFor(audience) },
        {
          role: "user",
          content: buildAssistantPrompt(question, describeReport(sections), intent),
        },
      ],
      maxTokens: 400,
    });

    const guarded = enforceNoClinicalJudgement(raw.trim(), sections);
    if (guarded.rewritten) {
      // The guardrail's replacement is the *report* narration, which answers a
      // different question than the one asked. The deterministic answer for
      // this intent is the better fallback, so the reader gets an answer to
      // their question rather than a summary of the window.
      return { ...fallback, generatedBy: "deterministic" };
    }

    return {
      intent,
      answer: guarded.summary,
      grounds: groundsFrom(sections),
      declined: false,
      generatedBy: provider.resolveProvider().model,
    };
  } catch {
    return { ...fallback, generatedBy: "deterministic" };
  }
}

async function loadContext(
  supabase: SupabaseClient<Database>,
  patientId: string,
  now: Date,
): Promise<ReportSections> {
  const start = new Date(now.getTime() - CONTEXT_HOURS * 3600_000);

  // RLS-scoped, like everything else. A question about a patient the caller is
  // not on the care team for is answered from an empty context — "no readings"
  // — rather than refused, because a refusal would confirm the patient exists.
  const [readings, alerts, emergencies, prediction] = await Promise.all([
    supabase
      .from("sensor_readings")
      .select("heart_rate, spo2, temperature, recorded_at")
      .eq("patient_id", patientId)
      .gte("recorded_at", start.toISOString())
      .order("recorded_at", { ascending: true })
      .limit(3000)
      .then(({ data }) => data ?? []),
    supabase
      .from("alerts")
      .select("severity")
      .eq("patient_id", patientId)
      .gte("created_at", start.toISOString())
      .then(({ data }) => data ?? []),
    supabase
      .from("emergency_events")
      .select("event_type, severity, status, summary, created_at")
      .eq("patient_id", patientId)
      .gte("created_at", start.toISOString())
      .order("created_at", { ascending: false })
      .then(({ data }) => data ?? []),
    supabase
      .from("health_predictions")
      .select("risk_score, risk_category, confidence_score, explanation, created_at")
      .eq("patient_id", patientId)
      .eq("prediction_type", "VITAL_DETERIORATION")
      .order("created_at", { ascending: false })
      .limit(1)
      .then(({ data }) => data?.[0] ?? null),
  ]);

  return assembleReport({
    periodStart: start.toISOString(),
    periodEnd: now.toISOString(),
    readings,
    alerts,
    emergencies,
    prediction,
  });
}

function emptySections(now: Date): ReportSections {
  return assembleReport({
    periodStart: new Date(now.getTime() - CONTEXT_HOURS * 3600_000).toISOString(),
    periodEnd: now.toISOString(),
    readings: [],
    alerts: [],
    emergencies: [],
    prediction: null,
  });
}

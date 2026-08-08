import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  assembleReport,
  describeReport,
  deterministicNarrative,
  enforceNoClinicalJudgement,
  type ReportSections,
} from "./report";

/**
 * Generating a patient summary.
 *
 * The model phrases; it does not decide. Every number in the prompt comes from
 * `assembleReport`, which is arithmetic over stored readings — so the worst a
 * model failure can produce is clumsy prose about true facts, never a trend
 * that did not happen.
 *
 * Three fallbacks, all landing in the same place: no key configured, the call
 * failed, or the guardrail rejected what came back. Each falls through to the
 * deterministic narration of the same sections, so a clinician who asked for a
 * summary always receives one and always receives a true one.
 */

const SYSTEM_PROMPT = `You write monitoring summaries for clinicians inside AVERIS, a remote patient monitoring platform.

You are given measurements and events already computed from the patient's stored sensor data. Restate them in clear clinical prose. You are NOT analysing anything and you are NOT the treating clinician.

Hard rules:
- Use ONLY the facts provided. Never add a value, direction, symptom or event that is not in the input.
- NEVER diagnose, name a condition, estimate prognosis, or recommend any treatment, test or disposition.
- Restating a measurement and the threshold it crossed is allowed. Saying what it means is not.
  ALLOWED:     "Blood oxygen averaged 93% and fell to 88% twice, below the 90% escalation threshold."
  NOT ALLOWED: "The desaturations suggest an evolving respiratory infection and warrant antibiotics."
- Say plainly when monitoring was interrupted. A quiet window is not a reassuring one.
- 4 to 6 sentences, plain prose, third person about the patient. No headings, no bullet points, no markdown.`;

export type GeneratedReport = {
  summary: string;
  sections: ReportSections;
  generatedWith: string;
  /** True when the guardrail replaced the model's phrasing. */
  guardrailTriggered: boolean;
};

/** How far back a summary looks when the caller does not say. */
export const DEFAULT_WINDOW_HOURS = 24;

export async function generateReport(
  supabase: SupabaseClient<Database>,
  patientId: string,
  options: { windowHours?: number; now?: Date } = {},
): Promise<GeneratedReport> {
  const now = options.now ?? new Date();
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const start = new Date(now.getTime() - windowHours * 3600_000);

  // Every one of these is RLS-scoped. A doctor without an active assignment
  // receives empty arrays and generates a report about nothing, rather than a
  // report about somebody else's patient.
  const [readings, alerts, emergencies, prediction] = await Promise.all([
    supabase
      .from("sensor_readings")
      .select("heart_rate, spo2, temperature, recorded_at")
      .eq("patient_id", patientId)
      .gte("recorded_at", start.toISOString())
      .lte("recorded_at", now.toISOString())
      .order("recorded_at", { ascending: true })
      .limit(5000)
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

  const sections = assembleReport({
    periodStart: start.toISOString(),
    periodEnd: now.toISOString(),
    readings,
    alerts,
    emergencies,
    prediction,
  });

  return narrate(sections);
}

async function narrate(sections: ReportSections): Promise<GeneratedReport> {
  const deterministic: GeneratedReport = {
    summary: deterministicNarrative(sections),
    sections,
    generatedWith: "deterministic",
    guardrailTriggered: false,
  };

  // A window with nothing in it does not need a language model to describe it,
  // and asking one to write six sentences about no data is how a report ends
  // up sounding like a patient was monitored when they were not.
  if (sections.readingCount === 0) return deterministic;

  try {
    const provider = await import("@/lib/ai/provider");
    if (!provider.isAiConfigured()) return deterministic;

    const raw = await provider.aiComplete({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Summarise this patient's monitoring window using only these facts.\n\n${describeReport(sections)}`,
        },
      ],
      maxTokens: 600,
    });

    const guarded = enforceNoClinicalJudgement(raw.trim(), sections);

    return {
      summary: guarded.summary,
      sections,
      // Named honestly: when the guardrail fired, what the clinician is
      // reading is the deterministic text, and the record should say so.
      generatedWith: guarded.rewritten
        ? "deterministic"
        : provider.resolveProvider().model,
      guardrailTriggered: guarded.rewritten,
    };
  } catch {
    return deterministic;
  }
}

/** Persists a generated report. Returns its id. */
export async function storeReport(
  supabase: SupabaseClient<Database>,
  patientId: string,
  generatedBy: string,
  report: GeneratedReport,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("patient_health_reports")
    .insert({
      patient_id: patientId,
      generated_by: generatedBy,
      period_start: report.sections.periodStart,
      period_end: report.sections.periodEnd,
      summary: report.summary,
      // Stored alongside the prose so the narration stays checkable against
      // its own inputs after the model has changed.
      sections: report.sections,
      generated_with: report.generatedWith,
    })
    .select("id")
    .maybeSingle();

  if (error) throw new Error(`Could not save the summary: ${error.message}`);
  return data?.id ?? null;
}

export type StoredReport = {
  id: string;
  periodStart: string;
  periodEnd: string;
  summary: string;
  generatedWith: string;
  createdAt: string;
};

export async function listReports(
  supabase: SupabaseClient<Database>,
  patientId: string,
  limit = 5,
): Promise<StoredReport[]> {
  const { data } = await supabase
    .from("patient_health_reports")
    .select("id, period_start, period_end, summary, generated_with, created_at")
    .eq("patient_id", patientId)
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? []).map((row) => ({
    id: row.id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    summary: row.summary,
    generatedWith: row.generated_with,
    createdAt: row.created_at,
  }));
}

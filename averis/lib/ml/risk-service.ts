import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { buildDigitalTwin } from "@/lib/services/twin/digital-twin-service";
import type { ConfirmedRecordRow } from "@/lib/services/twin/types";
import { loadArtifact, listModels } from "./artifact";
import { extractFeatures } from "./features";
import { explainPrediction, type RiskExplanation } from "./explanation-service";
import { predict, type DerivedValue } from "./predict";
import type { RiskModel, RiskPrediction } from "./types";

/**
 * Risk assessment orchestration.
 *
 * Every query here is scoped to a patient profile id the caller has already
 * been proved to own. RLS is the second line of defence, not the only one —
 * a policy is a backstop for a mistake in this file, not a substitute for
 * writing it correctly.
 *
 * Model files never leave the server: they are bundled into the server build
 * by a static import in artifact.ts, and no route serves them.
 */

export type RiskAssessment = {
  prediction: RiskPrediction;
  explanation: RiskExplanation;
  /** Held-out performance of the model that produced this. */
  metrics: { roc_auc: number; recall: number; precision: number; accuracy: number };
  dataset: { name: string; rows: number; cohort: string; caveat: string };
};

/**
 * Scores one model from the patient's own confirmed records.
 *
 * Reads the twin rather than re-querying documents: Phase 3 already assembled
 * the patient-confirmed picture, and deriving features from anything less
 * would mean scoring data the patient never confirmed.
 */
export async function assessRisk(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
  model: RiskModel,
  overrides: Record<string, number> = {},
): Promise<RiskAssessment> {
  const artifact = loadArtifact(model);

  const [twin, records] = await Promise.all([
    buildDigitalTwin(supabase, patientProfileId),
    fetchConfirmedRecords(supabase, patientProfileId),
  ]);

  const derived = extractFeatures(model, twin, records);

  // An explicit value from the patient wins over anything inferred from their
  // documents: they are correcting the record, and a correction that loses to
  // a stale lab result would be worse than not offering the field at all.
  for (const [name, value] of Object.entries(overrides)) {
    derived[name] = { value, sourceLabel: "You entered this value" };
  }

  const prediction = predict(artifact, derived as Record<string, DerivedValue | undefined>);
  const explanation = await explainPrediction(prediction, artifact);
  const served = artifact.metrics[artifact.served_algorithm];

  return {
    prediction,
    explanation,
    metrics: {
      roc_auc: served?.roc_auc ?? 0,
      recall: served?.recall ?? 0,
      precision: served?.precision ?? 0,
      accuracy: served?.accuracy ?? 0,
    },
    dataset: {
      name: artifact.dataset.name,
      rows: artifact.dataset.rows,
      cohort: artifact.dataset.cohort,
      caveat: artifact.dataset.caveat,
    },
  };
}

export async function assessAllRisks(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
): Promise<Record<RiskModel, RiskAssessment>> {
  const entries = await Promise.all(
    listModels().map(async (model) => [model, await assessRisk(supabase, patientProfileId, model)] as const),
  );
  return Object.fromEntries(entries) as Record<RiskModel, RiskAssessment>;
}

/**
 * Stores an assessment.
 *
 * The explanation is written alongside the score rather than recomputed on
 * read. A later model version would produce different contributions, and a
 * patient looking back at an old assessment must see what they were actually
 * shown — not a reconstruction from a model that did not exist yet.
 */
export async function persistPrediction(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
  assessment: RiskAssessment,
): Promise<void> {
  const { prediction, explanation } = assessment;

  const { error } = await supabase.from("health_predictions").insert({
    patient_id: patientProfileId,
    prediction_type: prediction.model === "diabetes" ? "DIABETES" : "CARDIOVASCULAR",
    risk_score: Number(prediction.riskScore.toFixed(4)),
    risk_category: prediction.category,
    model_version: prediction.modelVersion,
    confidence_score: Number(prediction.confidence.toFixed(3)),
    explanation: {
      narrative: explanation.narrative,
      awareness: explanation.awareness,
      generatedBy: explanation.model,
      inputs: prediction.inputs,
      contributions: prediction.contributions,
      baseValue: prediction.baseValue,
      logit: prediction.logit,
      confidenceReason: prediction.confidenceReason,
      dataset: assessment.dataset,
      metrics: assessment.metrics,
    },
  });

  if (error) throw new Error(`Could not store the risk assessment: ${error.message}`);
}

export type StoredPrediction = {
  id: string;
  predictionType: string;
  riskScore: number;
  riskCategory: string;
  modelVersion: string;
  confidenceScore: number | null;
  createdAt: string;
};

/** A patient's assessment history, newest first. */
export async function listPredictions(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
  limit = 20,
): Promise<StoredPrediction[]> {
  const { data, error } = await supabase
    .from("health_predictions")
    .select("id, prediction_type, risk_score, risk_category, model_version, confidence_score, created_at")
    .eq("patient_id", patientProfileId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Could not read your assessment history: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    predictionType: row.prediction_type,
    riskScore: Number(row.risk_score),
    riskCategory: row.risk_category,
    modelVersion: row.model_version,
    confidenceScore: row.confidence_score === null ? null : Number(row.confidence_score),
    createdAt: row.created_at,
  }));
}

async function fetchConfirmedRecords(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
): Promise<ConfirmedRecordRow[]> {
  const { data, error } = await supabase
    .from("patient_medical_records")
    // One literal string: Supabase infers the row type from the select text,
    // and concatenation collapses it to `string`.
    .select(
      "id, record_type, condition, medication, allergy, test_name, test_value, test_unit, reference_range, record_date, confidence_score, source_document_id, created_at",
    )
    .eq("patient_id", patientProfileId)
    .order("record_date", { ascending: false, nullsFirst: false });

  if (error) throw new Error(`Could not read your medical records: ${error.message}`);
  return (data ?? []) as ConfirmedRecordRow[];
}

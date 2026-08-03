import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { calculateAge } from "@/lib/utils/format";
import { bloodGroupLabel, genderLabel } from "@/lib/utils/constants";
import {
  deriveTimelineEvents,
  deriveConditions,
  deriveMedicationHistory,
} from "./timeline-service";
import { generateInsights } from "./insight-service";
import { computeHealthOverview } from "./overview-service";
import { assembleTwin } from "./assemble";
import type { ConfirmedRecordRow, DigitalTwin, DocumentRow, ProfileSnapshot } from "./types";

/**
 * Digital twin orchestrator.
 *
 * Reads everything the patient has confirmed and hands it to the pure engines
 * that derive the twin. All queries run through the caller's RLS-scoped client,
 * so a patient's twin can only ever be built from their own data.
 *
 * Nothing here computes: the engines in timeline-service, insight-service and
 * overview-service do that, and they are all pure and unit-tested.
 */

export async function buildDigitalTwin(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
): Promise<DigitalTwin> {
  const [profileResult, healthResult, recordsResult, documentsResult] = await Promise.all([
    supabase
      .from("patient_profiles")
      .select("date_of_birth, gender, blood_group, emergency_contact, user_id")
      .eq("id", patientProfileId)
      .maybeSingle(),
    supabase
      .from("patient_health_information")
      .select("allergies, existing_conditions, current_medications")
      .eq("patient_id", patientProfileId)
      .maybeSingle(),
    supabase
      .from("patient_medical_records")
      .select(
        "id, record_type, condition, medication, allergy, test_name, test_value, test_unit, reference_range, record_date, confidence_score, source_document_id, created_at",
      )
      .eq("patient_id", patientProfileId),
    supabase
      .from("medical_documents")
      .select("id, file_name, document_type, upload_status, uploaded_at")
      .eq("patient_id", patientProfileId)
      .order("uploaded_at", { ascending: false }),
  ]);

  let fullName: string | null = null;
  if (profileResult.data?.user_id) {
    const { data: user } = await supabase
      .from("users")
      .select("full_name")
      .eq("id", profileResult.data.user_id)
      .maybeSingle();
    fullName = user?.full_name ?? null;
  }

  const profile: ProfileSnapshot = {
    fullName,
    dateOfBirth: profileResult.data?.date_of_birth ?? null,
    gender: profileResult.data?.gender ? genderLabel(profileResult.data.gender) : null,
    bloodGroup: profileResult.data?.blood_group
      ? bloodGroupLabel(profileResult.data.blood_group)
      : null,
    allergies: healthResult.data?.allergies ?? [],
    conditions: healthResult.data?.existing_conditions ?? [],
    medications: healthResult.data?.current_medications ?? [],
    emergencyContact: profileResult.data?.emergency_contact ?? null,
  };

  return assembleTwin({
    profile,
    age: profile.dateOfBirth ? calculateAge(profile.dateOfBirth) : null,
    records: (recordsResult.data ?? []) as ConfirmedRecordRow[],
    documents: (documentsResult.data ?? []) as DocumentRow[],
  });
}

/**
 * Persists the derived twin so the timeline, conditions, medication history and
 * insights are queryable rather than recomputed on every page view.
 *
 * Derived rows are replaced wholesale; anything the patient authored by hand
 * (`derived = false`) is left alone.
 */
export async function persistDigitalTwin(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
  twin: DigitalTwin,
): Promise<{ ok: boolean; error: string | null }> {
  try {
    // Timeline — replace derived events only.
    await supabase
      .from("patient_health_timeline")
      .delete()
      .eq("patient_id", patientProfileId)
      .eq("derived", true);

    if (twin.timeline.length > 0) {
      await supabase.from("patient_health_timeline").insert(
        twin.timeline.map((event) => ({
          patient_id: patientProfileId,
          event_type: event.eventType,
          event_title: event.eventTitle,
          description: event.description,
          event_date: event.eventDate,
          source_document_id: event.sourceDocumentId,
          derived: true,
        })),
      );
    }

    // Conditions — upsert on the unique (patient, name) pair so a re-run
    // updates rather than duplicating.
    if (twin.conditions.length > 0) {
      await supabase.from("health_conditions").upsert(
        twin.conditions.map((condition) => ({
          patient_id: patientProfileId,
          condition_name: condition.conditionName,
          first_detected: condition.firstDetected,
          severity: condition.severity,
          current_status: condition.currentStatus,
          confidence_score: condition.confidenceScore,
        })),
        { onConflict: "patient_id,condition_name" },
      );
    }

    // Medication history — fully derived, so replace.
    await supabase.from("medication_history").delete().eq("patient_id", patientProfileId);
    if (twin.medications.length > 0) {
      await supabase.from("medication_history").insert(
        twin.medications.map((medication) => ({
          patient_id: patientProfileId,
          medicine_name: medication.medicineName,
          dosage: medication.dosage,
          frequency: medication.frequency,
          start_date: medication.startDate,
          end_date: medication.endDate,
          source_document_id: medication.sourceDocumentId,
        })),
      );
    }

    // Insights are a snapshot of the record as it stands; regenerate.
    await supabase.from("health_insights").delete().eq("patient_id", patientProfileId);
    if (twin.insights.length > 0) {
      await supabase.from("health_insights").insert(
        twin.insights.map((insight) => ({
          patient_id: patientProfileId,
          insight_type: insight.insightType,
          insight_text: insight.insightText,
          importance_level: insight.importanceLevel,
          evidence: insight.evidence,
          confidence_score: insight.confidenceScore,
        })),
      );
    }

    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not save your health twin.",
    };
  }
}

/** Build and persist in one step, after a document is confirmed. */
export async function refreshDigitalTwin(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
): Promise<DigitalTwin> {
  const twin = await buildDigitalTwin(supabase, patientProfileId);
  await persistDigitalTwin(supabase, patientProfileId, twin);
  return twin;
}

export { deriveTimelineEvents, deriveConditions, deriveMedicationHistory, generateInsights, computeHealthOverview };

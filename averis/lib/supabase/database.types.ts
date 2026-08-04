/**
 * Database types for the AVERIS schema.
 *
 * Mirrors supabase/migrations/*_averis_core_schema.sql. Regenerate with:
 *   npm run types:gen        (requires a running local Supabase stack)
 */

export type UserRole = "PATIENT" | "DOCTOR" | "HOSPITAL_ADMIN";

export type GenderIdentity = "FEMALE" | "MALE" | "OTHER" | "PREFER_NOT_TO_SAY";

export type BloodGroup =
  | "A_POSITIVE"
  | "A_NEGATIVE"
  | "B_POSITIVE"
  | "B_NEGATIVE"
  | "AB_POSITIVE"
  | "AB_NEGATIVE"
  | "O_POSITIVE"
  | "O_NEGATIVE"
  | "UNKNOWN";

/* ------------------------------------------------- Phase 2: documents */

export type DocumentType =
  | "BLOOD_REPORT"
  | "LAB_RESULT"
  | "HEALTH_CHECKUP"
  | "PRESCRIPTION"
  | "DISCHARGE_SUMMARY"
  | "DIAGNOSIS_REPORT"
  | "CONSULTATION_NOTE"
  | "OTHER";

export type UploadStatus =
  | "PENDING"
  | "PROCESSING"
  | "PENDING_REVIEW"
  | "COMPLETED"
  | "FAILED";

export type MedicalRecordType = "CONDITION" | "MEDICATION" | "ALLERGY" | "LAB_RESULT";

/* --------------------------------------------- Phase 3: the digital twin */

export type HealthEventType =
  | "DIAGNOSIS"
  | "MEDICATION_STARTED"
  | "MEDICATION_CHANGED"
  | "MEDICATION_STOPPED"
  | "LAB_RESULT"
  | "DOCUMENT_ADDED"
  | "ALLERGY_RECORDED"
  | "OTHER";

export type ConditionStatus = "ACTIVE" | "RESOLVED" | "UNCONFIRMED";

export type ConditionSeverity = "UNKNOWN" | "MILD" | "MODERATE" | "SIGNIFICANT";

export type InsightType = "TREND" | "PATTERN" | "COMPLETENESS" | "REMINDER";

export type ImportanceLevel = "LOW" | "MEDIUM" | "HIGH";

/* ------------------------------------- Phase 4: ML risk intelligence */

export type PredictionType = "DIABETES" | "CARDIOVASCULAR";

export type RiskCategoryEnum = "LOW" | "MODERATE" | "HIGH";

export type Database = {
  public: {
    Tables: {
      users: {
        Row: {
          id: string;
          auth_user_id: string;
          email: string;
          full_name: string | null;
          profile_image: string | null;
          role: UserRole;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          auth_user_id: string;
          email: string;
          full_name?: string | null;
          profile_image?: string | null;
          role?: UserRole;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          auth_user_id?: string;
          email?: string;
          full_name?: string | null;
          profile_image?: string | null;
          role?: UserRole;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      patient_profiles: {
        Row: {
          id: string;
          user_id: string;
          date_of_birth: string;
          gender: GenderIdentity;
          phone_number: string;
          blood_group: BloodGroup;
          emergency_contact: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          date_of_birth: string;
          gender: GenderIdentity;
          phone_number: string;
          blood_group?: BloodGroup;
          emergency_contact?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          date_of_birth?: string;
          gender?: GenderIdentity;
          phone_number?: string;
          blood_group?: BloodGroup;
          emergency_contact?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      patient_health_information: {
        Row: {
          id: string;
          patient_id: string;
          allergies: string[];
          existing_conditions: string[];
          current_medications: string[];
          medical_notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          patient_id: string;
          allergies?: string[];
          existing_conditions?: string[];
          current_medications?: string[];
          medical_notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          patient_id?: string;
          allergies?: string[];
          existing_conditions?: string[];
          current_medications?: string[];
          medical_notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      medical_documents: {
        Row: {
          id: string;
          patient_id: string;
          file_name: string;
          file_path: string;
          mime_type: string;
          file_size: number;
          document_type: DocumentType;
          upload_status: UploadStatus;
          error_message: string | null;
          uploaded_at: string;
          processed_at: string | null;
        };
        Insert: {
          id?: string;
          patient_id: string;
          file_name: string;
          file_path: string;
          mime_type: string;
          file_size: number;
          document_type?: DocumentType;
          upload_status?: UploadStatus;
          error_message?: string | null;
          uploaded_at?: string;
          processed_at?: string | null;
        };
        Update: {
          document_type?: DocumentType;
          upload_status?: UploadStatus;
          error_message?: string | null;
          processed_at?: string | null;
        };
        Relationships: [];
      };
      document_extractions: {
        Row: {
          id: string;
          document_id: string;
          extracted_text: string | null;
          extracted_data: unknown;
          confidence_score: number | null;
          extraction_model: string | null;
          text_source: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          document_id: string;
          extracted_text?: string | null;
          extracted_data?: unknown;
          confidence_score?: number | null;
          extraction_model?: string | null;
          text_source?: string | null;
          created_at?: string;
        };
        Update: {
          extracted_text?: string | null;
          extracted_data?: unknown;
          confidence_score?: number | null;
          extraction_model?: string | null;
          text_source?: string | null;
        };
        Relationships: [];
      };
      patient_medical_records: {
        Row: {
          id: string;
          patient_id: string;
          record_type: MedicalRecordType;
          condition: string | null;
          medication: string | null;
          allergy: string | null;
          test_name: string | null;
          test_value: string | null;
          test_unit: string | null;
          reference_range: string | null;
          record_date: string | null;
          confidence_score: number | null;
          source_document_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          patient_id: string;
          record_type: MedicalRecordType;
          condition?: string | null;
          medication?: string | null;
          allergy?: string | null;
          test_name?: string | null;
          test_value?: string | null;
          test_unit?: string | null;
          reference_range?: string | null;
          record_date?: string | null;
          confidence_score?: number | null;
          source_document_id?: string | null;
          created_at?: string;
        };
        Update: {
          condition?: string | null;
          medication?: string | null;
          allergy?: string | null;
          test_value?: string | null;
        };
        Relationships: [];
      };

      patient_health_timeline: {
        Row: {
          id: string;
          patient_id: string;
          event_type: HealthEventType;
          event_title: string;
          description: string | null;
          event_date: string;
          source_document_id: string | null;
          derived: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          patient_id: string;
          event_type: HealthEventType;
          event_title: string;
          description?: string | null;
          event_date: string;
          source_document_id?: string | null;
          derived?: boolean;
          created_at?: string;
        };
        Update: {
          event_title?: string;
          description?: string | null;
          event_date?: string;
        };
        Relationships: [];
      };

      health_conditions: {
        Row: {
          id: string;
          patient_id: string;
          condition_name: string;
          first_detected: string | null;
          severity: ConditionSeverity;
          current_status: ConditionStatus;
          confidence_score: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          patient_id: string;
          condition_name: string;
          first_detected?: string | null;
          severity?: ConditionSeverity;
          current_status?: ConditionStatus;
          confidence_score?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          first_detected?: string | null;
          severity?: ConditionSeverity;
          current_status?: ConditionStatus;
          confidence_score?: number | null;
        };
        Relationships: [];
      };

      medication_history: {
        Row: {
          id: string;
          patient_id: string;
          medicine_name: string;
          dosage: string | null;
          frequency: string | null;
          start_date: string | null;
          end_date: string | null;
          source_document_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          patient_id: string;
          medicine_name: string;
          dosage?: string | null;
          frequency?: string | null;
          start_date?: string | null;
          end_date?: string | null;
          source_document_id?: string | null;
          created_at?: string;
        };
        Update: {
          dosage?: string | null;
          frequency?: string | null;
          end_date?: string | null;
        };
        Relationships: [];
      };

      health_predictions: {
        Row: {
          id: string;
          patient_id: string;
          prediction_type: PredictionType;
          risk_score: number;
          risk_category: RiskCategoryEnum;
          model_version: string;
          explanation: unknown;
          confidence_score: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          patient_id: string;
          prediction_type: PredictionType;
          risk_score: number;
          risk_category: RiskCategoryEnum;
          model_version: string;
          explanation?: unknown;
          confidence_score?: number | null;
          created_at?: string;
        };
        // No Update shape: a prediction records what a model produced at a
        // point in time, and there is no UPDATE policy for it either.
        Update: Record<never, never>;
        Relationships: [];
      };

      model_metrics: {
        Row: {
          id: string;
          model_name: string;
          model_version: string;
          algorithm: string;
          dataset: string;
          accuracy: number | null;
          precision: number | null;
          recall: number | null;
          f1_score: number | null;
          roc_auc: number | null;
          is_serving: boolean;
          created_at: string;
        };
        // Written by the training pipeline through the SQL editor, never by
        // the application — no client role is granted insert.
        Insert: Record<never, never>;
        Update: Record<never, never>;
        Relationships: [];
      };

      health_insights: {
        Row: {
          id: string;
          patient_id: string;
          insight_type: InsightType;
          insight_text: string;
          importance_level: ImportanceLevel;
          evidence: unknown;
          confidence_score: number | null;
          generated_at: string;
        };
        Insert: {
          id?: string;
          patient_id: string;
          insight_type: InsightType;
          insight_text: string;
          importance_level?: ImportanceLevel;
          evidence?: unknown;
          confidence_score?: number | null;
          generated_at?: string;
        };
        Update: {
          insight_text?: string;
          importance_level?: ImportanceLevel;
        };
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: {
      user_role: UserRole;
      gender_identity: GenderIdentity;
      blood_group: BloodGroup;
      document_type: DocumentType;
      upload_status: UploadStatus;
      medical_record_type: MedicalRecordType;
      health_event_type: HealthEventType;
      condition_status: ConditionStatus;
      condition_severity: ConditionSeverity;
      insight_type: InsightType;
      importance_level: ImportanceLevel;
      prediction_type: PredictionType;
      risk_category: RiskCategoryEnum;
    };
    CompositeTypes: Record<never, never>;
  };
};

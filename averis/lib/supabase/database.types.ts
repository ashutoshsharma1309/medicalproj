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
    };
    CompositeTypes: Record<never, never>;
  };
};

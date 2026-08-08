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

export type PredictionType = "DIABETES" | "CARDIOVASCULAR" | "VITAL_DETERIORATION";

export type RiskCategoryEnum = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

/* ---------------------------- Phase 5: knowledge intelligence (RAG) */

export type KnowledgeSourceType = "PATIENT_DOCUMENT" | "MEDICAL_KNOWLEDGE";

/* ------------------------------------------- Care team (IoT Phase 4) */

export type AssignmentStatus = "ACTIVE" | "PENDING" | "REVOKED";
export type CaregiverPermission = "VIEW_ALERTS" | "VIEW_VITALS" | "FULL";
export type EmergencyType =
  | "FALL_DETECTED"
  | "SEVERE_HYPOXIA"
  | "EXTREME_HEART_RATE"
  | "RAPID_DETERIORATION"
  | "DEVICE_LOST"
  | "MANUAL_ESCALATION";
export type EmergencyStatus =
  | "NEW"
  | "ACKNOWLEDGED"
  | "IN_PROGRESS"
  | "RESOLVED"
  | "DISMISSED";
export type DetectedBy = "RULE_ENGINE" | "AI_ENGINE" | "PATIENT" | "CLINICIAN";

export type InsightKindEnum =
  | "TREND_DECLINE"
  | "TREND_RISE"
  | "ANOMALY"
  | "PATTERN_CORRELATION"
  | "STABILITY"
  | "DATA_GAP";

/* ------------------------------------------------ IoT monitoring (Phase 1) */

export type DeviceTypeEnum =
  | "WEARABLE_BAND"
  | "PULSE_OXIMETER"
  | "SMART_WATCH"
  | "CHEST_STRAP"
  | "OTHER";

export type ConnectionStatusEnum = "ONLINE" | "OFFLINE" | "PROVISIONED" | "RETIRED";

export type MovementStatusEnum =
  | "RESTING"
  | "NORMAL"
  | "ACTIVE"
  | "FALL_SUSPECTED"
  | "UNKNOWN";

export type AlertTypeEnum =
  | "HEART_RATE_HIGH"
  | "HEART_RATE_LOW"
  | "SPO2_LOW"
  | "TEMPERATURE_HIGH"
  | "TEMPERATURE_LOW"
  | "FALL_SUSPECTED"
  | "DEVICE_OFFLINE"
  | "BATTERY_LOW";

export type AlertSeverityEnum = "INFO" | "WARNING" | "CRITICAL";

export type AlertStateEnum = "ACTIVE" | "ACKNOWLEDGED" | "RESOLVED";

export type KnowledgeCategoryEnum =
  | "LAB_REFERENCE"
  | "CONDITION"
  | "MEDICATION"
  | "PROCEDURE"
  | "GENERAL_HEALTH";

/* --------------------------- Phase 6: production foundation */

export type AuditAction =
  | "DOCUMENT_UPLOADED"
  | "DOCUMENT_VIEWED"
  | "DOCUMENT_DELETED"
  | "EXTRACTION_CONFIRMED"
  | "PROFILE_UPDATED"
  | "HEALTH_SUMMARY_VIEWED"
  | "RISK_PREDICTION_GENERATED"
  | "AI_QUESTION_ASKED"
  | "REPORT_EXPLAINED"
  | "EMERGENCY_ACKNOWLEDGED"
  | "EMERGENCY_RESOLVED"
  | "CARE_TEAM_UPDATED"
  | "HEALTH_REPORT_GENERATED"
  | "SIGNED_IN"
  | "SIGNED_OUT";

export type AuditResource =
  | "DOCUMENT" | "PROFILE" | "PREDICTION" | "CONVERSATION" | "TWIN" | "SESSION"
  | "EMERGENCY" | "REPORT";

export type DeviceEventKind =
  | "BOOT"
  | "SENSOR_FAULT"
  | "SENSOR_RECOVERED"
  | "AUTH_REJECTED"
  | "BUFFER_OVERFLOW"
  | "LOW_BATTERY"
  | "FIRMWARE_CHANGED"
  | "WENT_OFFLINE"
  | "CAME_ONLINE";

export type NotificationKind =
  | "DOCUMENT_PROCESSED" | "DOCUMENT_FAILED" | "INSIGHT_GENERATED" | "PROFILE_UPDATED";

export type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DEAD";

export type SubscriptionPlan = "FREE" | "PREMIUM";

export type SubscriptionState = "ACTIVE" | "PAST_DUE" | "CANCELLED";

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

      audit_logs: {
        Row: {
          id: string;
          user_id: string;
          action: AuditAction;
          resource_type: AuditResource;
          resource_id: string | null;
          metadata: unknown;
          ip_address: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          action: AuditAction;
          resource_type: AuditResource;
          resource_id?: string | null;
          metadata?: unknown;
          ip_address?: string | null;
          created_at?: string;
        };
        // Append-only: no UPDATE or DELETE policy exists, and the type says so.
        Update: Record<never, never>;
        Relationships: [];
      };

      notifications: {
        Row: {
          id: string;
          patient_id: string;
          kind: NotificationKind;
          title: string;
          body: string;
          href: string | null;
          read_at: string | null;
          created_at: string;
        };
        // System-written. No client role is granted insert.
        Insert: Record<never, never>;
        // Dismissal is the one field a patient may change.
        Update: { read_at?: string | null };
        Relationships: [];
      };

      processing_jobs: {
        Row: {
          id: string;
          patient_id: string;
          document_id: string;
          status: JobStatus;
          attempts: number;
          max_attempts: number;
          run_after: string;
          last_error: string | null;
          claimed_at: string | null;
          completed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          patient_id: string;
          document_id: string;
          status?: JobStatus;
          run_after?: string;
        };
        // Status transitions belong to the worker, which connects with
        // elevated credentials rather than as a client role.
        Update: {
          status?: JobStatus;
          run_after?: string;
          last_error?: string | null;
          completed_at?: string | null;
        };
        Relationships: [];
      };

      subscriptions: {
        Row: {
          id: string;
          user_id: string;
          plan: SubscriptionPlan;
          subscription_status: SubscriptionState;
          current_period_end: string | null;
          created_at: string;
          updated_at: string;
        };
        // Plan changes come from billing, which does not run as the user.
        Insert: Record<never, never>;
        Update: Record<never, never>;
        Relationships: [];
      };

      doctors: {
        Row: {
          id: string;
          user_id: string;
          full_name: string;
          specialization: string | null;
          hospital_name: string | null;
          license_number: string;
          verified_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          full_name: string;
          specialization?: string | null;
          hospital_name?: string | null;
          license_number: string;
        };
        Update: {
          full_name?: string;
          specialization?: string | null;
          hospital_name?: string | null;
        };
        Relationships: [];
      };

      patient_doctor_assignments: {
        Row: {
          id: string;
          patient_id: string;
          doctor_id: string;
          status: AssignmentStatus;
          assigned_at: string;
          revoked_at: string | null;
          assigned_by: string | null;
          note: string | null;
        };
        Insert: {
          id?: string;
          patient_id: string;
          doctor_id: string;
          status?: AssignmentStatus;
          assigned_by?: string | null;
          note?: string | null;
        };
        Update: {
          status?: AssignmentStatus;
          revoked_at?: string | null;
          note?: string | null;
        };
        Relationships: [];
      };

      patient_caregiver_assignments: {
        Row: {
          id: string;
          patient_id: string;
          caregiver_id: string;
          relationship: string | null;
          permission_level: CaregiverPermission;
          status: AssignmentStatus;
          assigned_at: string;
          revoked_at: string | null;
        };
        Insert: {
          id?: string;
          patient_id: string;
          caregiver_id: string;
          relationship?: string | null;
          permission_level?: CaregiverPermission;
          status?: AssignmentStatus;
        };
        Update: {
          permission_level?: CaregiverPermission;
          status?: AssignmentStatus;
          revoked_at?: string | null;
        };
        Relationships: [];
      };

      emergency_events: {
        Row: {
          id: string;
          patient_id: string;
          device_id: string | null;
          alert_id: string | null;
          event_type: EmergencyType;
          severity: AlertSeverityEnum;
          detected_by: DetectedBy;
          status: EmergencyStatus;
          summary: string;
          evidence: unknown;
          acknowledged_by: string | null;
          acknowledged_at: string | null;
          resolved_by: string | null;
          resolved_at: string | null;
          resolution_note: string | null;
          created_at: string;
        };
        // Raised by the engine, which runs as the service role. A user who
        // could insert one could also raise a false emergency.
        Insert: Record<never, never>;
        Update: {
          status?: EmergencyStatus;
          acknowledged_by?: string | null;
          acknowledged_at?: string | null;
          resolved_by?: string | null;
          resolved_at?: string | null;
          resolution_note?: string | null;
        };
        Relationships: [];
      };

      device_events: {
        Row: {
          id: number;
          device_id: string;
          patient_id: string;
          kind: DeviceEventKind;
          detail: string | null;
          metadata: unknown;
          created_at: string;
        };
        // Written by the ingest service. A browser that could insert here
        // could fabricate a band's history.
        Insert: Record<never, never>;
        Update: Record<never, never>;
        Relationships: [];
      };

      care_notifications: {
        Row: {
          id: string;
          recipient_id: string;
          patient_id: string;
          emergency_id: string | null;
          severity: AlertSeverityEnum;
          title: string;
          body: string;
          href: string | null;
          read_at: string | null;
          created_at: string;
        };
        // Written inside private.raise_emergency(), which runs as the service
        // role. A browser that could insert here could tell a doctor a patient
        // had collapsed.
        Insert: Record<never, never>;
        // Dismissal, and nothing else.
        Update: { read_at?: string | null };
        Relationships: [];
      };

      patient_health_reports: {
        Row: {
          id: string;
          patient_id: string;
          generated_by: string | null;
          period_start: string;
          period_end: string;
          summary: string;
          sections: unknown;
          generated_with: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          patient_id: string;
          generated_by: string;
          period_start: string;
          period_end: string;
          summary: string;
          sections?: unknown;
          generated_with?: string;
        };
        // A report is what a clinician read at a moment in time. Editing one
        // afterwards would make the record of that moment untrue.
        Update: Record<never, never>;
        Relationships: [];
      };

      ai_insights: {
        Row: {
          id: string;
          patient_id: string;
          device_id: string | null;
          insight_type: InsightKindEnum;
          message: string;
          severity: AlertSeverityEnum;
          evidence: unknown;
          confidence: number | null;
          window_start: string | null;
          window_end: string | null;
          created_at: string;
        };
        // Generated by the intelligence engine, which runs as the service
        // role. No client role may write, so there is nothing to type here.
        Insert: Record<never, never>;
        Update: Record<never, never>;
        Relationships: [];
      };

      iot_devices: {
        Row: {
          id: string;
          patient_id: string;
          device_key: string;
          device_name: string;
          device_type: DeviceTypeEnum;
          // token_hash is deliberately absent: the column grant is revoked
          // from `authenticated`, so selecting it fails rather than leaks.
          token_issued_at: string;
          connection_status: ConnectionStatusEnum;
          battery_percentage: number | null;
          firmware_version: string | null;
          last_connected_at: string | null;
          last_reading_at: string | null;
          // Phase 5 hardware telemetry.
          is_simulated: boolean;
          signal_strength_dbm: number | null;
          uptime_seconds: number | null;
          boot_count: number | null;
          hardware_revision: string | null;
          transport: string | null;
          sensor_health: unknown;
          last_latency_ms: number | null;
          buffered_readings: number | null;
          last_boot_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          patient_id: string;
          device_key: string;
          device_name: string;
          device_type?: DeviceTypeEnum;
          token_hash: string;
          token_issued_at?: string;
          connection_status?: ConnectionStatusEnum;
          battery_percentage?: number | null;
          firmware_version?: string | null;
          is_simulated?: boolean;
        };
        Update: {
          device_name?: string;
          device_type?: DeviceTypeEnum;
          token_hash?: string;
          token_issued_at?: string;
          connection_status?: ConnectionStatusEnum;
          battery_percentage?: number | null;
          firmware_version?: string | null;
          // Telemetry is written by the ingest service; a patient may still
          // reclassify their own device as simulated, which is the one
          // hardware field a client has any business setting.
          is_simulated?: boolean;
        };
        Relationships: [];
      };

      sensor_readings: {
        Row: {
          id: number;
          device_id: string;
          patient_id: string;
          heart_rate: number | null;
          spo2: number | null;
          temperature: number | null;
          movement_status: MovementStatusEnum;
          battery_percentage: number | null;
          // Fixed at write time: a chart drawn today must not change meaning
          // because a device was reclassified later.
          is_simulated: boolean;
          recorded_at: string;
          received_at: string;
        };
        // Append-only, and no client role may write. Ingestion runs as the
        // service role inside the IoT service.
        Insert: Record<never, never>;
        Update: Record<never, never>;
        Relationships: [];
      };

      alerts: {
        Row: {
          id: string;
          patient_id: string;
          device_id: string | null;
          reading_id: number | null;
          alert_type: AlertTypeEnum;
          severity: AlertSeverityEnum;
          message: string;
          observed_value: number | null;
          threshold_value: number | null;
          status: AlertStateEnum;
          acknowledged_at: string | null;
          created_at: string;
        };
        // Raised by the system; a patient may only acknowledge.
        Insert: Record<never, never>;
        Update: {
          status?: AlertStateEnum;
          acknowledged_at?: string | null;
        };
        Relationships: [];
      };

      knowledge_documents: {
        Row: {
          id: string;
          title: string;
          category: KnowledgeCategoryEnum;
          source_type: KnowledgeSourceType;
          body: string;
          citation: string;
          created_at: string;
        };
        // Reference material, seeded through the SQL editor. No client role is
        // granted insert, so there is nothing for the app to write.
        Insert: Record<never, never>;
        Update: Record<never, never>;
        Relationships: [];
      };

      knowledge_embeddings: {
        Row: {
          id: string;
          source_type: KnowledgeSourceType;
          patient_id: string | null;
          document_id: string | null;
          knowledge_document_id: string | null;
          chunk_index: number;
          content: string;
          // pgvector accepts and returns its text form over PostgREST.
          embedding: string;
          metadata: unknown;
          created_at: string;
        };
        Insert: {
          id?: string;
          source_type: KnowledgeSourceType;
          patient_id?: string | null;
          document_id?: string | null;
          knowledge_document_id?: string | null;
          chunk_index: number;
          content: string;
          embedding: string;
          metadata?: unknown;
          created_at?: string;
        };
        // No UPDATE policy: a chunk's text and its vector must agree, and
        // changing one without the other leaves the index quietly wrong.
        Update: Record<never, never>;
        Relationships: [];
      };

      ai_conversations: {
        Row: {
          id: string;
          patient_id: string;
          question: string;
          response: string;
          sources_used: unknown;
          created_at: string;
        };
        Insert: {
          id?: string;
          patient_id: string;
          question: string;
          response: string;
          sources_used?: unknown;
          created_at?: string;
        };
        Update: Record<never, never>;
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
    Functions: {
      claim_processing_job: {
        Args: { worker_batch?: number };
        Returns: {
          job_id: string;
          patient_id: string;
          document_id: string;
          attempts: number;
        }[];
      };
      match_knowledge: {
        Args: {
          query_embedding: string;
          match_count?: number;
          filter_source?: KnowledgeSourceType;
        };
        Returns: {
          id: string;
          source_type: KnowledgeSourceType;
          document_id: string | null;
          knowledge_document_id: string | null;
          chunk_index: number;
          content: string;
          metadata: unknown;
          similarity: number;
        }[];
      };
      find_doctor_by_license: {
        Args: { p_license: string };
        Returns: {
          id: string;
          full_name: string;
          specialization: string | null;
          hospital_name: string | null;
          verified: boolean;
        }[];
      };
      care_patient_directory: {
        Args: Record<never, never>;
        Returns: { patient_id: string; full_name: string | null }[];
      };
      invite_caregiver: {
        Args: {
          p_email: string;
          p_relationship: string | null;
          p_permission: CaregiverPermission;
        };
        // 'ASSIGNED' | 'NO_ACCOUNT' | 'SELF' | 'NO_PROFILE'
        Returns: string;
      };
    };
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
      knowledge_source_type: KnowledgeSourceType;
      knowledge_category: KnowledgeCategoryEnum;
      audit_action: AuditAction;
      audit_resource: AuditResource;
      notification_kind: NotificationKind;
      device_event_kind: DeviceEventKind;
      job_status: JobStatus;
      subscription_plan: SubscriptionPlan;
      subscription_state: SubscriptionState;
    };
    CompositeTypes: Record<never, never>;
  };
};

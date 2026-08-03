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
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: {
      user_role: UserRole;
      gender_identity: GenderIdentity;
      blood_group: BloodGroup;
    };
    CompositeTypes: Record<never, never>;
  };
};

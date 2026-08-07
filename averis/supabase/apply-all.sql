-- ===========================================================================
-- AVERIS — complete schema (Phases 1-6 + IoT Phase 1)
--
-- Paste into the Supabase SQL Editor and run once:
--   https://supabase.com/dashboard/project/<project-ref>/sql/new
--
-- 22 tables, 65 RLS policies, private helper functions, the
-- 'medical-documents' storage bucket, pgvector retrieval and the IoT device
-- registry.
--
-- Afterwards paste the generated seeds, in either order:
--   supabase/seed/model_metrics.sql
--   supabase/seed/knowledge_base.sql
--
-- Generated from supabase/migrations/ — do not edit by hand.
-- ===========================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 20260802165525_averis_core_schema.sql
-- ─────────────────────────────────────────────────────────────────────────
-- ===========================================================================
-- AVERIS — core schema (Phase 1: patient identity + health profile)
--
-- Security posture:
--   * Row Level Security on every table, deny-by-default.
--   * No privileges granted to `anon` — the entire data surface is
--     authenticated-only.
--   * Every policy pairs `TO authenticated` with an ownership predicate;
--     `TO authenticated` alone would be authentication without authorization.
--   * UPDATE policies carry both USING and WITH CHECK so a row's owner
--     cannot be reassigned.
--   * SECURITY DEFINER helpers live in the non-exposed `private` schema with
--     EXECUTE revoked from PUBLIC, so they are not callable API endpoints.
-- ===========================================================================

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------
-- Roles. Phase 1 issues PATIENT only; DOCTOR and HOSPITAL_ADMIN exist now so
-- future phases need no destructive migration.
-- ---------------------------------------------------------------------------
create type public.user_role as enum ('PATIENT', 'DOCTOR', 'HOSPITAL_ADMIN');

create type public.gender_identity as enum ('FEMALE', 'MALE', 'OTHER', 'PREFER_NOT_TO_SAY');

create type public.blood_group as enum (
  'A_POSITIVE', 'A_NEGATIVE',
  'B_POSITIVE', 'B_NEGATIVE',
  'AB_POSITIVE', 'AB_NEGATIVE',
  'O_POSITIVE', 'O_NEGATIVE',
  'UNKNOWN'
);

-- ---------------------------------------------------------------------------
-- users — application identity, 1:1 with auth.users
-- ---------------------------------------------------------------------------
create table public.users (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid not null unique references auth.users (id) on delete cascade,
  email         text not null,
  full_name     text,
  profile_image text,
  role          public.user_role not null default 'PATIENT',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.users is 'AVERIS application identity, one row per auth.users entry.';

create index users_auth_user_id_idx on public.users (auth_user_id);

-- ---------------------------------------------------------------------------
-- patient_profiles — demographics, 1:1 with users
-- ---------------------------------------------------------------------------
create table public.patient_profiles (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique references public.users (id) on delete cascade,
  date_of_birth     date not null,
  gender            public.gender_identity not null,
  phone_number      text not null,
  blood_group       public.blood_group not null default 'UNKNOWN',
  emergency_contact text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint patient_profiles_dob_is_past check (date_of_birth < current_date),
  constraint patient_profiles_dob_is_plausible check (date_of_birth > date '1900-01-01'),
  constraint patient_profiles_phone_length check (char_length(phone_number) between 7 and 24)
);

comment on table public.patient_profiles is 'Patient demographics. One profile per AVERIS user.';

create index patient_profiles_user_id_idx on public.patient_profiles (user_id);

-- ---------------------------------------------------------------------------
-- patient_health_information — clinical facts, 1:1 with patient_profiles
--
-- Lists are text[] in Phase 1 because they are patient-entered. They stay
-- queryable via the && overlap operator; Phase 2 promotes them to coded
-- clinical entities once AI extraction supplies structure.
-- ---------------------------------------------------------------------------
create table public.patient_health_information (
  id                  uuid primary key default gen_random_uuid(),
  patient_id          uuid not null unique references public.patient_profiles (id) on delete cascade,
  allergies           text[] not null default '{}',
  existing_conditions text[] not null default '{}',
  current_medications text[] not null default '{}',
  medical_notes       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.patient_health_information is 'Patient-reported health background.';

create index patient_health_information_patient_id_idx
  on public.patient_health_information (patient_id);

-- ---------------------------------------------------------------------------
-- Ownership helpers.
--
-- SECURITY DEFINER so RLS policies can resolve ownership without recursing
-- into another table's policies (and without a per-row subquery cost). They
-- derive identity from auth.uid() internally, take no arguments, live in the
-- non-exposed `private` schema, and are executable only by `authenticated`.
-- ---------------------------------------------------------------------------
create function private.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from public.users u where u.auth_user_id = (select auth.uid());
$$;

create function private.current_patient_profile_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.patient_profiles p
  join public.users u on u.id = p.user_id
  where u.auth_user_id = (select auth.uid());
$$;

revoke all on function private.current_app_user_id() from public;
revoke all on function private.current_patient_profile_id() from public;

-- RLS policy expressions are evaluated with the *querying* role's privileges,
-- so `authenticated` needs USAGE on the schema as well as EXECUTE on the
-- functions — without it every policy referencing them fails with
-- "permission denied for schema private".
--
-- This does not expose the schema through the Data API: PostgREST only serves
-- the schemas it is configured with (`public`). Both functions take no
-- arguments and resolve identity from auth.uid() internally, so a caller can
-- only ever learn their own ids.
grant usage on schema private to authenticated;
grant execute on function private.current_app_user_id() to authenticated;
grant execute on function private.current_patient_profile_id() to authenticated;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger users_set_updated_at
  before update on public.users
  for each row execute function private.set_updated_at();

create trigger patient_profiles_set_updated_at
  before update on public.patient_profiles
  for each row execute function private.set_updated_at();

create trigger patient_health_information_set_updated_at
  before update on public.patient_health_information
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Provision an AVERIS identity whenever a Supabase auth user is created.
-- Covers both email/password signup and Google OAuth with one code path.
--
-- Lives in `private` (not `public`) so it is not exposed as a callable
-- endpoint. Idempotent: a repeated auth event will not raise.
-- ---------------------------------------------------------------------------
create function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (auth_user_id, email, full_name, profile_image, role)
  values (
    new.id,
    new.email,
    nullif(trim(coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      ''
    )), ''),
    nullif(trim(coalesce(
      new.raw_user_meta_data ->> 'avatar_url',
      new.raw_user_meta_data ->> 'picture',
      ''
    )), ''),
    'PATIENT'
  )
  on conflict (auth_user_id) do nothing;

  return new;
end;
$$;

revoke all on function private.handle_new_auth_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.users                       enable row level security;
alter table public.patient_profiles            enable row level security;
alter table public.patient_health_information  enable row level security;

-- users -------------------------------------------------------------------
create policy "Users read own identity"
  on public.users for select
  to authenticated
  using ( (select auth.uid()) = auth_user_id );

create policy "Users update own identity"
  on public.users for update
  to authenticated
  using ( (select auth.uid()) = auth_user_id )
  with check ( (select auth.uid()) = auth_user_id );

-- Rows are created by the auth trigger. INSERT is additionally allowed for the
-- owner so a self-heal path exists if the trigger is ever bypassed.
create policy "Users insert own identity"
  on public.users for insert
  to authenticated
  with check ( (select auth.uid()) = auth_user_id );

-- patient_profiles ---------------------------------------------------------
create policy "Patients read own profile"
  on public.patient_profiles for select
  to authenticated
  using ( user_id = private.current_app_user_id() );

create policy "Patients create own profile"
  on public.patient_profiles for insert
  to authenticated
  with check ( user_id = private.current_app_user_id() );

create policy "Patients update own profile"
  on public.patient_profiles for update
  to authenticated
  using ( user_id = private.current_app_user_id() )
  with check ( user_id = private.current_app_user_id() );

-- patient_health_information ----------------------------------------------
create policy "Patients read own health information"
  on public.patient_health_information for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Patients create own health information"
  on public.patient_health_information for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients update own health information"
  on public.patient_health_information for update
  to authenticated
  using ( patient_id = private.current_patient_profile_id() )
  with check ( patient_id = private.current_patient_profile_id() );

-- ===========================================================================
-- Grants — authenticated only. `anon` receives nothing.
-- DELETE is intentionally withheld: Phase 1 has no account-deletion flow, and
-- health records should not be removable by an accidental client call.
-- ===========================================================================
grant usage on schema public to authenticated;

grant select, insert, update on public.users                      to authenticated;
grant select, insert, update on public.patient_profiles           to authenticated;
grant select, insert, update on public.patient_health_information to authenticated;

revoke all on public.users                      from anon;
revoke all on public.patient_profiles           from anon;
revoke all on public.patient_health_information from anon;

-- ─────────────────────────────────────────────────────────────────────────
-- 20260803141226_phase2_document_intelligence.sql
-- ─────────────────────────────────────────────────────────────────────────
-- ===========================================================================
-- AVERIS Phase 2 — Medical Document Intelligence
--
-- Adds the document pipeline (upload → extract → review → confirm) and the
-- structured clinical records that confirmed extractions produce.
--
-- Security posture is unchanged from Phase 1: RLS on every table, no `anon`
-- privileges, ownership predicates on every policy, USING + WITH CHECK on
-- updates, and ownership resolved through the non-exposed `private` schema.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.document_type as enum (
  'BLOOD_REPORT',
  'LAB_RESULT',
  'HEALTH_CHECKUP',
  'PRESCRIPTION',
  'DISCHARGE_SUMMARY',
  'DIAGNOSIS_REPORT',
  'CONSULTATION_NOTE',
  'OTHER'
);

create type public.upload_status as enum (
  'PENDING',        -- stored, not yet picked up
  'PROCESSING',     -- text extraction / AI extraction running
  'PENDING_REVIEW', -- extraction succeeded, awaiting patient verification
  'COMPLETED',      -- patient reviewed; confirmed items applied
  'FAILED'          -- pipeline error; error_message explains
);

create type public.medical_record_type as enum (
  'CONDITION',
  'MEDICATION',
  'ALLERGY',
  'LAB_RESULT'
);

-- ---------------------------------------------------------------------------
-- medical_documents — one row per uploaded file
-- ---------------------------------------------------------------------------
create table public.medical_documents (
  id             uuid primary key default gen_random_uuid(),
  patient_id     uuid not null references public.patient_profiles (id) on delete cascade,
  file_name      text not null,
  -- Storage object path, NOT a public URL. Access is always brokered through
  -- a short-lived signed URL so documents are never publicly addressable.
  file_path      text not null unique,
  mime_type      text not null,
  file_size      integer not null,
  document_type  public.document_type not null default 'OTHER',
  upload_status  public.upload_status not null default 'PENDING',
  error_message  text,
  uploaded_at    timestamptz not null default now(),
  processed_at   timestamptz,

  constraint medical_documents_file_size_positive
    check (file_size > 0 and file_size <= 15728640), -- 15 MB ceiling
  constraint medical_documents_mime_allowed
    check (mime_type in ('application/pdf', 'image/jpeg', 'image/png'))
);

comment on table public.medical_documents is
  'Patient-uploaded medical documents and their pipeline status.';

create index medical_documents_patient_idx
  on public.medical_documents (patient_id, uploaded_at desc);
create index medical_documents_status_idx
  on public.medical_documents (upload_status);

-- ---------------------------------------------------------------------------
-- document_extractions — pipeline output for a document
--
-- Both the raw text and the structured payload are kept: the text supports
-- future RAG/search, the JSON is what the review workflow reads.
-- ---------------------------------------------------------------------------
create table public.document_extractions (
  id               uuid primary key default gen_random_uuid(),
  document_id      uuid not null unique references public.medical_documents (id) on delete cascade,
  extracted_text   text,
  extracted_data   jsonb not null default '{}'::jsonb,
  confidence_score numeric(4,3),
  -- Provenance so a later model change is auditable.
  extraction_model text,
  text_source      text, -- 'pdf-text' | 'ocr-tesseract' | 'ocr-vision'
  created_at       timestamptz not null default now(),

  constraint document_extractions_confidence_range
    check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1))
);

comment on table public.document_extractions is
  'AI extraction output per document: raw text plus structured, confidence-scored data.';

create index document_extractions_document_idx
  on public.document_extractions (document_id);

-- ---------------------------------------------------------------------------
-- patient_medical_records — confirmed clinical facts
--
-- Shape follows the Phase 2 specification (condition / medication / allergy /
-- test columns on one table). `record_type` discriminates, and a CHECK
-- constraint guarantees exactly the right column is populated for each type —
-- so the sparse layout cannot drift into ambiguous rows.
--
-- Rows only ever appear here after a patient explicitly confirms them.
-- ---------------------------------------------------------------------------
create table public.patient_medical_records (
  id                 uuid primary key default gen_random_uuid(),
  patient_id         uuid not null references public.patient_profiles (id) on delete cascade,
  record_type        public.medical_record_type not null,

  condition          text,
  medication         text,
  allergy            text,
  test_name          text,
  test_value         text,
  test_unit          text,
  reference_range    text,

  record_date        date,
  confidence_score   numeric(4,3),
  source_document_id uuid references public.medical_documents (id) on delete set null,
  created_at         timestamptz not null default now(),

  constraint patient_medical_records_shape check (
    case record_type
      when 'CONDITION'  then condition  is not null and medication is null and allergy is null and test_name is null
      when 'MEDICATION' then medication is not null and condition  is null and allergy is null and test_name is null
      when 'ALLERGY'    then allergy    is not null and condition  is null and medication is null and test_name is null
      when 'LAB_RESULT' then test_name  is not null and condition  is null and medication is null and allergy is null
    end
  ),
  constraint patient_medical_records_confidence_range
    check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1))
);

comment on table public.patient_medical_records is
  'Structured clinical facts confirmed by the patient from an extracted document.';

create index patient_medical_records_patient_idx
  on public.patient_medical_records (patient_id, record_type);
create index patient_medical_records_source_idx
  on public.patient_medical_records (source_document_id);

-- ---------------------------------------------------------------------------
-- Documents transition status, so keep the processed timestamp honest.
-- ---------------------------------------------------------------------------
create function private.set_processed_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.upload_status in ('COMPLETED', 'FAILED')
     and old.upload_status is distinct from new.upload_status then
    new.processed_at := now();
  end if;
  return new;
end;
$$;

create trigger medical_documents_set_processed_at
  before update on public.medical_documents
  for each row execute function private.set_processed_at();

-- ---------------------------------------------------------------------------
-- Ownership helper for document-scoped rows.
-- ---------------------------------------------------------------------------
create function private.owns_document(target_document_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.medical_documents d
    join public.patient_profiles p on p.id = d.patient_id
    join public.users u on u.id = p.user_id
    where d.id = target_document_id
      and u.auth_user_id = (select auth.uid())
  );
$$;

revoke all on function private.owns_document(uuid) from public;
grant execute on function private.owns_document(uuid) to authenticated;

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.medical_documents        enable row level security;
alter table public.document_extractions     enable row level security;
alter table public.patient_medical_records  enable row level security;

-- medical_documents --------------------------------------------------------
create policy "Patients read own documents"
  on public.medical_documents for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Patients upload own documents"
  on public.medical_documents for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients update own documents"
  on public.medical_documents for update
  to authenticated
  using ( patient_id = private.current_patient_profile_id() )
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients delete own documents"
  on public.medical_documents for delete
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- document_extractions -----------------------------------------------------
create policy "Patients read own extractions"
  on public.document_extractions for select
  to authenticated
  using ( private.owns_document(document_id) );

create policy "Patients create own extractions"
  on public.document_extractions for insert
  to authenticated
  with check ( private.owns_document(document_id) );

create policy "Patients update own extractions"
  on public.document_extractions for update
  to authenticated
  using ( private.owns_document(document_id) )
  with check ( private.owns_document(document_id) );

-- patient_medical_records --------------------------------------------------
create policy "Patients read own medical records"
  on public.patient_medical_records for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Patients create own medical records"
  on public.patient_medical_records for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients update own medical records"
  on public.patient_medical_records for update
  to authenticated
  using ( patient_id = private.current_patient_profile_id() )
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients delete own medical records"
  on public.patient_medical_records for delete
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- ===========================================================================
-- Grants — authenticated only; `anon` receives nothing.
-- ===========================================================================
grant select, insert, update, delete on public.medical_documents       to authenticated;
grant select, insert, update         on public.document_extractions    to authenticated;
grant select, insert, update, delete on public.patient_medical_records to authenticated;

revoke all on public.medical_documents       from anon;
revoke all on public.document_extractions    from anon;
revoke all on public.patient_medical_records from anon;

-- ─────────────────────────────────────────────────────────────────────────
-- 20260803141620_phase2_document_storage.sql
-- ─────────────────────────────────────────────────────────────────────────
-- ===========================================================================
-- AVERIS Phase 2 — Supabase Storage for medical documents
--
-- Object layout:
--   patients/{patient_profile_id}/medical_documents/{uuid}.{ext}
--
-- The bucket is PRIVATE. Documents are never publicly addressable; the
-- application issues short-lived signed URLs on demand.
--
-- Storage policies mirror the table policies: a patient can only touch objects
-- under their own patient_profile folder, resolved through the same
-- non-exposed `private` helper used elsewhere. `anon` gets nothing.
--
-- NOTE: the local Postgres test harness has no `storage` schema, so this
-- migration is skipped there. It runs against any real Supabase project.
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'medical-documents',
  'medical-documents',
  false,
  15728640, -- 15 MB, matches the medical_documents CHECK constraint
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Does the given storage object path belong to the caller?
--
-- Path segment 1 is the literal 'patients', segment 2 is the patient profile
-- id. storage.foldername() returns the directory segments of the object name.
-- ---------------------------------------------------------------------------
create function private.owns_storage_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (storage.foldername(object_name))[1] = 'patients'
    and (storage.foldername(object_name))[2] = private.current_patient_profile_id()::text;
$$;

revoke all on function private.owns_storage_object(text) from public;
grant execute on function private.owns_storage_object(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Object policies
--
-- Upsert (replacing a file) requires INSERT + SELECT + UPDATE together, so all
-- three are granted for the owner's own folder. DELETE lets a patient remove a
-- document they uploaded by mistake.
-- ---------------------------------------------------------------------------
create policy "Patients read own medical documents"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'medical-documents'
    and private.owns_storage_object(name)
  );

create policy "Patients upload own medical documents"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'medical-documents'
    and private.owns_storage_object(name)
  );

create policy "Patients update own medical documents"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'medical-documents'
    and private.owns_storage_object(name)
  )
  with check (
    bucket_id = 'medical-documents'
    and private.owns_storage_object(name)
  );

create policy "Patients delete own medical documents"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'medical-documents'
    and private.owns_storage_object(name)
  );

-- ─────────────────────────────────────────────────────────────────────────
-- 20260803180623_phase3_digital_twin.sql
-- ─────────────────────────────────────────────────────────────────────────
-- ===========================================================================
-- AVERIS Phase 3 — Patient Digital Twin & Health Intelligence
--
-- Adds the longitudinal layer: a timeline of health events, tracked conditions,
-- medication history over time, and generated insights.
--
-- Everything here is derived from data the patient already confirmed in Phase 2.
-- Nothing is inferred behind their back, and every derived row keeps a pointer
-- back to the document it came from.
--
-- Security posture unchanged: RLS on every table, no `anon` privileges,
-- ownership predicates on every policy, USING + WITH CHECK on updates.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.health_event_type as enum (
  'DIAGNOSIS',
  'MEDICATION_STARTED',
  'MEDICATION_CHANGED',
  'MEDICATION_STOPPED',
  'LAB_RESULT',
  'DOCUMENT_ADDED',
  'ALLERGY_RECORDED',
  'OTHER'
);

create type public.condition_status as enum ('ACTIVE', 'RESOLVED', 'UNCONFIRMED');

create type public.condition_severity as enum ('UNKNOWN', 'MILD', 'MODERATE', 'SIGNIFICANT');

create type public.insight_type as enum (
  'TREND',        -- a measured value moving in a direction over time
  'PATTERN',      -- something consistent about the record
  'COMPLETENESS', -- a gap in the record worth filling
  'REMINDER'      -- time since the record was last updated
);

create type public.importance_level as enum ('LOW', 'MEDIUM', 'HIGH');

-- ---------------------------------------------------------------------------
-- patient_health_timeline — the patient's health journey, event by event
-- ---------------------------------------------------------------------------
create table public.patient_health_timeline (
  id                 uuid primary key default gen_random_uuid(),
  patient_id         uuid not null references public.patient_profiles (id) on delete cascade,
  event_type         public.health_event_type not null,
  event_title        text not null,
  description        text,
  event_date         date not null,
  source_document_id uuid references public.medical_documents (id) on delete set null,
  -- Lets regeneration replace derived events without touching anything the
  -- patient entered by hand.
  derived            boolean not null default true,
  created_at         timestamptz not null default now(),

  -- btrim, not char_length: a whitespace-only title passes a length check but
  -- renders as a blank row on the patient's timeline.
  constraint patient_health_timeline_title_length
    check (char_length(btrim(event_title)) between 1 and 300)
);

comment on table public.patient_health_timeline is
  'Chronological health events derived from confirmed records and documents.';

create index patient_health_timeline_patient_idx
  on public.patient_health_timeline (patient_id, event_date desc);
create index patient_health_timeline_source_idx
  on public.patient_health_timeline (source_document_id);

-- ---------------------------------------------------------------------------
-- health_conditions — tracked conditions with when they first appeared
-- ---------------------------------------------------------------------------
create table public.health_conditions (
  id               uuid primary key default gen_random_uuid(),
  patient_id       uuid not null references public.patient_profiles (id) on delete cascade,
  condition_name   text not null,
  first_detected   date,
  severity         public.condition_severity not null default 'UNKNOWN',
  current_status   public.condition_status not null default 'ACTIVE',
  confidence_score numeric(4,3),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- One row per condition per patient; re-confirming a condition updates it
  -- rather than accumulating duplicates.
  constraint health_conditions_unique_per_patient unique (patient_id, condition_name),
  constraint health_conditions_name_not_blank
    check (char_length(btrim(condition_name)) between 1 and 200),
  constraint health_conditions_confidence_range
    check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1))
);

comment on table public.health_conditions is
  'Conditions the patient has confirmed, with first-detected date and status.';

create index health_conditions_patient_idx on public.health_conditions (patient_id);

-- ---------------------------------------------------------------------------
-- medication_history — medications over time, not just what is current
-- ---------------------------------------------------------------------------
create table public.medication_history (
  id                 uuid primary key default gen_random_uuid(),
  patient_id         uuid not null references public.patient_profiles (id) on delete cascade,
  medicine_name      text not null,
  dosage             text,
  frequency          text,
  start_date         date,
  end_date           date,
  source_document_id uuid references public.medical_documents (id) on delete set null,
  created_at         timestamptz not null default now(),

  constraint medication_history_dates_ordered
    check (end_date is null or start_date is null or end_date >= start_date)
);

comment on table public.medication_history is
  'Medication record over time. A null end_date means currently taken.';

create index medication_history_patient_idx
  on public.medication_history (patient_id, start_date desc);

-- ---------------------------------------------------------------------------
-- health_insights — generated observations, always traceable
-- ---------------------------------------------------------------------------
create table public.health_insights (
  id               uuid primary key default gen_random_uuid(),
  patient_id       uuid not null references public.patient_profiles (id) on delete cascade,
  insight_type     public.insight_type not null,
  insight_text     text not null,
  importance_level public.importance_level not null default 'MEDIUM',
  -- Every insight must be able to answer "where did this come from?".
  evidence         jsonb not null default '[]'::jsonb,
  confidence_score numeric(4,3),
  generated_at     timestamptz not null default now(),

  constraint health_insights_text_not_blank
    check (char_length(btrim(insight_text)) between 1 and 1000),
  -- The dashboard iterates over evidence, so a non-array would break the page
  -- rather than merely look wrong.
  constraint health_insights_evidence_is_array
    check (jsonb_typeof(evidence) = 'array'),
  constraint health_insights_confidence_range
    check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1))
);

comment on table public.health_insights is
  'Observations derived from the patient record. Evidence-linked, never diagnostic.';

create index health_insights_patient_idx
  on public.health_insights (patient_id, generated_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance (reuses the Phase 1 helper)
-- ---------------------------------------------------------------------------
create trigger health_conditions_set_updated_at
  before update on public.health_conditions
  for each row execute function private.set_updated_at();

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.patient_health_timeline enable row level security;
alter table public.health_conditions       enable row level security;
alter table public.medication_history      enable row level security;
alter table public.health_insights         enable row level security;

-- patient_health_timeline --------------------------------------------------
create policy "Patients read own timeline"
  on public.patient_health_timeline for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Patients create own timeline events"
  on public.patient_health_timeline for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients update own timeline events"
  on public.patient_health_timeline for update
  to authenticated
  using ( patient_id = private.current_patient_profile_id() )
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients delete own timeline events"
  on public.patient_health_timeline for delete
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- health_conditions --------------------------------------------------------
create policy "Patients read own conditions"
  on public.health_conditions for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Patients create own conditions"
  on public.health_conditions for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients update own conditions"
  on public.health_conditions for update
  to authenticated
  using ( patient_id = private.current_patient_profile_id() )
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients delete own conditions"
  on public.health_conditions for delete
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- medication_history -------------------------------------------------------
create policy "Patients read own medication history"
  on public.medication_history for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Patients create own medication history"
  on public.medication_history for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients update own medication history"
  on public.medication_history for update
  to authenticated
  using ( patient_id = private.current_patient_profile_id() )
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients delete own medication history"
  on public.medication_history for delete
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- health_insights ----------------------------------------------------------
create policy "Patients read own insights"
  on public.health_insights for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Patients create own insights"
  on public.health_insights for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients delete own insights"
  on public.health_insights for delete
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- ===========================================================================
-- Grants — authenticated only; `anon` receives nothing.
-- ===========================================================================
grant select, insert, update, delete on public.patient_health_timeline to authenticated;
grant select, insert, update, delete on public.health_conditions       to authenticated;
grant select, insert, update, delete on public.medication_history      to authenticated;
grant select, insert, delete         on public.health_insights         to authenticated;

revoke all on public.patient_health_timeline from anon;
revoke all on public.health_conditions       from anon;
revoke all on public.medication_history      from anon;
revoke all on public.health_insights         from anon;

-- ─────────────────────────────────────────────────────────────────────────
-- 20260804120000_phase4_risk_intelligence.sql
-- ─────────────────────────────────────────────────────────────────────────
-- ===========================================================================
-- AVERIS — Phase 4: ML health risk intelligence
--
-- Two tables:
--   health_predictions — one row per risk assessment, owned by a patient
--   model_metrics      — how each trained model scored. Not patient data.
--
-- The asymmetry between them is deliberate and is the main decision in this
-- migration. Predictions are among the most sensitive rows in AVERIS: a
-- diabetes risk score attached to a named person is exactly the kind of
-- record that should never leak, so it gets the same deny-by-default,
-- owner-scoped RLS as everything else in the patient's record.
--
-- Model metrics are the opposite. They describe a public dataset, contain no
-- patient data at all, and every patient should be able to see how well the
-- model that scored them actually performs. They are readable by any signed-in
-- user and writable by none.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.prediction_type as enum ('DIABETES', 'CARDIOVASCULAR');

create type public.risk_category as enum ('LOW', 'MODERATE', 'HIGH');

-- ---------------------------------------------------------------------------
-- health_predictions — one stored risk assessment
-- ---------------------------------------------------------------------------
create table public.health_predictions (
  id               uuid primary key default gen_random_uuid(),
  patient_id       uuid not null references public.patient_profiles (id) on delete cascade,
  prediction_type  public.prediction_type not null,
  risk_score       numeric(5,4) not null,
  risk_category    public.risk_category not null,
  model_version    text not null,

  -- The full explanation: the inputs that were used, which of them were
  -- imputed, and each feature's Shapley contribution. Stored with the
  -- prediction rather than recomputed, because a later model version would
  -- produce different contributions and the patient would have no way to see
  -- what they were actually shown at the time.
  explanation      jsonb not null default '{}'::jsonb,

  -- How much of the prediction rested on measured data rather than population
  -- averages. Not the model's accuracy.
  confidence_score numeric(4,3),

  created_at       timestamptz not null default now(),

  constraint health_predictions_risk_score_range
    check (risk_score >= 0 and risk_score <= 1),
  constraint health_predictions_confidence_range
    check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1)),
  constraint health_predictions_version_not_blank
    check (char_length(btrim(model_version)) between 1 and 40),
  -- The dashboard iterates the contributions, so a non-object would break the
  -- page rather than merely look wrong.
  constraint health_predictions_explanation_is_object
    check (jsonb_typeof(explanation) = 'object')
);

comment on table public.health_predictions is
  'ML risk assessments. Not diagnoses — every row carries its own explanation.';

-- The dashboard reads the newest prediction per type for one patient.
create index health_predictions_patient_idx
  on public.health_predictions (patient_id, prediction_type, created_at desc);

-- ---------------------------------------------------------------------------
-- model_metrics — training results, one row per model family per version
-- ---------------------------------------------------------------------------
create table public.model_metrics (
  id            uuid primary key default gen_random_uuid(),
  model_name    text not null,
  model_version text not null,
  algorithm     text not null,
  dataset       text not null,
  accuracy      numeric(5,4),
  precision     numeric(5,4),
  recall        numeric(5,4),
  f1_score      numeric(5,4),
  roc_auc       numeric(5,4),
  -- Whether this family is the one actually serving predictions. Recorded so
  -- the comparison table can show what was rejected, not only what shipped.
  is_serving    boolean not null default false,
  created_at    timestamptz not null default now(),

  constraint model_metrics_unique_run
    unique (model_name, model_version, algorithm),
  constraint model_metrics_ranges check (
    (accuracy  is null or (accuracy  >= 0 and accuracy  <= 1)) and
    (precision is null or (precision >= 0 and precision <= 1)) and
    (recall    is null or (recall    >= 0 and recall    <= 1)) and
    (f1_score  is null or (f1_score  >= 0 and f1_score  <= 1)) and
    (roc_auc   is null or (roc_auc   >= 0 and roc_auc   <= 1))
  )
);

comment on table public.model_metrics is
  'How each trained model scored. Public research data — contains no patient information.';

create index model_metrics_model_idx on public.model_metrics (model_name, created_at desc);

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.health_predictions enable row level security;
alter table public.model_metrics       enable row level security;

-- health_predictions -------------------------------------------------------
create policy "Patients read own predictions"
  on public.health_predictions for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Patients create own predictions"
  on public.health_predictions for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

-- No UPDATE policy. A prediction is a record of what a model produced at a
-- point in time; editing one would make the stored explanation a lie. A new
-- assessment is a new row.

create policy "Patients delete own predictions"
  on public.health_predictions for delete
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- model_metrics ------------------------------------------------------------
-- Readable by every signed-in patient: a person told they are at higher risk
-- is entitled to see how often the model that said so is right.
create policy "Signed-in users read model metrics"
  on public.model_metrics for select
  to authenticated
  using ( true );

-- No insert, update or delete policy for any client role. Metrics are written
-- by the training pipeline through the SQL editor, never by the application.

-- ===========================================================================
-- Grants
-- ===========================================================================
grant select, insert, delete on public.health_predictions to authenticated;
grant select                 on public.model_metrics       to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 20260804180000_phase5_knowledge_intelligence.sql
-- ─────────────────────────────────────────────────────────────────────────
-- ===========================================================================
-- AVERIS — Phase 5: medical knowledge intelligence (RAG)
--
-- Three tables and one decision that drives all of them.
--
-- THE DECISION: retrieval runs inside Postgres, not in an in-process index.
--
-- The obvious alternative is FAISS. It is faster and it is the wrong choice
-- here, because a FAISS index is one flat array of vectors with no notion of
-- who owns each row. Isolation would depend on filtering the *results* in
-- application code, which means a single missing predicate silently returns
-- another patient's blood report as context for someone else's question — and
-- nothing about the response would look wrong.
--
-- With pgvector, the RLS policy is part of the query plan. The similarity
-- search cannot see rows the policy excludes, so cross-patient retrieval is
-- not "prevented by a check" but unrepresentable. For a personal health
-- record that trade is worth far more than the latency.
--
-- Embeddings are all-MiniLM-L6-v2, 384 dimensions, L2-normalised at write
-- time — so cosine distance and inner product agree and `<=>` is exact.
-- ===========================================================================

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- The `authenticated` role needs USAGE to reach the `<=>` operator; without
-- it every retrieval fails at runtime with "operator does not exist".
grant usage on schema extensions to authenticated;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- The separation the product requires, made structural. A chunk is either
-- about one patient or it is general medical knowledge — never both, and the
-- check constraint below makes the ambiguous state impossible to store.
create type public.knowledge_source_type as enum ('PATIENT_DOCUMENT', 'MEDICAL_KNOWLEDGE');

create type public.knowledge_category as enum (
  'LAB_REFERENCE',
  'CONDITION',
  'MEDICATION',
  'PROCEDURE',
  'GENERAL_HEALTH'
);

-- ---------------------------------------------------------------------------
-- knowledge_documents — the general medical knowledge base
--
-- Contains no patient data. Every signed-in user reads the same rows.
-- ---------------------------------------------------------------------------
create table public.knowledge_documents (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  category    public.knowledge_category not null,
  source_type public.knowledge_source_type not null default 'MEDICAL_KNOWLEDGE',
  body        text not null,
  -- Where the claim comes from. A knowledge base a patient cannot trace is
  -- indistinguishable from a model making things up.
  citation    text not null,
  created_at  timestamptz not null default now(),

  constraint knowledge_documents_title_not_blank
    check (char_length(btrim(title)) between 1 and 300),
  constraint knowledge_documents_body_not_blank
    check (char_length(btrim(body)) between 1 and 20000),
  constraint knowledge_documents_citation_not_blank
    check (char_length(btrim(citation)) between 1 and 500),
  -- This table is the knowledge base; a patient document does not belong here.
  constraint knowledge_documents_is_knowledge
    check (source_type = 'MEDICAL_KNOWLEDGE'),
  constraint knowledge_documents_unique_title unique (title)
);

comment on table public.knowledge_documents is
  'General medical knowledge. Public reference material — contains no patient data.';

-- ---------------------------------------------------------------------------
-- knowledge_embeddings — retrievable chunks, both sources
-- ---------------------------------------------------------------------------
create table public.knowledge_embeddings (
  id                    uuid primary key default gen_random_uuid(),
  source_type           public.knowledge_source_type not null,

  -- Set if and only if this chunk came from a patient's own document.
  patient_id            uuid references public.patient_profiles (id) on delete cascade,
  document_id           uuid references public.medical_documents (id) on delete cascade,

  -- Set if and only if this chunk came from the knowledge base.
  knowledge_document_id uuid references public.knowledge_documents (id) on delete cascade,

  chunk_index           int not null,
  content               text not null,
  embedding             extensions.vector(384) not null,
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),

  -- The separation rule, enforced by the database rather than by discipline.
  -- A patient chunk must name its owner; a knowledge chunk must not have one.
  constraint knowledge_embeddings_source_shape check (
    (source_type = 'PATIENT_DOCUMENT'
      and patient_id is not null
      and document_id is not null
      and knowledge_document_id is null)
    or
    (source_type = 'MEDICAL_KNOWLEDGE'
      and patient_id is null
      and document_id is null
      and knowledge_document_id is not null)
  ),

  constraint knowledge_embeddings_content_not_blank
    check (char_length(btrim(content)) between 1 and 8000),
  constraint knowledge_embeddings_chunk_index_non_negative
    check (chunk_index >= 0),
  constraint knowledge_embeddings_metadata_is_object
    check (jsonb_typeof(metadata) = 'object'),

  -- Re-indexing a document must replace its chunks, not duplicate them.
  constraint knowledge_embeddings_unique_patient_chunk
    unique (document_id, chunk_index),
  constraint knowledge_embeddings_unique_knowledge_chunk
    unique (knowledge_document_id, chunk_index)
);

comment on table public.knowledge_embeddings is
  'Retrievable text chunks with 384-dim MiniLM embeddings. RLS scopes patient chunks to their owner.';

-- Ownership filters run before the distance ordering on a corpus this size,
-- so these matter more than the vector index does.
create index knowledge_embeddings_patient_idx
  on public.knowledge_embeddings (patient_id)
  where source_type = 'PATIENT_DOCUMENT';

create index knowledge_embeddings_document_idx
  on public.knowledge_embeddings (document_id);

create index knowledge_embeddings_knowledge_idx
  on public.knowledge_embeddings (knowledge_document_id);

-- HNSW for when the corpus outgrows a sequential scan.
--
-- Worth knowing: with an RLS predicate, Postgres takes candidates from the
-- index and *then* applies the policy, so an approximate scan can return
-- fewer rows than requested. At AVERIS's corpus size the planner picks an
-- exact sequential scan anyway, which is both correct and fast; the retrieval
-- code over-fetches regardless so that growing the corpus cannot quietly
-- start dropping results.
create index knowledge_embeddings_vector_idx
  on public.knowledge_embeddings
  using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- ai_conversations — what a patient asked and what AVERIS answered
-- ---------------------------------------------------------------------------
create table public.ai_conversations (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.patient_profiles (id) on delete cascade,
  question     text not null,
  response     text not null,
  -- Which chunks the answer was built from. Stored so the citation a patient
  -- saw can be reconstructed later, rather than re-derived from a corpus that
  -- may since have changed.
  sources_used jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),

  constraint ai_conversations_question_not_blank
    check (char_length(btrim(question)) between 1 and 2000),
  constraint ai_conversations_response_not_blank
    check (char_length(btrim(response)) between 1 and 20000),
  constraint ai_conversations_sources_is_array
    check (jsonb_typeof(sources_used) = 'array')
);

comment on table public.ai_conversations is
  'Questions a patient asked about their own record, with the sources used.';

create index ai_conversations_patient_idx
  on public.ai_conversations (patient_id, created_at desc);

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.knowledge_documents  enable row level security;
alter table public.knowledge_embeddings enable row level security;
alter table public.ai_conversations     enable row level security;

-- knowledge_documents ------------------------------------------------------
-- Public reference material: every signed-in patient reads the same rows and
-- none of them can write.
create policy "Signed-in users read the knowledge base"
  on public.knowledge_documents for select
  to authenticated
  using ( true );

-- knowledge_embeddings -----------------------------------------------------
--
-- This single policy is the entire isolation story for retrieval. Because it
-- is part of the query plan, a similarity search physically cannot rank a
-- chunk belonging to another patient — there is no ordering of results that
-- could surface one.
create policy "Patients read their own chunks and all knowledge chunks"
  on public.knowledge_embeddings for select
  to authenticated
  using (
    source_type = 'MEDICAL_KNOWLEDGE'
    or patient_id = private.current_patient_profile_id()
  );

create policy "Patients index their own documents"
  on public.knowledge_embeddings for insert
  to authenticated
  with check (
    source_type = 'PATIENT_DOCUMENT'
    and patient_id = private.current_patient_profile_id()
  );

-- Re-indexing replaces chunks, so a patient must be able to remove their own.
create policy "Patients remove their own chunks"
  on public.knowledge_embeddings for delete
  to authenticated
  using (
    source_type = 'PATIENT_DOCUMENT'
    and patient_id = private.current_patient_profile_id()
  );

-- No UPDATE policy: a chunk's text and its vector must agree, and an update
-- that changed one without the other would leave the index quietly wrong.
-- Re-indexing deletes and re-inserts.

-- ai_conversations ---------------------------------------------------------
create policy "Patients read own conversations"
  on public.ai_conversations for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Patients create own conversations"
  on public.ai_conversations for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients delete own conversations"
  on public.ai_conversations for delete
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- ===========================================================================
-- Grants
-- ===========================================================================
grant select                         on public.knowledge_documents  to authenticated;
grant select, insert, delete         on public.knowledge_embeddings to authenticated;
grant select, insert, delete         on public.ai_conversations     to authenticated;

-- ===========================================================================
-- Retrieval
-- ===========================================================================
--
-- SECURITY INVOKER, and that word is doing all the work.
--
-- A SECURITY DEFINER function here would run as its owner and bypass RLS
-- entirely — every similarity search would range over every patient's chunks,
-- and the isolation argument this whole migration rests on would be worth
-- nothing. It would also look completely fine in testing, because a single
-- patient's results are identical either way.
--
-- INVOKER means the caller's policies apply inside the ORDER BY, so the
-- ranking only ever sees rows that patient is allowed to read.
create or replace function public.match_knowledge(
  query_embedding extensions.vector(384),
  match_count     int default 8,
  filter_source   public.knowledge_source_type default null
)
returns table (
  id                    uuid,
  source_type           public.knowledge_source_type,
  document_id           uuid,
  knowledge_document_id uuid,
  chunk_index           int,
  content               text,
  metadata              jsonb,
  similarity            double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    e.id,
    e.source_type,
    e.document_id,
    e.knowledge_document_id,
    e.chunk_index,
    e.content,
    e.metadata,
    -- Vectors are L2-normalised at write time, so cosine distance is exact
    -- and this maps cleanly onto a 0..1 similarity.
    1 - (e.embedding <=> query_embedding) as similarity
  from public.knowledge_embeddings e
  where filter_source is null or e.source_type = filter_source
  order by e.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

comment on function public.match_knowledge is
  'Similarity search over retrievable chunks. SECURITY INVOKER so RLS scopes the ranking.';

revoke all on function public.match_knowledge(extensions.vector, int, public.knowledge_source_type) from public;
grant execute on function public.match_knowledge(extensions.vector, int, public.knowledge_source_type) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 20260805090000_phase6_production_foundation.sql
-- ─────────────────────────────────────────────────────────────────────────
-- ===========================================================================
-- AVERIS — Phase 6: production foundation
--
-- Four concerns, and each one has a policy shape that differs from everything
-- in phases 1-5. That is the interesting part of this migration: the
-- owner-scoped read/write pattern used everywhere else is wrong for all four.
--
--   audit_logs        append-only, and NOT deletable by the subject. An audit
--                     trail a patient can erase is not an audit trail.
--   notifications     readable and dismissable by the owner, but written only
--                     by the system — a client that can forge a notification
--                     can tell a patient their report is ready when it is not.
--   processing_jobs   claimed by workers with SKIP LOCKED, invisible to
--                     patients except as status on their own document.
--   subscriptions     readable by the owner, writable by nobody. A plan a
--                     client can edit is not a plan.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.audit_action as enum (
  'DOCUMENT_UPLOADED',
  'DOCUMENT_VIEWED',
  'DOCUMENT_DELETED',
  'EXTRACTION_CONFIRMED',
  'PROFILE_UPDATED',
  'HEALTH_SUMMARY_VIEWED',
  'RISK_PREDICTION_GENERATED',
  'AI_QUESTION_ASKED',
  'REPORT_EXPLAINED',
  'SIGNED_IN',
  'SIGNED_OUT'
);

create type public.audit_resource as enum (
  'DOCUMENT',
  'PROFILE',
  'PREDICTION',
  'CONVERSATION',
  'TWIN',
  'SESSION'
);

create type public.notification_kind as enum (
  'DOCUMENT_PROCESSED',
  'DOCUMENT_FAILED',
  'INSIGHT_GENERATED',
  'PROFILE_UPDATED'
);

create type public.job_status as enum ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD');

create type public.subscription_plan as enum ('FREE', 'PREMIUM');

create type public.subscription_state as enum ('ACTIVE', 'PAST_DUE', 'CANCELLED');

-- ---------------------------------------------------------------------------
-- audit_logs
--
-- Append-only by construction. There is no UPDATE policy and no DELETE policy
-- for any client role, so the subject of a log entry cannot revise or remove
-- it. This is the whole point: an audit trail that the person being audited
-- can edit records nothing.
--
-- user_id is the acting auth user rather than a patient profile, because some
-- auditable events (sign-in, sign-out) happen before a profile is resolved.
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  action        public.audit_action not null,
  resource_type public.audit_resource not null,
  resource_id   uuid,
  -- Request correlation, so one user action can be traced across the log
  -- lines it produced. Never contains patient health data — see the service.
  metadata      jsonb not null default '{}'::jsonb,
  ip_address    inet,
  created_at    timestamptz not null default now(),

  constraint audit_logs_metadata_is_object
    check (jsonb_typeof(metadata) = 'object')
);

comment on table public.audit_logs is
  'Append-only activity trail. Not deletable by the subject — that is deliberate.';

create index audit_logs_user_idx on public.audit_logs (user_id, created_at desc);
create index audit_logs_resource_idx on public.audit_logs (resource_type, resource_id);
create index audit_logs_action_idx on public.audit_logs (action, created_at desc);

-- ---------------------------------------------------------------------------
-- notifications
--
-- Written by the system, read and dismissed by the owner. A client that could
-- insert here could tell a patient their report finished processing when it
-- had not — so INSERT is granted to no client role.
-- ---------------------------------------------------------------------------
create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  patient_id  uuid not null references public.patient_profiles (id) on delete cascade,
  kind        public.notification_kind not null,
  title       text not null,
  body        text not null,
  /** Where the notification points. Relative path, never an external URL. */
  href        text,
  read_at     timestamptz,
  created_at  timestamptz not null default now(),

  constraint notifications_title_not_blank
    check (char_length(btrim(title)) between 1 and 200),
  constraint notifications_body_not_blank
    check (char_length(btrim(body)) between 1 and 1000),
  -- An absolute URL here would turn a system notification into an open
  -- redirect that a patient has every reason to trust.
  --
  -- The negative lookahead is load-bearing: without it "//evil.example/x"
  -- passes, because it starts with "/" and contains only allowed characters.
  -- Browsers read a protocol-relative URL as an external origin, so that one
  -- character is the whole difference between an internal link and an
  -- off-site redirect.
  constraint notifications_href_is_relative
    check (href is null or href ~ '^/(?![/\\])[A-Za-z0-9/_?=&.-]*$')
);

comment on table public.notifications is
  'System-generated alerts. Readable and dismissable by the owner; writable by no client role.';

create index notifications_patient_idx
  on public.notifications (patient_id, created_at desc);

create index notifications_unread_idx
  on public.notifications (patient_id)
  where read_at is null;

-- ---------------------------------------------------------------------------
-- processing_jobs
--
-- The queue behind document processing. Claimed with FOR UPDATE SKIP LOCKED,
-- which is what makes two workers safe without a broker: the row lock is the
-- lease, and a crashed worker's lock dies with its transaction.
-- ---------------------------------------------------------------------------
create table public.processing_jobs (
  id            uuid primary key default gen_random_uuid(),
  patient_id    uuid not null references public.patient_profiles (id) on delete cascade,
  document_id   uuid not null references public.medical_documents (id) on delete cascade,
  status        public.job_status not null default 'QUEUED',
  attempts      int not null default 0,
  max_attempts  int not null default 3,
  /** Backoff: a job is invisible to workers until this time. */
  run_after     timestamptz not null default now(),
  last_error    text,
  claimed_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),

  constraint processing_jobs_attempts_sane
    check (attempts >= 0 and max_attempts between 1 and 10),
  -- One live job per document. A double-submit would otherwise pay for OCR
  -- and an AI extraction twice and race on the same rows.
  constraint processing_jobs_one_live_per_document
    exclude (document_id with =) where (status in ('QUEUED', 'RUNNING'))
);

comment on table public.processing_jobs is
  'Document processing queue. Claimed with SKIP LOCKED; the row lock is the lease.';

-- The claim query orders by run_after among visible jobs, so this is the
-- index it walks.
create index processing_jobs_claimable_idx
  on public.processing_jobs (run_after)
  where status = 'QUEUED';

create index processing_jobs_document_idx on public.processing_jobs (document_id);

-- ---------------------------------------------------------------------------
-- subscriptions
--
-- Readable by the owner, writable by nobody. Plan limits are enforced against
-- this row, so a client that could write it could grant itself unlimited
-- uploads by sending one PATCH.
--
-- No payment fields. Phase 6 explicitly stops short of billing; this exists so
-- the enforcement path is real and the billing integration later has a row to
-- update rather than a schema change to perform.
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null unique references public.users (id) on delete cascade,
  plan                public.subscription_plan not null default 'FREE',
  subscription_status public.subscription_state not null default 'ACTIVE',
  current_period_end  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.subscriptions is
  'Plan and status. Readable by the owner, writable by no client role.';

create index subscriptions_user_idx on public.subscriptions (user_id);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function private.set_updated_at();

-- Every existing user gets a FREE row, and every new one does too. Enforcement
-- can then read a plan unconditionally instead of treating "no row" as a
-- special case that some call site will eventually forget to handle.
insert into public.subscriptions (user_id)
select id from public.users
on conflict (user_id) do nothing;

create or replace function private.create_default_subscription()
returns trigger
language plpgsql
security definer
-- SECURITY DEFINER is required: the trigger inserts into a table the inserting
-- role has no grant on. It is safe because the function takes no arguments
-- from the caller and writes only the id of the row that triggered it.
set search_path = public, pg_temp
as $$
begin
  insert into public.subscriptions (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger users_create_default_subscription
  after insert on public.users
  for each row execute function private.create_default_subscription();

-- ===========================================================================
-- A note on identity, because this migration gets it wrong easily
-- ===========================================================================
--
-- public.users.id and auth.users.id are DIFFERENT values: the application row
-- carries its own gen_random_uuid() and links to auth via auth_user_id.
--
-- audit_logs.user_id references auth.users, so its policy compares against
-- auth.uid() directly. subscriptions.user_id references public.users, so its
-- policy must go through private.current_app_user_id() (defined in the Phase 1
-- core schema).
--
-- Getting this backwards matches nothing, and matches nothing *silently* —
-- which is how a premium subscriber ends up reading as FREE with no error
-- anywhere in the stack.

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.audit_logs      enable row level security;
alter table public.notifications   enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.subscriptions   enable row level security;

-- audit_logs ---------------------------------------------------------------
-- A patient may read their own trail — under most health-data regimes that is
-- their right, and it is also the feature that makes the log worth keeping.
create policy "Users read own audit trail"
  on public.audit_logs for select
  to authenticated
  using ( user_id = (select auth.uid()) );

-- Writing is allowed only for oneself, so a compromised session cannot forge
-- another user's history.
create policy "Users append their own audit entries"
  on public.audit_logs for insert
  to authenticated
  with check ( user_id = (select auth.uid()) );

-- Deliberately no UPDATE and no DELETE policy, and no grant for either below.
-- Append-only is the property; everything else here is in service of it.

-- notifications ------------------------------------------------------------
create policy "Patients read own notifications"
  on public.notifications for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- Dismissal is the one field a patient may change, and the WITH CHECK keeps
-- them from reassigning the row while doing it.
create policy "Patients dismiss own notifications"
  on public.notifications for update
  to authenticated
  using ( patient_id = private.current_patient_profile_id() )
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients delete own notifications"
  on public.notifications for delete
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- No INSERT policy: notifications are system-generated.

-- processing_jobs ----------------------------------------------------------
-- Read-only, and only for one's own documents. A patient seeing that their
-- upload is queued is useful; a patient writing to the queue is not.
create policy "Patients read own jobs"
  on public.processing_jobs for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Patients enqueue their own documents"
  on public.processing_jobs for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

-- No UPDATE policy for clients: status transitions belong to the worker,
-- which connects with elevated credentials.

-- subscriptions ------------------------------------------------------------
create policy "Users read own subscription"
  on public.subscriptions for select
  to authenticated
  using ( user_id = private.current_app_user_id() );

-- No INSERT, UPDATE or DELETE policy. Plan changes come from billing, which
-- does not run as the user.

-- ===========================================================================
-- Grants
-- ===========================================================================
-- Note what is absent: no update or delete on audit_logs, no insert on
-- notifications, no update on processing_jobs, nothing but select on
-- subscriptions. The grants and the policies say the same thing twice on
-- purpose — a policy without the matching grant is a silent runtime error,
-- and a grant without the matching policy is a hole waiting for one.
grant select, insert         on public.audit_logs      to authenticated;
grant select, update, delete on public.notifications   to authenticated;
grant select, insert         on public.processing_jobs to authenticated;
grant select                 on public.subscriptions   to authenticated;

-- ===========================================================================
-- Job claiming
-- ===========================================================================
--
-- SECURITY DEFINER here is deliberate and is the one place in AVERIS where it
-- is correct: the worker must see and mutate jobs across all patients, which
-- is exactly what RLS exists to prevent for user-facing code. It is safe only
-- because EXECUTE is revoked from every client role below — `authenticated`
-- cannot call it, so no session can reach it.
create or replace function private.claim_processing_job(worker_batch int default 1)
returns table (
  job_id      uuid,
  patient_id  uuid,
  document_id uuid,
  attempts    int
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.processing_jobs j
  set
    status     = 'RUNNING',
    attempts   = j.attempts + 1,
    claimed_at = now()
  where j.id in (
    select id from public.processing_jobs
    where status = 'QUEUED' and run_after <= now()
    order by run_after
    -- SKIP LOCKED is what makes concurrent workers safe without a broker:
    -- each takes a different row instead of blocking on the same one.
    for update skip locked
    limit greatest(worker_batch, 1)
  )
  returning j.id, j.patient_id, j.document_id, j.attempts;
$$;

comment on function private.claim_processing_job is
  'Atomically claims queued jobs. Not callable by any client role.';

revoke all on function private.claim_processing_job(int) from public;

-- ─────────────────────────────────────────────────────────────────────────
-- 20260806090000_iot_phase1_monitoring.sql
-- ─────────────────────────────────────────────────────────────────────────
-- ===========================================================================
-- AVERIS IoT — Phase 1: device registry, sensor time-series, alerts
--
-- The decision this migration is built around:
--
--   A device's owner is a property of the DEVICE ROW, never of the payload.
--
-- The ingest endpoint authenticates a device by token, then reads patient_id
-- from the row it just authenticated. It never accepts a patient id from the
-- request body. If it did, one leaked device credential would be able to write
-- readings into any patient's chart — and afterwards nothing could distinguish
-- the forged rows from real ones, because they would be structurally identical.
--
-- Everything below exists to make that rule enforceable rather than merely
-- intended: the token is stored hashed, the owner is a foreign key, and no
-- client role may write sensor data at all.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Roles
--
-- Postgres cannot remove a value from an enum, so HOSPITAL_ADMIN stays and
-- ADMIN joins it. Renaming would break every existing row and every policy
-- that mentions it, to gain a tidier name nobody sees.
--
-- ⚠ DO NOT REFERENCE 'CAREGIVER' OR 'ADMIN' ANYWHERE ELSE IN THIS FILE.
--
-- Postgres refuses to *use* an enum value added to a pre-existing type within
-- the same transaction — "unsafe use of new value". `user_role` was created
-- back in the Phase 1 migration, so these two statements and any policy or
-- default that mentions the new values must land in separate transactions.
--
-- Nothing below uses them, which is why this file is safe today. It fails the
-- moment someone adds a CAREGIVER policy here, and it fails only when applied
-- as one transaction — meaning statement-by-statement local testing passes
-- while the Supabase SQL editor, which wraps a paste, does not. Put anything
-- that references these values in a later migration.
-- ---------------------------------------------------------------------------
alter type public.user_role add value if not exists 'CAREGIVER';
alter type public.user_role add value if not exists 'ADMIN';

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.device_type as enum (
  'WEARABLE_BAND',
  'PULSE_OXIMETER',
  'SMART_WATCH',
  'CHEST_STRAP',
  'OTHER'
);

create type public.connection_status as enum ('ONLINE', 'OFFLINE', 'PROVISIONED', 'RETIRED');

create type public.movement_status as enum ('RESTING', 'NORMAL', 'ACTIVE', 'FALL_SUSPECTED', 'UNKNOWN');

create type public.alert_type as enum (
  'HEART_RATE_HIGH',
  'HEART_RATE_LOW',
  'SPO2_LOW',
  'TEMPERATURE_HIGH',
  'TEMPERATURE_LOW',
  'FALL_SUSPECTED',
  'DEVICE_OFFLINE',
  'BATTERY_LOW'
);

create type public.alert_severity as enum ('INFO', 'WARNING', 'CRITICAL');

create type public.alert_state as enum ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED');

-- ---------------------------------------------------------------------------
-- iot_devices
--
-- One row per physical wearable. `device_key` is the human/firmware-facing
-- identifier ("AVR001") burned into the device; `id` is the internal key that
-- everything else references.
-- ---------------------------------------------------------------------------
create table public.iot_devices (
  id                 uuid primary key default gen_random_uuid(),
  patient_id         uuid not null references public.patient_profiles (id) on delete cascade,

  -- What the firmware announces itself as. Unique across the fleet.
  device_key         text not null,
  device_name        text not null,
  device_type        public.device_type not null default 'WEARABLE_BAND',

  -- SHA-256 of the provisioning token. The token itself is shown once at
  -- registration and never stored: a dump of this table yields no credential
  -- that can write readings.
  token_hash         text not null,
  -- Lets a token be rotated without re-registering the device.
  token_issued_at    timestamptz not null default now(),

  connection_status  public.connection_status not null default 'PROVISIONED',
  battery_percentage smallint,
  firmware_version   text,
  last_connected_at  timestamptz,
  -- Distinct from last_connected_at: a device can hold a connection while
  -- failing to produce readings, and those are different faults.
  last_reading_at    timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint iot_devices_key_unique unique (device_key),
  constraint iot_devices_key_shape
    check (device_key ~ '^[A-Za-z0-9_-]{3,64}$'),
  constraint iot_devices_name_not_blank
    check (char_length(btrim(device_name)) between 1 and 120),
  constraint iot_devices_battery_range
    check (battery_percentage is null or battery_percentage between 0 and 100),
  -- A hex SHA-256 and nothing else, so a plaintext token cannot be stored here
  -- by a future call site that forgets to hash.
  constraint iot_devices_token_is_hash
    check (token_hash ~ '^[a-f0-9]{64}$')
);

comment on table public.iot_devices is
  'Registered wearables. Owner lives here; ingestion reads it rather than trusting the payload.';

create index iot_devices_patient_idx on public.iot_devices (patient_id);
create index iot_devices_key_idx on public.iot_devices (device_key);

create trigger iot_devices_set_updated_at
  before update on public.iot_devices
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- sensor_readings — the time-series
--
-- Append-only. Nothing updates a reading: a measurement that was taken is a
-- fact about a moment, and editing it would make the history unfalsifiable.
--
-- patient_id is denormalised from the device deliberately. The alternative is
-- a join to iot_devices on every RLS check, on the highest-volume table in the
-- system. It is written by the ingest service from the authenticated device
-- row, never from the request.
-- ---------------------------------------------------------------------------
create table public.sensor_readings (
  id              bigserial primary key,
  device_id       uuid not null references public.iot_devices (id) on delete cascade,
  patient_id      uuid not null references public.patient_profiles (id) on delete cascade,

  -- All nullable: a pulse oximeter reports SpO2 and heart rate but no
  -- temperature, and a schema that demanded every field would force the
  -- firmware to invent numbers.
  heart_rate      smallint,
  spo2            smallint,
  temperature     numeric(4,1),
  movement_status public.movement_status not null default 'UNKNOWN',
  battery_percentage smallint,

  -- When the device took the measurement.
  recorded_at     timestamptz not null,
  -- When it reached us. The gap is how a device buffering through a network
  -- outage is distinguished from one that is simply late.
  received_at     timestamptz not null default now(),

  -- Physiologically possible ranges, not clinically normal ones. A heart rate
  -- of 210 is alarming and real; a heart rate of 4000 is a broken sensor, and
  -- storing it would poison every average computed afterwards.
  constraint sensor_readings_heart_rate_plausible
    check (heart_rate is null or heart_rate between 20 and 250),
  constraint sensor_readings_spo2_plausible
    check (spo2 is null or spo2 between 50 and 100),
  constraint sensor_readings_temperature_plausible
    check (temperature is null or temperature between 25.0 and 45.0),
  constraint sensor_readings_battery_range
    check (battery_percentage is null or battery_percentage between 0 and 100),
  -- A reading with no measurements is noise on the wire.
  constraint sensor_readings_has_a_measurement
    check (heart_rate is not null or spo2 is not null or temperature is not null),
  -- Clock skew is tolerated within reason; a timestamp far in the future is a
  -- misconfigured device, and accepting it would put the row permanently at
  -- the top of every "latest" query.
  constraint sensor_readings_not_far_future
    check (recorded_at < now() + interval '1 hour')
);

comment on table public.sensor_readings is
  'Append-only sensor time-series. BRIN on time; patient_id denormalised from the device.';

-- BRIN, not btree, for the time dimension.
--
-- The table is append-only and therefore already physically ordered by time,
-- which is exactly the correlation BRIN exploits: it stores one min/max
-- summary per block range instead of one entry per row. For a table that grows
-- by millions of rows a month, the btree equivalent would be larger than
-- useful and would spend most of its maintenance cost on a column whose order
-- is already known.
create index sensor_readings_recorded_brin
  on public.sensor_readings using brin (recorded_at) with (pages_per_range = 32);

-- The other query that matters: the newest readings for one device or patient.
-- BRIN cannot serve this, so it gets a real btree.
create index sensor_readings_device_recent_idx
  on public.sensor_readings (device_id, recorded_at desc);

create index sensor_readings_patient_recent_idx
  on public.sensor_readings (patient_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- alerts
--
-- Threshold rules in this phase, not predictions. An alert a patient cannot
-- trace to a specific reading and a stated threshold is indistinguishable from
-- the system guessing.
-- ---------------------------------------------------------------------------
create table public.alerts (
  id              uuid primary key default gen_random_uuid(),
  patient_id      uuid not null references public.patient_profiles (id) on delete cascade,
  device_id       uuid references public.iot_devices (id) on delete set null,
  -- The measurement that tripped it, so the alert is always traceable.
  reading_id      bigint references public.sensor_readings (id) on delete set null,

  alert_type      public.alert_type not null,
  severity        public.alert_severity not null default 'WARNING',
  message         text not null,
  -- The value and threshold that produced it, for the same reason.
  observed_value  numeric(6,1),
  threshold_value numeric(6,1),

  status          public.alert_state not null default 'ACTIVE',
  acknowledged_at timestamptz,
  created_at      timestamptz not null default now(),

  constraint alerts_message_not_blank
    check (char_length(btrim(message)) between 1 and 500)
);

comment on table public.alerts is
  'Threshold breaches, each traceable to the reading and threshold that produced it.';

create index alerts_patient_idx on public.alerts (patient_id, created_at desc);
create index alerts_active_idx on public.alerts (patient_id) where status = 'ACTIVE';

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.iot_devices     enable row level security;
alter table public.sensor_readings enable row level security;
alter table public.alerts          enable row level security;

-- iot_devices --------------------------------------------------------------
create policy "Patients read own devices"
  on public.iot_devices for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Patients register own devices"
  on public.iot_devices for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

-- Renaming a device is the patient's; status and battery belong to the device
-- and are written by the ingest service. WITH CHECK stops the row being
-- reassigned to another patient during a rename.
create policy "Patients update own devices"
  on public.iot_devices for update
  to authenticated
  using ( patient_id = private.current_patient_profile_id() )
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients remove own devices"
  on public.iot_devices for delete
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- sensor_readings ----------------------------------------------------------
-- Read-only for patients, and no client role may insert.
--
-- A patient who could write readings could fabricate their own vital signs.
-- That sounds harmless until the data feeds a risk model or is shown to a
-- clinician — at which point the record has to be trustworthy, and "the
-- patient could have typed this" makes it not.
create policy "Patients read own readings"
  on public.sensor_readings for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- No INSERT, UPDATE or DELETE policy. Ingestion runs as the service role.

-- alerts -------------------------------------------------------------------
create policy "Patients read own alerts"
  on public.alerts for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- Acknowledging is the patient's; raising an alert is the system's.
create policy "Patients acknowledge own alerts"
  on public.alerts for update
  to authenticated
  using ( patient_id = private.current_patient_profile_id() )
  with check ( patient_id = private.current_patient_profile_id() );

-- ===========================================================================
-- Grants
--
-- Note the absence: no insert on sensor_readings or alerts for any client
-- role, and no select on iot_devices.token_hash beyond what the column
-- privilege below allows.
-- ===========================================================================
-- SELECT is granted column by column, deliberately.
--
-- The obvious spelling — `grant select on iot_devices` followed by
-- `revoke select (token_hash)` — does not work. Postgres has no way to
-- subtract a column from a table-level grant: the revoke succeeds, reports
-- nothing, and the column stays readable. A `select *` from client code would
-- then hand out every device credential in the account, and the migration
-- would look correct in review.
--
-- Enumerating the readable columns is the only spelling that actually
-- withholds one. token_hash is absent from this list and therefore
-- unreadable; INSERT and UPDATE remain table-level so registration and
-- rotation can still write it.
grant select (
  id, patient_id, device_key, device_name, device_type, token_issued_at,
  connection_status, battery_percentage, firmware_version,
  last_connected_at, last_reading_at, created_at, updated_at
) on public.iot_devices to authenticated;

grant insert, update, delete on public.iot_devices to authenticated;

grant select         on public.sensor_readings to authenticated;
grant select, update on public.alerts          to authenticated;

-- ===========================================================================
-- Device resolution
--
-- SECURITY DEFINER, and callable by no client role. The ingest service uses
-- it to turn a token hash into a device and its owner in one step, so the
-- lookup and the ownership resolution cannot drift apart into two queries that
-- someone later forgets to keep consistent.
-- ===========================================================================
create or replace function private.resolve_device(p_token_hash text)
returns table (
  device_id   uuid,
  patient_id  uuid,
  device_key  text,
  device_name text,
  status      public.connection_status
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.patient_id, d.device_key, d.device_name, d.connection_status
  from public.iot_devices d
  where d.token_hash = p_token_hash
    -- A retired device must not be able to resume writing.
    and d.connection_status <> 'RETIRED';
$$;

comment on function private.resolve_device is
  'Turns a device token hash into its identity and owner. Not callable by any client role.';

revoke all on function private.resolve_device(text) from public;


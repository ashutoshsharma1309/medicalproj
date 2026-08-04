-- ===========================================================================
-- AVERIS — complete schema (Phases 1-5)
--
-- Paste this whole file into the Supabase SQL Editor and run it once:
--   https://supabase.com/dashboard/project/<project-ref>/sql/new
--
-- Creates 15 tables, 50 RLS policies, 7 private helper functions, the
-- private 'medical-documents' storage bucket, and the pgvector retrieval
-- function used by the knowledge engine.
--
-- Afterwards, paste these two generated seeds, in either order:
--   supabase/seed/model_metrics.sql   — ML model comparison (ml/train_all.py)
--   supabase/seed/knowledge_base.sql  — medical knowledge corpus, embeddings
--                                       included (scripts/seed-knowledge.mjs)
--
-- Generated from supabase/migrations/ — do not edit by hand. Regenerate with:
--   for m in supabase/migrations/*.sql; do \
--     echo "-- $(basename "$m")"; cat "$m"; echo; done > supabase/apply-all.sql
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


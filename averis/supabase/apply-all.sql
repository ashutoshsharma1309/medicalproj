-- ===========================================================================
-- AVERIS — complete schema (Phase 1 + Phase 2)
--
-- Paste this whole file into the Supabase SQL Editor and run it once:
--   https://supabase.com/dashboard/project/<project-ref>/sql/new
--
-- Creates 6 tables, 24 RLS policies, 7 private helper functions and the
-- private 'medical-documents' storage bucket.
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


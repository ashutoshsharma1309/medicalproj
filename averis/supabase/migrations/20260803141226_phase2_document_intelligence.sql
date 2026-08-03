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

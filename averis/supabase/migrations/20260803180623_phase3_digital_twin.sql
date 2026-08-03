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

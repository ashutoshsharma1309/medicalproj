-- ===========================================================================
-- AVERIS IoT — Phase 8: scale, retention, and model governance
--
-- Two unrelated problems, in one migration because both are about the system
-- outliving its prototype: what happens to `sensor_readings` at a million rows
-- a week, and how anyone knows which model produced a stored prediction.
--
-- ── On partitioning, and why this migration does not do it ─────────────────
--
-- `sensor_readings` will need range partitioning by month. One band at 0.5 Hz
-- is ~1.3 million rows a year; a thousand bands is 1.3 billion, and at that
-- size a delete for retention rewrites the table while a ward is being
-- monitored.
--
-- Converting an existing table to a partitioned one requires an exclusive
-- lock, a full copy, and a maintenance window. Doing that inside a migration
-- that also does five other things would mean the riskiest operation in the
-- project runs unattended as a side effect of a deploy.
--
-- So this migration prepares everything *around* partitioning — retention
-- policy, an archival path, the index set the partitions will inherit — and
-- `docs/cloud_architecture.md` carries the cutover procedure as a deliberate,
-- scheduled operation. The column layout was chosen in Phase 1 so that
-- conversion is a migration rather than a redesign.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Retention
--
-- A monitoring platform accumulates raw readings faster than anything else it
-- stores, and almost none of them are read after the day they arrive. What is
-- read forever is the *derived* record: alerts, emergencies, predictions,
-- baselines, the risk timeline.
--
-- So raw readings age out and everything derived from them does not. The
-- policy is a table rather than a constant because "how long do we keep a
-- patient's raw vitals" is a question with a regulatory answer that differs by
-- deployment, and burying it in a cron expression would make it invisible to
-- whoever has to answer it.
-- ---------------------------------------------------------------------------
create table public.retention_policies (
  id            uuid primary key default gen_random_uuid(),
  table_name    text not null unique,

  -- Null means "keep forever", which is the correct policy for derived
  -- clinical records and must be expressible rather than approximated with a
  -- very large number.
  retain_days   integer,

  -- What is lost when a row ages out. Written for whoever reviews the policy,
  -- not for the job that applies it.
  rationale     text not null,

  -- Set false to suspend a policy without deleting it, so suspending is
  -- reversible and visible.
  enabled       boolean not null default true,

  last_applied_at timestamptz,
  last_deleted_rows bigint,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint retention_days_sane
    check (retain_days is null or retain_days between 1 and 36500),
  constraint retention_rationale_not_blank
    check (char_length(btrim(rationale)) between 10 and 500)
);

comment on table public.retention_policies is
  'How long each table is kept, and why. A policy in a table is reviewable; one in a cron expression is not.';

create trigger retention_policies_set_updated_at
  before update on public.retention_policies
  for each row execute function private.set_updated_at();

-- The defaults. Raw readings age out; nothing derived from them does.
insert into public.retention_policies (table_name, retain_days, rationale) values
  ('sensor_readings', 400,
   'Raw vitals. Over a year so a clinician can compare against the same season last year; not forever, because raw readings are the fastest-growing and least-read data in the system. Everything derived from them is kept.'),
  ('device_events', 180,
   'Hardware history. Long enough to diagnose an intermittent fault across seasons, short enough that a fleet does not accumulate boot records indefinitely.'),
  ('health_trends', null,
   'Kept. A trend is a claim AVERIS made about a patient at a point in time, and the timeline that references it must stay explicable.'),
  ('patient_baselines', null,
   'Kept. A superseded baseline is what the system believed when it said a reading was 45% above normal.'),
  ('risk_events', null,
   'Kept. The patient story is the record a clinician reads to understand how someone got here.'),
  ('alerts', null,
   'Kept. An alert is a clinical finding, not telemetry.'),
  ('emergency_events', null,
   'Kept. Who responded to what, and when, is the accountability record.'),
  ('audit_logs', null,
   'Kept. The trail that answers "who read my record in March" cannot have an expiry shorter than the question.');

alter table public.retention_policies enable row level security;

-- No client role reads this. It is operational configuration, not patient
-- data, and a patient learning the retention schedule from the API is a
-- disclosure with no upside.
grant select, update on public.retention_policies to service_role;

-- ---------------------------------------------------------------------------
-- Archival before deletion
--
-- A retention job that only deletes is a job nobody dares enable. This records
-- what each run removed, so the first question after a policy change —
-- "what did that actually do?" — has an answer that is not a guess.
-- ---------------------------------------------------------------------------
create table public.retention_runs (
  id            bigint generated always as identity primary key,
  table_name    text not null,
  cutoff        timestamptz not null,
  deleted_rows  bigint not null,
  duration_ms   integer,
  ran_at        timestamptz not null default now(),

  constraint retention_deleted_not_negative check (deleted_rows >= 0)
);

create index retention_runs_recent_idx on public.retention_runs (table_name, ran_at desc);

alter table public.retention_runs enable row level security;
grant select, insert on public.retention_runs to service_role;

-- ---------------------------------------------------------------------------
-- Indexes for the queries scale makes expensive
--
-- Every index below serves a query that already exists in the application. An
-- index added speculatively costs write throughput on the hottest table in the
-- system to serve a query nobody runs.
-- ---------------------------------------------------------------------------

-- The retention job itself: "readings older than X". Without this, the first
-- run against a large table is a sequential scan taken while a ward is being
-- monitored.
create index if not exists sensor_readings_retention_idx
  on public.sensor_readings (recorded_at)
  where is_simulated = false;

-- The baseline sweep: "which patients produced readings recently". Currently a
-- scan over a time range returning mostly duplicate patient ids.
create index if not exists sensor_readings_active_patients_idx
  on public.sensor_readings (recorded_at desc, patient_id);

-- The clinician's caseload joins emergencies per patient by status. The
-- existing partial index covers open events; this covers the history view.
create index if not exists emergency_events_patient_recent_idx
  on public.emergency_events (patient_id, created_at desc);

-- ===========================================================================
-- Model governance
--
-- `model_metrics` already records how each trained model performed. What was
-- missing is which model *served* a given prediction, and whether the inputs
-- have moved since it was fitted.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- model_deployments
--
-- Which version was serving, and when. Append-only.
--
-- The question this answers: a clinician reviewing a prediction from March
-- needs to know what produced it. Reading the *current* serving version tells
-- them what would produce it today, which is a different and misleading answer.
-- ---------------------------------------------------------------------------
create table public.model_deployments (
  id             uuid primary key default gen_random_uuid(),

  model_name     text not null,
  model_version  text not null,
  algorithm      text not null,

  -- What it was fitted on. A model without its dataset is a number with no
  -- provenance, and the cohort is the single most important caveat AVERIS
  -- carries about its own risk scores.
  dataset        text not null,
  trained_at     timestamptz,

  -- Where the artefact lives, so a deployment can be reproduced rather than
  -- described.
  artifact_path  text,
  artifact_sha256 text,

  deployed_at    timestamptz not null default now(),
  -- Null while serving. Set when superseded, never deleted.
  retired_at     timestamptz,

  -- Free-form, for the reason a version was rolled forward or back.
  notes          text,

  constraint model_deployment_sha_shape
    check (artifact_sha256 is null or artifact_sha256 ~ '^[a-f0-9]{64}$'),
  constraint model_deployment_retired_after_deployed
    check (retired_at is null or retired_at >= deployed_at)
);

comment on table public.model_deployments is
  'Which model version was serving, and when. Append-only: a prediction from March must be explicable by March''s model, not today''s.';

create index model_deployments_serving_idx
  on public.model_deployments (model_name, deployed_at desc);

-- One serving version per model at a time. Two rows with no retirement is
-- ambiguous about which produced a prediction — exactly the ambiguity this
-- table exists to remove.
create unique index model_deployments_one_serving
  on public.model_deployments (model_name)
  where retired_at is null;

alter table public.model_deployments enable row level security;

-- Readable by any signed-in user. A patient shown a risk score is entitled to
-- know which model produced it and what it was fitted on — that is the same
-- reasoning that puts the cohort on the screen beside the number.
create policy "Model provenance is readable by signed-in users"
  on public.model_deployments for select
  to authenticated
  using ( true );

grant select on public.model_deployments to authenticated;
grant select, insert, update on public.model_deployments to service_role;

-- ---------------------------------------------------------------------------
-- model_drift_reports
--
-- Whether recent inputs still resemble what a model was fitted on.
--
-- Note what this table does NOT have: an accuracy column. Measuring whether
-- predictions were *right* requires knowing which patients actually
-- deteriorated, and AVERIS has no outcome data. A nullable accuracy column
-- would be filled in eventually by someone who assumed it should be, and the
-- number would be invented. The absence is the design.
-- ---------------------------------------------------------------------------
create type public.drift_severity as enum ('NONE', 'MODERATE', 'SIGNIFICANT', 'UNKNOWN');

create table public.model_drift_reports (
  id             uuid primary key default gen_random_uuid(),

  model_name     text not null,
  model_version  text not null,

  -- Worst feature's severity.
  overall        public.drift_severity not null,

  -- Per-feature PSI and bin comparison, so a reviewer can see *where* the
  -- distribution moved rather than only that it did.
  features       jsonb not null default '[]'::jsonb,

  -- Inference failures over the same period. A different signal from drift:
  -- a model that is erroring is not a model whose inputs have shifted.
  inference_attempts integer,
  inference_failures integer,

  baseline_from  timestamptz,
  baseline_to    timestamptz,
  observed_from  timestamptz,
  observed_to    timestamptz,

  evaluated_at   timestamptz not null default now(),

  constraint drift_features_is_array check (jsonb_typeof(features) = 'array'),
  constraint drift_failures_not_exceeding_attempts
    check (
      inference_failures is null
      or inference_attempts is null
      or inference_failures <= inference_attempts
    )
);

comment on table public.model_drift_reports is
  'Input distribution drift. Deliberately has no accuracy column: measuring whether predictions were right needs outcome data AVERIS does not have.';

create index model_drift_recent_idx
  on public.model_drift_reports (model_name, evaluated_at desc);

alter table public.model_drift_reports enable row level security;

-- Operational, not clinical. A drift report describes a model's inputs across
-- the whole population, and no individual patient has a claim on it.
grant select, insert on public.model_drift_reports to service_role;

-- ---------------------------------------------------------------------------
-- Which model produced a prediction
--
-- `health_predictions.model_version` already exists as free text. This links it
-- to the deployment record, so "what was serving when this was written" is a
-- join rather than a search through logs.
-- ---------------------------------------------------------------------------
alter table public.health_predictions
  add column if not exists deployment_id uuid references public.model_deployments (id) on delete set null,
  -- 'remote' when the dedicated inference service produced it, 'local' when
  -- the ingest service fell back. A prediction whose provenance is unknown is
  -- one nobody can explain later.
  add column if not exists inference_source text;

alter table public.health_predictions
  add constraint health_predictions_inference_source_known
    check (inference_source is null or inference_source in ('remote', 'local', 'batch'));

create index if not exists health_predictions_deployment_idx
  on public.health_predictions (deployment_id)
  where deployment_id is not null;

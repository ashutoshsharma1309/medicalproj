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

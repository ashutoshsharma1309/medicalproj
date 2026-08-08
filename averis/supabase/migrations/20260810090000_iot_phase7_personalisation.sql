-- ===========================================================================
-- AVERIS IoT — Phase 7: what is normal for THIS patient
--
-- Three tables that turn a stream of readings into a description of a person:
-- their learned baseline, the direction their vitals are moving, and the
-- moments worth putting on a timeline.
--
-- ── Why baselines are stored rather than computed on read ──────────────────
--
-- A baseline is learned from weeks of data. Recomputing it on every dashboard
-- render would mean scanning tens of thousands of rows per page load — but the
-- more important reason is that a stored baseline is a *record of what the
-- system believed at a point in time*. When a clinician asks why AVERIS said a
-- patient was 45% above their normal last Tuesday, the answer has to be the
-- baseline that was in force on Tuesday, not one recomputed today from data
-- that now includes Tuesday.
--
-- So baselines are append-only. Superseded rows are kept, exactly as
-- health_predictions keeps its explanation rather than recomputing it.
--
-- ── The safety property this schema cannot express, stated anyway ──────────
--
-- **A personal baseline never raises an escalation threshold.** Nothing in
-- these tables feeds the alert rules or the escalation engine; they produce
-- findings that sit *beside* the published thresholds. The constraint lives in
-- `lib/health/baseline.ts` and is asserted in its tests, because a database
-- cannot enforce "this column must not influence that code path" — but a
-- future migration that wired `patient_baselines` into an alert predicate
-- would be the single most dangerous change available in this repository, and
-- this comment is where someone would look first.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- patient_baselines
--
-- What this patient's vitals usually look like, learned from an anchored
-- window that deliberately excludes the recent past.
-- ---------------------------------------------------------------------------
create table public.patient_baselines (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.patient_profiles (id) on delete cascade,

  -- Central values. Medians, not means: vital-sign distributions are skewed
  -- and carry artefacts that survive the device-side filter, and one 180 BPM
  -- sample from a shifted sensor moves a mean while moving a median by nothing.
  avg_heart_rate    numeric(5, 1),
  avg_spo2          numeric(4, 1),
  avg_temperature   numeric(4, 1),

  -- Where the middle 80% of their readings fell, per channel. The interval a
  -- clinician is shown, and the one deviations are measured against.
  heart_rate_low    numeric(5, 1),
  heart_rate_high   numeric(5, 1),
  spo2_low          numeric(4, 1),
  spo2_high         numeric(4, 1),
  temperature_low   numeric(4, 1),
  temperature_high  numeric(4, 1),

  -- Spread, robust to outliers. What "unusual for this patient" is scaled by.
  heart_rate_iqr    numeric(5, 1),
  spo2_iqr          numeric(4, 1),
  temperature_iqr   numeric(4, 1),

  -- The window it was learned from. Without these a baseline is a number with
  -- no provenance, and "45% above their normal" becomes uncheckable.
  window_start      timestamptz not null,
  window_end        timestamptz not null,
  days_covered      smallint not null,
  sample_count      integer not null,
  -- Readings dropped because they fell inside an excluded period — an open
  -- emergency, a run of critical alerts. A baseline that learned the patient's
  -- illness would go quiet exactly when it should not.
  excluded_samples  integer not null default 0,

  -- 0–1. Driven mostly by days observed rather than sample count: a baseline
  -- built from three days has seen three of the patient's daily cycles,
  -- however many readings that came to.
  confidence        numeric(3, 2) not null,

  calculated_at     timestamptz not null default now(),

  constraint baseline_window_ordered check (window_end > window_start),
  constraint baseline_days_positive check (days_covered >= 1),
  constraint baseline_confidence_range check (confidence >= 0 and confidence <= 1),
  -- Ranges must bracket their centre, or the interval shown to a clinician is
  -- not an interval.
  constraint baseline_hr_bracketed check (
    avg_heart_rate is null
    or (heart_rate_low <= avg_heart_rate and avg_heart_rate <= heart_rate_high)
  ),
  constraint baseline_spo2_bracketed check (
    avg_spo2 is null or (spo2_low <= avg_spo2 and avg_spo2 <= spo2_high)
  ),
  constraint baseline_temp_bracketed check (
    avg_temperature is null
    or (temperature_low <= avg_temperature and avg_temperature <= temperature_high)
  )
);

comment on table public.patient_baselines is
  'What is normal for one patient, learned from an anchored window. Append-only: a superseded baseline is what the system believed at the time, and explanations reference it.';

-- The only query that matters: the newest baseline for one patient.
create index patient_baselines_latest_idx
  on public.patient_baselines (patient_id, calculated_at desc);

alter table public.patient_baselines enable row level security;

create policy "Patients read their own baseline"
  on public.patient_baselines for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- The care team sees it because a deviation is meaningless without the
-- baseline it deviates from — showing "45% above normal" to a clinician who
-- cannot see the normal is showing them a number they cannot check.
create policy "Care team reads assigned baselines"
  on public.patient_baselines for select
  to authenticated
  using ( private.can_see_patient_vitals(patient_id) );

-- No client INSERT. A baseline a browser could write is a baseline a browser
-- could use to change what counts as normal for someone.
grant select on public.patient_baselines to authenticated;
grant select, insert on public.patient_baselines to service_role;

-- ---------------------------------------------------------------------------
-- health_trends
--
-- The direction a channel is moving over days, with the evidence.
-- ---------------------------------------------------------------------------
create type public.trend_metric as enum ('HEART_RATE', 'SPO2', 'TEMPERATURE');

create type public.trend_direction as enum ('RISING', 'FALLING', 'STEADY');

create table public.health_trends (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.patient_profiles (id) on delete cascade,

  metric       public.trend_metric not null,
  direction    public.trend_direction not null,
  -- Change per day, in the metric's own units. Signed.
  trend_value  numeric(6, 3) not null,
  -- Total change across the observed span, so a reader does not have to
  -- multiply.
  total_change numeric(6, 2),

  -- How well a straight line fits, 0–1. A steep slope through scattered points
  -- is not a trend, and storing the fit is what lets a reader tell the
  -- difference later.
  fit          numeric(3, 2),
  days_observed smallint not null,

  -- Whether this direction is the bad one for this metric. Rising oxygen
  -- saturation is a rise and is good news; storing the judgement beside the
  -- direction stops every reader having to know which way is which.
  concerning   boolean not null default false,

  window_start timestamptz not null,
  window_end   timestamptz not null,
  created_at   timestamptz not null default now(),

  constraint trend_window_ordered check (window_end > window_start),
  constraint trend_days_enough check (days_observed >= 2),
  constraint trend_fit_range check (fit is null or (fit >= 0 and fit <= 1))
);

comment on table public.health_trends is
  'Direction of travel per metric over days, with the fit that says whether it is a trend or a wobble.';

create index health_trends_patient_idx
  on public.health_trends (patient_id, created_at desc);

create index health_trends_concerning_idx
  on public.health_trends (patient_id, created_at desc)
  where concerning;

alter table public.health_trends enable row level security;

create policy "Patients read their own trends"
  on public.health_trends for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Care team reads assigned trends"
  on public.health_trends for select
  to authenticated
  using ( private.can_see_patient_vitals(patient_id) );

grant select on public.health_trends to authenticated;
grant select, insert on public.health_trends to service_role;

-- ---------------------------------------------------------------------------
-- risk_events
--
-- The patient's story, as a timeline a clinician can read top to bottom.
--
-- Distinct from `emergency_events`, and the distinction is the point: an
-- emergency is something a person must respond to *now*. A risk event is
-- something that happened and is worth seeing in sequence — a baseline being
-- established, a trend appearing, a deviation, a threshold crossing. Most risk
-- events require no response at all.
--
-- Merging them would either fill the response queue with history or bury the
-- history inside a queue nobody reads once it is cleared.
-- ---------------------------------------------------------------------------
create type public.risk_event_type as enum (
  'BASELINE_ESTABLISHED',
  'BASELINE_UPDATED',
  'PERSONAL_DEVIATION',
  'TREND_DETECTED',
  'DETERIORATION_PREDICTED',
  'THRESHOLD_ALERT',
  'EMERGENCY_RAISED',
  'EMERGENCY_RESOLVED',
  'RECOVERY'
);

create table public.risk_events (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.patient_profiles (id) on delete cascade,

  risk_type    public.risk_event_type not null,
  severity     public.alert_severity not null default 'INFO',

  -- One sentence a person reads. Carries its own numbers by convention, so a
  -- timeline entry is checkable without opening anything.
  explanation  text not null,

  -- What produced it: contributing measurements, slopes, baseline references.
  -- Stored with the event rather than recomputed, for the same reason the risk
  -- explanations are — a later engine version would produce different numbers,
  -- and the timeline would silently rewrite its own history.
  evidence     jsonb not null default '{}'::jsonb,

  -- Optional links to the rows this event is about.
  baseline_id  uuid references public.patient_baselines (id) on delete set null,
  trend_id     uuid references public.health_trends (id) on delete set null,

  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),

  constraint risk_event_explanation_not_blank
    check (char_length(btrim(explanation)) between 1 and 600),
  constraint risk_event_evidence_is_object
    check (jsonb_typeof(evidence) = 'object')
);

comment on table public.risk_events is
  'The patient story, in sequence. Distinct from emergency_events: most risk events need no response, they need to be readable in order.';

create index risk_events_timeline_idx
  on public.risk_events (patient_id, occurred_at desc);

alter table public.risk_events enable row level security;

create policy "Patients read their own risk timeline"
  on public.risk_events for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Care team reads assigned risk timeline"
  on public.risk_events for select
  to authenticated
  using ( private.can_see_patient_vitals(patient_id) );

grant select on public.risk_events to authenticated;
grant select, insert on public.risk_events to service_role;
grant usage, select on all sequences in schema public to service_role;

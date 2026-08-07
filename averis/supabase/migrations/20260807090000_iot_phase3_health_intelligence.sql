-- ===========================================================================
-- AVERIS IoT — Phase 3: health intelligence over the sensor stream
--
-- Extends rather than duplicates. `health_predictions` already exists from the
-- document-ML phase with exactly the columns this phase needs — risk score,
-- category, model version, jsonb explanation, confidence. A second table with
-- the same shape would mean two places to query for "this patient's risk", two
-- retention policies, and two chances to show a patient a number the other
-- table disagrees with.
--
-- ⚠ DO NOT REFERENCE THE NEW ENUM VALUES ANYWHERE ELSE IN THIS FILE.
--
-- `prediction_type` and `risk_category` were created in an earlier migration,
-- and Postgres refuses to *use* a value added to a pre-existing enum inside the
-- same transaction. Nothing below mentions them, which is why this is safe. It
-- breaks the moment a policy or default does — and it breaks only when applied
-- as one transaction, so statement-by-statement local testing would pass while
-- the Supabase SQL editor, which wraps a paste, would not.
-- ===========================================================================

-- Sensor-derived risk, distinct from the document-derived kinds.
alter type public.prediction_type add value if not exists 'VITAL_DETERIORATION';

-- The brief asks for LOW / MEDIUM / HIGH / CRITICAL. LOW and HIGH already
-- exist; MODERATE is this schema's spelling of MEDIUM and is reused rather than
-- duplicated, because two values meaning the same band would eventually be
-- written by two different call sites. Only CRITICAL is genuinely new.
alter type public.risk_category add value if not exists 'CRITICAL';

-- ---------------------------------------------------------------------------
-- Raw inertial data
--
-- Fall detection needs what an MPU6050 actually produces. `movement_status` is
-- a label — something already decided — and a model trained on it would only
-- ever learn to agree with whatever produced the label.
--
-- All nullable: a pulse oximeter has no accelerometer, and every reading
-- already stored predates these columns. A NOT NULL here would have made this
-- migration unappliable to a table with rows in it.
-- ---------------------------------------------------------------------------
alter table public.sensor_readings
  add column if not exists accel_x numeric(6,3),
  add column if not exists accel_y numeric(6,3),
  add column if not exists accel_z numeric(6,3),
  add column if not exists gyro_x  numeric(7,2),
  add column if not exists gyro_y  numeric(7,2),
  add column if not exists gyro_z  numeric(7,2);

comment on column public.sensor_readings.accel_x is
  'Acceleration in g. Nullable — most devices have no IMU.';

-- Physically possible ranges for a consumer IMU. An MPU6050 saturates at ±16g
-- and ±2000°/s; a value beyond that is a wiring or scaling fault, and storing
-- it would train the fall model on nonsense.
alter table public.sensor_readings
  add constraint sensor_readings_accel_plausible check (
    (accel_x is null or accel_x between -16 and 16) and
    (accel_y is null or accel_y between -16 and 16) and
    (accel_z is null or accel_z between -16 and 16)
  ),
  add constraint sensor_readings_gyro_plausible check (
    (gyro_x is null or gyro_x between -2000 and 2000) and
    (gyro_y is null or gyro_y between -2000 and 2000) and
    (gyro_z is null or gyro_z between -2000 and 2000)
  );

-- ---------------------------------------------------------------------------
-- ai_insights — observations about the stream
--
-- Separate from `alerts`, and the distinction is not cosmetic.
--
-- An alert says a threshold was crossed *now*: one reading, one number, one
-- comparison. An insight says something about a *pattern over time* — "SpO2 has
-- fallen across the last fifteen minutes". They have different evidence,
-- different lifetimes, and different consequences for a reader, and collapsing
-- them into one table would mean a trend observation competing for attention
-- with a momentary threshold crossing.
-- ---------------------------------------------------------------------------
create type public.insight_kind as enum (
  'TREND_DECLINE',
  'TREND_RISE',
  'ANOMALY',
  'PATTERN_CORRELATION',
  'STABILITY',
  'DATA_GAP'
);

create table public.ai_insights (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.patient_profiles (id) on delete cascade,
  device_id    uuid references public.iot_devices (id) on delete set null,

  insight_type public.insight_kind not null,
  message      text not null,
  severity     public.alert_severity not null default 'INFO',

  -- What the observation was computed from: the window, the values at each
  -- end, the slope. An insight a patient cannot trace to numbers is
  -- indistinguishable from the system guessing.
  evidence     jsonb not null default '{}'::jsonb,

  -- How much of the window actually carried data. A trend drawn through three
  -- readings in fifteen minutes is a different claim from one drawn through
  -- four hundred, and the reader deserves to know which they are looking at.
  confidence   numeric(4,3),

  window_start timestamptz,
  window_end   timestamptz,
  created_at   timestamptz not null default now(),

  constraint ai_insights_message_not_blank
    check (char_length(btrim(message)) between 1 and 600),
  constraint ai_insights_confidence_range
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint ai_insights_evidence_is_object
    check (jsonb_typeof(evidence) = 'object'),
  constraint ai_insights_window_ordered
    check (window_start is null or window_end is null or window_end >= window_start)
);

comment on table public.ai_insights is
  'Observations about patterns over time. Distinct from alerts, which are momentary threshold crossings.';

create index ai_insights_patient_idx on public.ai_insights (patient_id, created_at desc);
create index ai_insights_type_idx on public.ai_insights (patient_id, insight_type, created_at desc);

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.ai_insights enable row level security;

-- Read-only for patients. An insight a patient could author is not an
-- observation about them, and one they could edit is not evidence of anything.
create policy "Patients read own insights"
  on public.ai_insights for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- No INSERT, UPDATE or DELETE policy: insights are generated by the engine,
-- which runs as the service role.

grant select on public.ai_insights to authenticated;

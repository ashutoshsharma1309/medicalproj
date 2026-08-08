-- ===========================================================================
-- AVERIS IoT — Phase 5: real hardware
--
-- The wire contract does not change. It was written in Phase 1 against the
-- payload an ESP32 would send, the simulator has been speaking it since, and
-- the firmware added in this phase sends the same bytes. Nothing here alters
-- `sensor_readings`, which is the point: the pipeline that carried simulated
-- readings carries measured ones without a branch.
--
-- What this migration adds is the ability to answer questions about the
-- *device* rather than the patient:
--
--   · which sensor is broken, not just "no readings"
--   · how far the band is from the access point
--   · how long a reading took to arrive
--   · and — the one that matters most — **whether the numbers on this chart
--     came from a person or from a simulator**
--
-- ── The provenance column is not bookkeeping ───────────────────────────────
--
-- `iot_devices.is_simulated` exists because AVERIS is about to hold two kinds
-- of data that look identical in the table and mean completely different
-- things. A clinician reading a chart, an AI engine computing a risk score,
-- and an auditor asking what a decision was based on all need to be able to
-- tell them apart — and after the fact, from the row, not from whoever
-- remembers which band was on the bench that week.
--
-- It defaults to false and is set at registration. A device that was ever
-- simulated stays flagged: unflagging it would rewrite the provenance of every
-- reading it has already produced.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Device telemetry
--
-- Current state, on the device row, updated by the same touch the ingest path
-- already does. Deliberately not a time-series table: a band reports every two
-- seconds, and a row per uplink would be a second sensor_readings-sized table
-- holding facts nobody reads twice. The one time-series question that matters
-- — "was it reporting at 3am?" — is already answerable from sensor_readings.
-- ---------------------------------------------------------------------------
alter table public.iot_devices
  add column if not exists is_simulated boolean not null default false,
  add column if not exists signal_strength_dbm smallint,
  add column if not exists uptime_seconds integer,
  add column if not exists boot_count integer,
  add column if not exists hardware_revision text,
  add column if not exists transport text,
  -- Per-sensor state: {"pulse":"ok","thermometer":"absent","imu":"no_contact"}.
  -- jsonb rather than columns because the sensor set is a property of the
  -- hardware revision, and a chest strap with an ECG lead should not require a
  -- migration to report itself.
  add column if not exists sensor_health jsonb not null default '{}'::jsonb,
  -- Milliseconds between the device's own timestamp and arrival. Includes
  -- clock skew, which is why the dashboard shows it as an indicator and never
  -- as a measurement — a band whose clock is 40 seconds fast reports negative
  -- latency, and that is information too.
  add column if not exists last_latency_ms integer,
  -- Readings the band is holding because it could not deliver them.
  add column if not exists buffered_readings smallint,
  add column if not exists last_boot_at timestamptz;

comment on column public.iot_devices.is_simulated is
  'True when readings come from the simulator. Provenance, not bookkeeping: it is how anyone tells measured data from generated data after the fact.';

comment on column public.iot_devices.sensor_health is
  'Per-sensor state from the firmware. Turns "device offline" into "the MAX30102 is not answering".';

alter table public.iot_devices
  add constraint iot_devices_sensor_health_is_object
    check (jsonb_typeof(sensor_health) = 'object'),
  add constraint iot_devices_signal_plausible
    check (signal_strength_dbm is null or signal_strength_dbm between -120 and 0),
  add constraint iot_devices_transport_known
    check (transport is null or transport in ('wifi', 'wifi_buffered', 'ble', 'simulator'));

-- Finding the bands that need attention, without scanning the fleet.
create index if not exists iot_devices_hardware_idx
  on public.iot_devices (patient_id, connection_status)
  where connection_status <> 'RETIRED';

-- ---------------------------------------------------------------------------
-- Readings carry their own provenance
--
-- The device row says whether a band is a simulator *today*. This column says
-- what produced this particular reading, which is a different question the
-- moment a device is re-registered, a simulator is pointed at a real device's
-- token during testing, or a band is retired and its key reused.
--
-- Denormalised on purpose. The alternative — joining to iot_devices at read
-- time — answers "is that device simulated now", and a chart drawn in March
-- must not change meaning because of something done to a device in June.
-- ---------------------------------------------------------------------------
alter table public.sensor_readings
  add column if not exists is_simulated boolean not null default false;

comment on column public.sensor_readings.is_simulated is
  'Provenance of this reading, fixed at write time. A chart drawn today must not change meaning because a device was reclassified later.';

-- Partial, because the interesting query is "show me the simulated ones" on a
-- table that is overwhelmingly not simulated in production.
create index if not exists sensor_readings_simulated_idx
  on public.sensor_readings (patient_id, recorded_at desc)
  where is_simulated;

-- ---------------------------------------------------------------------------
-- device_events
--
-- The band's own history: boots, sensor faults, token rejections, buffer
-- overruns. Bounded and low-volume by construction — an event is written when
-- something *changes*, never per uplink.
--
-- This is what the engineering dashboard reads. Without it, diagnosing a band
-- means asking the wearer what the screen said.
-- ---------------------------------------------------------------------------
create type public.device_event_kind as enum (
  'BOOT',
  'SENSOR_FAULT',
  'SENSOR_RECOVERED',
  'AUTH_REJECTED',
  'BUFFER_OVERFLOW',
  'LOW_BATTERY',
  'FIRMWARE_CHANGED',
  'WENT_OFFLINE',
  'CAME_ONLINE'
);

create table public.device_events (
  id         bigint generated always as identity primary key,
  device_id  uuid not null references public.iot_devices (id) on delete cascade,
  patient_id uuid not null references public.patient_profiles (id) on delete cascade,

  kind       public.device_event_kind not null,
  detail     text,
  metadata   jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),

  constraint device_events_detail_length
    check (detail is null or char_length(detail) <= 500),
  constraint device_events_metadata_is_object
    check (jsonb_typeof(metadata) = 'object')
);

comment on table public.device_events is
  'What the band did, as opposed to what it measured. Written on change, never per uplink.';

create index device_events_device_idx
  on public.device_events (device_id, created_at desc);

alter table public.device_events enable row level security;

-- The same reach as the readings themselves: the patient, and anyone the
-- patient has given access to who may already see vitals. A caregiver holding
-- VIEW_ALERTS does not need to know which I²C address stopped answering.
create policy "Patients read their own device events"
  on public.device_events for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Care team reads assigned device events"
  on public.device_events for select
  to authenticated
  using ( private.can_see_patient_vitals(patient_id) );

-- No INSERT for any client role. These are written by the ingest service,
-- which is the only thing that knows what the hardware actually did — a
-- browser that could write here could fabricate a band's history.
grant select on public.device_events to authenticated;
grant select, insert on public.device_events to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- resolve_device now carries provenance
--
-- The ingest service stamps every reading with `is_simulated`, and it must read
-- that from the device row rather than from the payload — for exactly the
-- reason `patient_id` is read from the device row. A simulator that could
-- declare itself real would defeat the flag's only purpose.
--
-- Replaced rather than added beside: two lookup functions is two chances for
-- one to be granted where the other is not.
--
-- The return type changes, so the old signature is dropped first. This is safe
-- here because exactly one caller exists (`iot-service/app/store.py`) and it is
-- deployed with this migration; a function with more callers would need the
-- column added to a new name instead.
-- ---------------------------------------------------------------------------
drop function if exists private.resolve_device(text);

create function private.resolve_device(p_token_hash text)
returns table (
  device_id    uuid,
  patient_id   uuid,
  device_key   text,
  device_name  text,
  status       public.connection_status,
  is_simulated boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.patient_id, d.device_key, d.device_name,
         d.connection_status, d.is_simulated
  from public.iot_devices d
  where d.token_hash = p_token_hash
    -- A retired device must not be able to resume writing.
    and d.connection_status <> 'RETIRED';
$$;

comment on function private.resolve_device is
  'Turns a device token hash into its identity, owner and provenance. Not callable by any client role.';

revoke all on function private.resolve_device(text) from public;
grant execute on function private.resolve_device(text) to service_role;

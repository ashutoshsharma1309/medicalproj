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

-- ===========================================================================
-- AVERIS IoT — Phase 9: sensor calibration
--
-- Records how a specific band compares against a reference instrument, so that
-- "this unit reads 2% low" is a fact about a serial number rather than a
-- recollection.
--
-- ── Why a table and not a config value ─────────────────────────────────────
--
-- The tempting design is a per-device offset column that the ingest service
-- adds to incoming readings. That is wrong for a reason worth writing down:
-- correcting a reading in flight destroys the evidence. Once the band's raw
-- output is gone, nobody can tell a sensor that has drifted from a correction
-- that was mis-entered, and the stored series is a mix of measured and adjusted
-- values with no marker saying which is which.
--
-- So calibration is **recorded, never applied**. The raw reading is what gets
-- stored, and the calibration record sits beside it as context a clinician or
-- an engineer can consult. If a unit is far enough out to need correcting, the
-- answer is to fix or retire the unit.
--
-- ── What this table deliberately does not have ─────────────────────────────
--
-- No `accuracy` column, and no pass/fail flag stored as truth. The same
-- reasoning as `model_drift_reports` in Phase 8: establishing that a pulse
-- oximeter is *accurate* requires a controlled desaturation study against
-- arterial blood gas, which AVERIS cannot run. What is stored is agreement with
-- a named reference instrument, under named conditions — a measurement, not a
-- verdict. `lib/calibration/agreement.ts` derives a usability judgement from it
-- at read time and labels it as such.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- calibration_sessions
--
-- One sitting: one band, one channel, one reference instrument.
--
-- The statistics are stored computed rather than derived on read. A session is
-- a historical record of what was measured on a day, and recomputing it later
-- with different code would silently change what the record says. Same
-- principle as keeping a superseded baseline: the figure a decision was made on
-- must stay readable.
-- ---------------------------------------------------------------------------
-- A composite key on iot_devices, so calibration can reference the device *and*
-- its owner together. `id` is already the primary key, so this costs one index
-- and buys the foreign key below.
alter table public.iot_devices
  add constraint iot_devices_id_patient_unique unique (id, patient_id);

create table public.calibration_sessions (
  id              uuid primary key default gen_random_uuid(),

  -- Referenced as a pair, not as two independent foreign keys.
  --
  -- This was found by an assertion rather than by design. With separate
  -- references, a patient could insert a calibration session pointing at
  -- somebody else's device while claiming their own patient_id: the policy's
  -- with-check passes, because it only inspects patient_id, and each foreign
  -- key is satisfied on its own. The result is a calibration record attached to
  -- a device its author does not own — not a disclosure, since the row is
  -- filtered to its author on read, but a corruption of the one thing this
  -- table is for, which is knowing which physical unit reads how.
  --
  -- The composite reference makes the pairing a matter of referential integrity
  -- rather than of every future policy remembering to check it.
  device_id       uuid not null,
  patient_id      uuid not null references public.patient_profiles (id) on delete cascade,

  constraint calibration_device_belongs_to_patient
    foreign key (device_id, patient_id)
    references public.iot_devices (id, patient_id)
    on delete cascade,

  channel         text not null,

  -- The reference, named. "A commercial pulse oximeter" is not a reference; a
  -- reference has a make, a model, and a specification of its own error, and
  -- without it the comparison cannot be interpreted at all.
  reference_instrument text not null,
  reference_accuracy   text,

  -- What the readings were taken under. Perfusion, movement, ambient light and
  -- skin temperature change what these sensors report, and a comparison with no
  -- record of conditions cannot be reproduced or disputed.
  conditions      text,

  -- Computed by lib/calibration/agreement.ts at the time of the session.
  pair_count      integer not null default 0,
  bias            numeric(8, 3),
  sd              numeric(8, 3),
  loa_lower       numeric(8, 3),
  loa_upper       numeric(8, 3),
  rms             numeric(8, 3),
  max_abs_difference numeric(8, 3),
  proportional_bias_slope numeric(10, 5),

  -- Null until there are enough pairs. Deliberately nullable rather than
  -- defaulting to false: "not enough data" and "failed" are different, and
  -- collapsing them records an unverified unit as a rejected one.
  meets_bench_bounds boolean,

  notes           text,

  performed_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint calibration_channel_known
    check (channel in ('heart_rate', 'spo2', 'temperature')),
  constraint calibration_pair_count_not_negative
    check (pair_count >= 0),
  constraint calibration_reference_named
    check (char_length(btrim(reference_instrument)) between 3 and 200),
  -- Limits of agreement bracket the bias by construction. A row where they do
  -- not is a row written by something that computed them wrongly.
  constraint calibration_loa_brackets_bias
    check (
      bias is null or loa_lower is null or loa_upper is null
      or (loa_lower <= bias and bias <= loa_upper)
    ),
  -- Below the minimum pair count no verdict may be recorded at all.
  constraint calibration_no_verdict_without_data
    check (meets_bench_bounds is null or pair_count >= 20)
);

comment on table public.calibration_sessions is
  'Agreement between one band and a named reference instrument. Recorded, never applied to readings — correcting a reading in flight destroys the evidence that it was corrected.';

create index calibration_sessions_device_idx
  on public.calibration_sessions (device_id, performed_at desc);

create index calibration_sessions_patient_idx
  on public.calibration_sessions (patient_id, performed_at desc);

create trigger calibration_sessions_set_updated_at
  before update on public.calibration_sessions
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- calibration_pairs
--
-- The individual simultaneous measurements. Kept rather than discarded once the
-- statistics are computed: a Bland–Altman plot needs the points, and a session
-- whose underlying data is gone cannot be re-examined when somebody disputes
-- the conclusion.
-- ---------------------------------------------------------------------------
create table public.calibration_pairs (
  id              bigint generated always as identity primary key,

  session_id      uuid not null references public.calibration_sessions (id) on delete cascade,

  device_value    numeric(8, 2) not null,
  reference_value numeric(8, 2) not null,

  -- Per-pair, because conditions change during a sitting — the subject moves,
  -- a finger warms up — and the pair that disagreed most is usually the one
  -- with a note against it.
  conditions      text,

  recorded_at     timestamptz not null default now()
);

create index calibration_pairs_session_idx
  on public.calibration_pairs (session_id, recorded_at);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Calibration is scoped to device ownership, which is already the boundary for
-- everything else about a device.
-- ---------------------------------------------------------------------------
alter table public.calibration_sessions enable row level security;
alter table public.calibration_pairs enable row level security;

create policy "Patients read calibration for own devices"
  on public.calibration_sessions for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Patients record calibration for own devices"
  on public.calibration_sessions for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients update own calibration sessions"
  on public.calibration_sessions for update
  to authenticated
  using ( patient_id = private.current_patient_profile_id() )
  with check ( patient_id = private.current_patient_profile_id() );

-- No delete policy. A calibration record is evidence about a device, and a
-- device that reads badly is exactly the case where deleting the record is
-- tempting.

-- The pair policies go through the session rather than carrying their own
-- patient_id.
--
-- `private.owns_calibration_session` is a SECURITY DEFINER function rather than
-- an inline `exists`, and that is not a style preference: an inline subquery in
-- a policy is itself evaluated under the querying role's permissions on the
-- referenced table, so it can deny access the policy means to grant. That
-- misconception cost two defects in Phase 4 and the fix is this shape.
create or replace function private.owns_calibration_session(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.calibration_sessions s
    where s.id = p_session_id
      and s.patient_id = private.current_patient_profile_id()
  );
$$;

-- Revoked from PUBLIC, then granted back to the one role whose policies call
-- it. Omitting the grant leaves a policy that cannot execute its own predicate,
-- and the symptom is "permission denied for function" on a plain SELECT — which
-- reads like a bug in the table, not in the helper.
revoke all on function private.owns_calibration_session(uuid) from public;
grant execute on function private.owns_calibration_session(uuid) to authenticated;
grant execute on function private.owns_calibration_session(uuid) to service_role;

create policy "Patients read pairs for own sessions"
  on public.calibration_pairs for select
  to authenticated
  using ( private.owns_calibration_session(session_id) );

create policy "Patients record pairs for own sessions"
  on public.calibration_pairs for insert
  to authenticated
  with check ( private.owns_calibration_session(session_id) );

grant select, insert, update on public.calibration_sessions to authenticated;
grant select, insert on public.calibration_pairs to authenticated;
grant usage, select on sequence public.calibration_pairs_id_seq to authenticated;

grant select, insert, update on public.calibration_sessions to service_role;
grant select, insert on public.calibration_pairs to service_role;
grant usage, select on sequence public.calibration_pairs_id_seq to service_role;

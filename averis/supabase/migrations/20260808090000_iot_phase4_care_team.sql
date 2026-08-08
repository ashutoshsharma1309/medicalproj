-- ===========================================================================
-- AVERIS IoT — Phase 4: care team, and the first time anyone reads another
-- person's health record
--
-- Every policy in the first eight migrations means the same thing: "your own
-- data". 66 policies, all built on private.current_patient_profile_id(). This
-- migration is the first that lets one user read another's chart, which makes
-- it the highest-risk change in the project.
--
-- ── The two decisions that make it safe ─────────────────────────────────────
--
-- **1. Additive policies. Nothing existing is modified.**
--
-- Postgres ORs multiple permissive policies together, so a new "doctors read
-- assigned patients" policy sits beside the untouched "patients read their own"
-- policy. The consequence matters: this migration *cannot* narrow or break
-- patient self-access, because it does not touch those policies at all. The
-- only failure mode left is a doctor policy that is too broad — one thing to
-- get right instead of sixty-six.
--
-- The alternative — rewriting each policy into a combined predicate — would put
-- every patient's existing access at risk to add a feature for doctors.
--
-- **2. One helper owns the access rule.**
--
-- private.can_access_patient() is the single place the question "may this user
-- see this patient?" is answered. Every new policy calls it and none reimplement
-- it, so the rule cannot drift between tables. Sixty-six inlined predicates
-- would be sixty-six chances to forget the revocation check.
--
-- It is SECURITY DEFINER and lives in `private` for a reason beyond privilege:
-- a policy on patient_doctor_assignments that queried patient_doctor_assignments
-- would recurse until the connection died.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.assignment_status as enum ('ACTIVE', 'PENDING', 'REVOKED');

create type public.caregiver_permission as enum ('VIEW_ALERTS', 'VIEW_VITALS', 'FULL');

create type public.emergency_type as enum (
  'FALL_DETECTED',
  'SEVERE_HYPOXIA',
  'EXTREME_HEART_RATE',
  'RAPID_DETERIORATION',
  'DEVICE_LOST',
  'MANUAL_ESCALATION'
);

create type public.emergency_status as enum (
  'NEW',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'RESOLVED',
  'DISMISSED'
);

create type public.detected_by as enum ('RULE_ENGINE', 'AI_ENGINE', 'PATIENT', 'CLINICIAN');

-- ---------------------------------------------------------------------------
-- doctors
-- ---------------------------------------------------------------------------
create table public.doctors (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null unique references public.users (id) on delete cascade,
  full_name      text not null,
  specialization text,
  hospital_name  text,
  -- Unique because two clinicians sharing a licence number is either a data
  -- entry error or an impersonation, and both should fail loudly.
  license_number text not null unique,
  verified_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint doctors_name_not_blank
    check (char_length(btrim(full_name)) between 1 and 200),
  constraint doctors_license_not_blank
    check (char_length(btrim(license_number)) between 3 and 60)
);

comment on table public.doctors is
  'Clinician profiles. Being listed here grants nothing on its own — access comes from an assignment.';

create index doctors_user_idx on public.doctors (user_id);

create trigger doctors_set_updated_at
  before update on public.doctors
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- patient_doctor_assignments
--
-- The row that grants access. Status is the revocation mechanism: a doctor who
-- stops treating a patient is set to REVOKED and loses access on the next
-- query, with the row kept so the audit trail still explains why they could
-- read that chart last month.
-- ---------------------------------------------------------------------------
create table public.patient_doctor_assignments (
  id          uuid primary key default gen_random_uuid(),
  patient_id  uuid not null references public.patient_profiles (id) on delete cascade,
  doctor_id   uuid not null references public.doctors (id) on delete cascade,
  status      public.assignment_status not null default 'PENDING',
  assigned_at timestamptz not null default now(),
  revoked_at  timestamptz,
  -- Who created it. An assignment nobody is accountable for is one nobody can
  -- be asked about.
  assigned_by uuid references public.users (id) on delete set null,
  note        text,

  constraint patient_doctor_unique unique (patient_id, doctor_id),
  constraint patient_doctor_revoked_consistent
    check ((status = 'REVOKED') = (revoked_at is not null))
);

comment on table public.patient_doctor_assignments is
  'Grants a doctor access to one patient. REVOKED rows are kept so past access stays explicable.';

create index patient_doctor_active_idx
  on public.patient_doctor_assignments (doctor_id, patient_id)
  where status = 'ACTIVE';

create index patient_doctor_patient_idx
  on public.patient_doctor_assignments (patient_id);

-- ---------------------------------------------------------------------------
-- patient_caregiver_assignments
--
-- Deliberately narrower than a doctor's. A family member watching for
-- emergencies does not need the full medical record, and `permission_level`
-- makes "can see alerts" and "can see everything" different grants rather than
-- the same one with a different label.
-- ---------------------------------------------------------------------------
create table public.patient_caregiver_assignments (
  id               uuid primary key default gen_random_uuid(),
  patient_id       uuid not null references public.patient_profiles (id) on delete cascade,
  caregiver_id     uuid not null references public.users (id) on delete cascade,
  relationship     text,
  permission_level public.caregiver_permission not null default 'VIEW_ALERTS',
  status           public.assignment_status not null default 'PENDING',
  assigned_at      timestamptz not null default now(),
  revoked_at       timestamptz,

  constraint patient_caregiver_unique unique (patient_id, caregiver_id),
  constraint patient_caregiver_revoked_consistent
    check ((status = 'REVOKED') = (revoked_at is not null))
);

create index patient_caregiver_active_idx
  on public.patient_caregiver_assignments (caregiver_id, patient_id)
  where status = 'ACTIVE';

create index patient_caregiver_patient_idx
  on public.patient_caregiver_assignments (patient_id);

-- ---------------------------------------------------------------------------
-- emergency_events
-- ---------------------------------------------------------------------------
create table public.emergency_events (
  id            uuid primary key default gen_random_uuid(),
  patient_id    uuid not null references public.patient_profiles (id) on delete cascade,
  device_id     uuid references public.iot_devices (id) on delete set null,
  alert_id      uuid references public.alerts (id) on delete set null,

  event_type    public.emergency_type not null,
  severity      public.alert_severity not null default 'CRITICAL',
  detected_by   public.detected_by not null default 'RULE_ENGINE',
  status        public.emergency_status not null default 'NEW',

  summary       text not null,
  -- What the engine saw. An emergency a clinician cannot trace to numbers is
  -- one they have to take on trust at the worst possible moment.
  evidence      jsonb not null default '{}'::jsonb,

  acknowledged_by uuid references public.users (id) on delete set null,
  acknowledged_at timestamptz,
  resolved_by     uuid references public.users (id) on delete set null,
  resolved_at     timestamptz,
  resolution_note text,

  created_at    timestamptz not null default now(),

  constraint emergency_summary_not_blank
    check (char_length(btrim(summary)) between 1 and 600),
  constraint emergency_evidence_is_object
    check (jsonb_typeof(evidence) = 'object'),
  -- A resolved event must say who resolved it. "Resolved by nobody" is how an
  -- emergency gets closed without anyone having looked at the patient.
  constraint emergency_resolution_attributed
    check ((status <> 'RESOLVED') or (resolved_by is not null and resolved_at is not null)),
  constraint emergency_acknowledgement_attributed
    check ((acknowledged_at is null) = (acknowledged_by is null))
);

comment on table public.emergency_events is
  'Escalations requiring a human response. Resolution must name the person who resolved it.';

create index emergency_open_idx
  on public.emergency_events (patient_id, created_at desc)
  where status in ('NEW', 'ACKNOWLEDGED', 'IN_PROGRESS');

create index emergency_patient_idx on public.emergency_events (patient_id, created_at desc);

-- One open event per patient per type. Without this, a device sitting below
-- the SpO2 threshold would raise an emergency every two seconds, and the
-- resulting queue would be unusable at exactly the moment it mattered.
create unique index emergency_one_open_per_type
  on public.emergency_events (patient_id, event_type)
  where status in ('NEW', 'ACKNOWLEDGED', 'IN_PROGRESS');

-- ===========================================================================
-- The access rule — one function, called by every new policy
-- ===========================================================================
create or replace function private.current_doctor_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id
  from public.doctors d
  join public.users u on u.id = d.user_id
  where u.auth_user_id = (select auth.uid());
$$;

/**
 * May the signed-in user read this patient's data?
 *
 * The single source of truth. Every policy added below calls this and none
 * reimplement it, so the rule cannot drift from table to table — and the
 * revocation check exists in exactly one place rather than sixty-six.
 *
 * SECURITY DEFINER because a policy on patient_doctor_assignments that queried
 * patient_doctor_assignments would recurse forever. It reads only the calling
 * user's own identity from auth.uid() and takes no privileged input, so it
 * cannot be used to widen access by passing a different argument.
 */
create or replace function private.can_access_patient(p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    -- The patient themselves. Listed first because it is the common case.
    p_patient_id = private.current_patient_profile_id()

    -- An assigned doctor. PENDING is not enough: an assignment that has been
    -- proposed but not accepted grants nothing.
    or exists (
      select 1
      from public.patient_doctor_assignments a
      where a.patient_id = p_patient_id
        and a.doctor_id = private.current_doctor_id()
        and a.status = 'ACTIVE'
    )

    -- A caregiver with full access. VIEW_ALERTS and VIEW_VITALS are narrower
    -- and are checked by the specific policies that grant them, so that a
    -- caregiver who may see alerts does not thereby see the medical record.
    or exists (
      select 1
      from public.patient_caregiver_assignments c
      join public.users u on u.id = c.caregiver_id
      where c.patient_id = p_patient_id
        and u.auth_user_id = (select auth.uid())
        and c.status = 'ACTIVE'
        and c.permission_level = 'FULL'
    );
$$;

/** Whether a caregiver may see this patient's alerts and emergencies. */
create or replace function private.can_see_patient_alerts(p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    private.can_access_patient(p_patient_id)
    or exists (
      select 1
      from public.patient_caregiver_assignments c
      join public.users u on u.id = c.caregiver_id
      where c.patient_id = p_patient_id
        and u.auth_user_id = (select auth.uid())
        and c.status = 'ACTIVE'
        and c.permission_level in ('VIEW_ALERTS', 'VIEW_VITALS', 'FULL')
    );
$$;

/** Whether a caregiver may see live vitals — narrower than the full record. */
create or replace function private.can_see_patient_vitals(p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    private.can_access_patient(p_patient_id)
    or exists (
      select 1
      from public.patient_caregiver_assignments c
      join public.users u on u.id = c.caregiver_id
      where c.patient_id = p_patient_id
        and u.auth_user_id = (select auth.uid())
        and c.status = 'ACTIVE'
        and c.permission_level in ('VIEW_VITALS', 'FULL')
    );
$$;

revoke all on function private.current_doctor_id() from public;
revoke all on function private.can_access_patient(uuid) from public;
revoke all on function private.can_see_patient_alerts(uuid) from public;
revoke all on function private.can_see_patient_vitals(uuid) from public;

grant execute on function private.current_doctor_id() to authenticated;
grant execute on function private.can_access_patient(uuid) to authenticated;
grant execute on function private.can_see_patient_alerts(uuid) to authenticated;
grant execute on function private.can_see_patient_vitals(uuid) to authenticated;

-- ===========================================================================
-- RLS on the new tables
-- ===========================================================================
alter table public.doctors                       enable row level security;
alter table public.patient_doctor_assignments    enable row level security;
alter table public.patient_caregiver_assignments enable row level security;
alter table public.emergency_events              enable row level security;

-- doctors ------------------------------------------------------------------
-- A doctor reads their own profile; a patient reads the profile of a doctor
-- assigned to them, so "who can see my record?" is answerable.
create policy "Doctors read own profile"
  on public.doctors for select
  to authenticated
  using ( user_id = private.current_app_user_id() );

create policy "Patients read their assigned doctors"
  on public.doctors for select
  to authenticated
  using (
    exists (
      select 1 from public.patient_doctor_assignments a
      where a.doctor_id = doctors.id
        and a.patient_id = private.current_patient_profile_id()
        and a.status = 'ACTIVE'
    )
  );

create policy "Doctors update own profile"
  on public.doctors for update
  to authenticated
  using ( user_id = private.current_app_user_id() )
  with check ( user_id = private.current_app_user_id() );

-- patient_doctor_assignments -----------------------------------------------
-- Both sides of the relationship can see it. A patient who cannot enumerate
-- who has access to their record cannot meaningfully consent to it.
create policy "Both parties read the assignment"
  on public.patient_doctor_assignments for select
  to authenticated
  using (
    patient_id = private.current_patient_profile_id()
    or doctor_id = private.current_doctor_id()
  );

-- The patient grants access, not the doctor. A clinician who could insert
-- their own assignment could read any chart by writing one row.
create policy "Patients assign their own doctors"
  on public.patient_doctor_assignments for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

-- Either side may revoke. A doctor declining an assignment and a patient
-- withdrawing consent are both legitimate, and neither should require support.
create policy "Both parties may revoke"
  on public.patient_doctor_assignments for update
  to authenticated
  using (
    patient_id = private.current_patient_profile_id()
    or doctor_id = private.current_doctor_id()
  )
  with check (
    patient_id = private.current_patient_profile_id()
    or doctor_id = private.current_doctor_id()
  );

-- patient_caregiver_assignments --------------------------------------------
create policy "Both parties read the caregiver assignment"
  on public.patient_caregiver_assignments for select
  to authenticated
  using (
    patient_id = private.current_patient_profile_id()
    or caregiver_id = private.current_app_user_id()
  );

create policy "Patients assign their own caregivers"
  on public.patient_caregiver_assignments for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients manage their caregivers"
  on public.patient_caregiver_assignments for update
  to authenticated
  using ( patient_id = private.current_patient_profile_id() )
  with check ( patient_id = private.current_patient_profile_id() );

-- emergency_events ---------------------------------------------------------
create policy "Care team reads emergencies"
  on public.emergency_events for select
  to authenticated
  using ( private.can_see_patient_alerts(patient_id) );

-- Only a clinician may change an emergency's status. A patient acknowledging
-- their own emergency would close the loop without anyone having looked at
-- them, which is the one outcome this workflow exists to prevent.
create policy "Assigned doctors manage emergencies"
  on public.emergency_events for update
  to authenticated
  using (
    exists (
      select 1 from public.patient_doctor_assignments a
      where a.patient_id = emergency_events.patient_id
        and a.doctor_id = private.current_doctor_id()
        and a.status = 'ACTIVE'
    )
  )
  with check (
    exists (
      select 1 from public.patient_doctor_assignments a
      where a.patient_id = emergency_events.patient_id
        and a.doctor_id = private.current_doctor_id()
        and a.status = 'ACTIVE'
    )
  );

-- No INSERT policy: emergencies are raised by the engine, which runs as the
-- service role. A user who could raise one could also raise a false one.

-- ===========================================================================
-- Care-team read access to existing patient data
--
-- Additive. Every policy below sits *beside* the untouched patient-self
-- policies, and Postgres ORs them — so nothing here can narrow what a patient
-- can already see about themselves.
-- ===========================================================================

create policy "Care team reads assigned patient profiles"
  on public.patient_profiles for select
  to authenticated
  using ( private.can_access_patient(id) );

create policy "Care team reads assigned health information"
  on public.patient_health_information for select
  to authenticated
  using ( private.can_access_patient(patient_id) );

-- Vitals: available to caregivers with VIEW_VITALS, which the medical record
-- below is not.
create policy "Care team reads assigned sensor readings"
  on public.sensor_readings for select
  to authenticated
  using ( private.can_see_patient_vitals(patient_id) );

create policy "Care team reads assigned devices"
  on public.iot_devices for select
  to authenticated
  using ( private.can_see_patient_vitals(patient_id) );

create policy "Care team reads assigned alerts"
  on public.alerts for select
  to authenticated
  using ( private.can_see_patient_alerts(patient_id) );

create policy "Assigned doctors acknowledge alerts"
  on public.alerts for update
  to authenticated
  using ( private.can_access_patient(patient_id) )
  with check ( private.can_access_patient(patient_id) );

-- The medical record proper. can_access_patient(), not the alert or vitals
-- helpers — a caregiver watching for emergencies has no business reading
-- someone's documents or conditions.
create policy "Care team reads assigned medical records"
  on public.patient_medical_records for select
  to authenticated
  using ( private.can_access_patient(patient_id) );

create policy "Care team reads assigned timeline"
  on public.patient_health_timeline for select
  to authenticated
  using ( private.can_access_patient(patient_id) );

create policy "Care team reads assigned conditions"
  on public.health_conditions for select
  to authenticated
  using ( private.can_access_patient(patient_id) );

create policy "Care team reads assigned medication history"
  on public.medication_history for select
  to authenticated
  using ( private.can_access_patient(patient_id) );

create policy "Care team reads assigned health insights"
  on public.health_insights for select
  to authenticated
  using ( private.can_access_patient(patient_id) );

create policy "Care team reads assigned AI insights"
  on public.ai_insights for select
  to authenticated
  using ( private.can_access_patient(patient_id) );

create policy "Care team reads assigned predictions"
  on public.health_predictions for select
  to authenticated
  using ( private.can_access_patient(patient_id) );

create policy "Care team reads assigned documents"
  on public.medical_documents for select
  to authenticated
  using ( private.can_access_patient(patient_id) );

-- Deliberately NOT extended to the care team:
--
--   ai_conversations   a patient's questions to AVERIS are theirs, and a
--                      doctor reading them would change what patients ask
--   audit_logs         the subject's own trail; a doctor reading it learns
--                      nothing clinical and gains a surveillance channel
--   notifications      addressed to the patient, not about them
--   subscriptions      billing, not health

-- ===========================================================================
-- Grants
-- ===========================================================================
grant select, insert, update on public.doctors                       to authenticated;
grant select, insert, update on public.patient_doctor_assignments    to authenticated;
grant select, insert, update on public.patient_caregiver_assignments to authenticated;
grant select, update         on public.emergency_events              to authenticated;

-- ---------------------------------------------------------------------------
-- Patient identity for the care team
--
-- Added after the fact, because the first version of this migration extended
-- read access to every clinical table and forgot the one holding the patient's
-- *name*. A doctor's caseload rendered as a list of UUIDs — clinically useless,
-- and exactly the kind of gap that only shows up when something tries to use
-- the data.
--
-- This exposes email alongside the name, which is more than strictly needed.
-- The alternative — a view projecting only the name — means a second object to
-- keep in step with users and its own RLS to get right, for a field a treating
-- clinician legitimately has. Recorded rather than hidden.
-- ---------------------------------------------------------------------------
create policy "Care team reads assigned patient identity"
  on public.users for select
  to authenticated
  using (
    exists (
      select 1 from public.patient_profiles p
      where p.user_id = users.id
        and private.can_see_patient_alerts(p.id)
    )
  );

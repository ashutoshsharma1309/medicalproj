-- ===========================================================================
-- AVERIS IoT — Phase 4b: getting the emergency to a person
--
-- The care-team migration made it *possible* for a doctor to read a patient's
-- chart. This one makes something arrive when it matters, and it is built
-- around one claim:
--
--   **Raising an emergency and telling the care team about it are one
--   transaction, or the system is lying.**
--
-- Split them and the failure mode is specific and silent: the event row lands,
-- the fan-out fails, and a clinician's queue shows an emergency that was never
-- announced to anyone. Nothing looks broken. The dashboard is correct. The
-- patient waits.
--
-- So `private.raise_emergency()` does both, and the ingest service calls that
-- one function instead of writing two tables and hoping.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Audit vocabulary
--
-- ⚠ DO NOT REFERENCE THESE NEW VALUES ANYWHERE ELSE IN THIS FILE.
--
-- `audit_action` and `audit_resource` were created back in the Phase 6
-- migration, and Postgres refuses to *use* a value added to a pre-existing
-- enum inside the same transaction. Nothing below mentions them; the
-- application code that writes these entries runs long after this file has
-- committed. Same trap as the CAREGIVER/ADMIN roles in Phase 1.
-- ---------------------------------------------------------------------------
alter type public.audit_action add value if not exists 'EMERGENCY_ACKNOWLEDGED';
alter type public.audit_action add value if not exists 'EMERGENCY_RESOLVED';
alter type public.audit_action add value if not exists 'CARE_TEAM_UPDATED';
alter type public.audit_action add value if not exists 'HEALTH_REPORT_GENERATED';

alter type public.audit_resource add value if not exists 'EMERGENCY';
alter type public.audit_resource add value if not exists 'REPORT';

-- ---------------------------------------------------------------------------
-- care_notifications
--
-- Addressed to a *user*, which is what separates this from `notifications`.
-- That table is a patient's own — "your report finished processing" — and is
-- keyed by patient_id. This one carries "someone you are responsible for needs
-- attention" and is keyed by recipient. Reusing the patient table would have
-- meant a doctor's inbox living under the patient's row, where the patient's
-- own RLS policy would hand it back to them.
--
-- No INSERT for any client role, for the same reason as `notifications`: a
-- browser that could write here could tell a doctor a patient had collapsed.
-- ---------------------------------------------------------------------------
create table public.care_notifications (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.users (id) on delete cascade,
  patient_id   uuid not null references public.patient_profiles (id) on delete cascade,
  emergency_id uuid references public.emergency_events (id) on delete cascade,

  severity     public.alert_severity not null default 'CRITICAL',
  title        text not null,
  body         text not null,
  /** Where it points. Role-dependent — see the fan-out in raise_emergency(). */
  href         text,

  read_at      timestamptz,
  created_at   timestamptz not null default now(),

  constraint care_notifications_title_not_blank
    check (char_length(btrim(title)) between 1 and 200),
  constraint care_notifications_body_not_blank
    check (char_length(btrim(body)) between 1 and 1000),
  -- The same relative-URL guard as public.notifications, including the
  -- negative lookahead: without it "//evil.example/x" passes, and a browser
  -- reads a protocol-relative URL as an external origin. One character is the
  -- difference between an internal link and an off-site redirect that a
  -- clinician has every reason to trust.
  constraint care_notifications_href_is_relative
    check (href is null or href ~ '^/(?![/\\])[A-Za-z0-9/_?=&.-]*$')
);

comment on table public.care_notifications is
  'Emergency notices addressed to a care team member. Readable and dismissable by the recipient; writable by no client role.';

create index care_notifications_recipient_idx
  on public.care_notifications (recipient_id, created_at desc);

create index care_notifications_unread_idx
  on public.care_notifications (recipient_id)
  where read_at is null;

-- One notice per person per emergency. The ingest service retries, and a
-- retried fan-out that produced a second notice would make a doctor check
-- whether it happened twice.
create unique index care_notifications_once_per_emergency
  on public.care_notifications (recipient_id, emergency_id)
  where emergency_id is not null;

alter table public.care_notifications enable row level security;

create policy "Recipients read their own notices"
  on public.care_notifications for select
  to authenticated
  using ( recipient_id = private.current_app_user_id() );

-- Dismissal. The WITH CHECK stops a notice being reassigned to someone else
-- while being marked read — the only UPDATE a recipient has any business
-- making is to read_at.
create policy "Recipients dismiss their own notices"
  on public.care_notifications for update
  to authenticated
  using ( recipient_id = private.current_app_user_id() )
  with check ( recipient_id = private.current_app_user_id() );

grant select, update on public.care_notifications to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
--
-- Guarded, because `supabase_realtime` is created by the Supabase platform and
-- does not exist in the plain Postgres the RLS suite runs against. An
-- unguarded ALTER PUBLICATION would fail every CI run to enable a feature CI
-- does not exercise.
--
-- Realtime respects RLS on the subscribing user's JWT, so a doctor's socket
-- receives only rows their SELECT policy already allows.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.care_notifications';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Who gets told
--
-- Every ACTIVE doctor, and every ACTIVE caregiver regardless of permission
-- level. VIEW_ALERTS is the narrowest grant there is and it exists precisely
-- for this: a family member who may not read the medical record still needs to
-- know the person collapsed.
-- ---------------------------------------------------------------------------
create or replace function private.care_team_recipients(p_patient_id uuid)
returns table (user_id uuid, care_role text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.user_id, 'DOCTOR'
  from public.patient_doctor_assignments a
  join public.doctors d on d.id = a.doctor_id
  where a.patient_id = p_patient_id
    and a.status = 'ACTIVE'

  union

  select c.caregiver_id, 'CAREGIVER'
  from public.patient_caregiver_assignments c
  where c.patient_id = p_patient_id
    and c.status = 'ACTIVE';
$$;

revoke all on function private.care_team_recipients(uuid) from public;
grant execute on function private.care_team_recipients(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- raise_emergency — the one call the ingest service makes
--
-- Insert and fan-out in a single transaction, so an emergency cannot exist
-- without the people responsible for it having been told.
--
-- Returns the event id, or NULL when an equivalent event is already open. The
-- NULL is not an error: it is the deduplication the partial unique index
-- enforces, reported back to the caller so it can stop rather than retry into
-- a constraint violation. A device sitting below the SpO2 threshold at 0.5 Hz
-- would otherwise raise one every two seconds, and 300 identical unanswered
-- emergencies is a queue nobody can triage at exactly the moment it matters.
--
-- The title comes from the caller rather than a CASE expression here. The
-- wording belongs to `lib/care/escalation.ts` and its Python port, and a third
-- copy in SQL would be the one that drifts.
--
-- SECURITY DEFINER because the caller is the ingest service, which has no
-- session and therefore no patient of its own. It takes a patient id as an
-- argument, which would be dangerous if it were reachable by `authenticated` —
-- so it is not granted to them. Only service_role may call it.
-- ---------------------------------------------------------------------------
create or replace function private.raise_emergency(
  p_patient_id  uuid,
  p_device_id   uuid,
  p_event_type  public.emergency_type,
  p_severity    public.alert_severity,
  p_detected_by public.detected_by,
  p_title       text,
  p_summary     text,
  p_evidence    jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id uuid;
begin
  insert into public.emergency_events
    (patient_id, device_id, event_type, severity, detected_by, summary, evidence)
  values
    (p_patient_id, p_device_id, p_event_type, p_severity, p_detected_by,
     p_summary, coalesce(p_evidence, '{}'::jsonb))
  -- Matches the partial unique index: one open event per patient per type.
  on conflict (patient_id, event_type)
    where status in ('NEW', 'ACKNOWLEDGED', 'IN_PROGRESS')
    do nothing
  returning id into v_event_id;

  -- Already open. The clinician has it; saying it again is noise.
  if v_event_id is null then
    return null;
  end if;

  insert into public.care_notifications
    (recipient_id, patient_id, emergency_id, severity, title, body, href)
  select
    r.user_id,
    p_patient_id,
    v_event_id,
    p_severity,
    p_title,
    p_summary,
    -- Role-dependent, because the two roles have different pages. A caregiver
    -- sent to /clinical would follow a link into a 404 during an emergency.
    case r.care_role
      when 'DOCTOR' then '/clinical/' || p_patient_id::text
      else '/care/' || p_patient_id::text
    end
  from private.care_team_recipients(p_patient_id) r
  on conflict do nothing;

  return v_event_id;
end;
$$;

revoke all on function private.raise_emergency(uuid, uuid, public.emergency_type, public.alert_severity, public.detected_by, text, text, jsonb) from public;
grant execute on function private.raise_emergency(uuid, uuid, public.emergency_type, public.alert_severity, public.detected_by, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- patient_health_reports
--
-- A generated summary, kept rather than regenerated on demand.
--
-- Two reasons it is stored. A report is a thing a clinician read at a moment
-- in time, and regenerating it next week against newer readings would produce
-- a different document under the same name. And the narration is a language
-- model's phrasing of assembled facts — if the model changes, what the
-- clinician actually saw must not.
--
-- `sections` holds the deterministic assembly; `summary` holds the phrasing.
-- Keeping both is what makes the narration checkable against its own inputs.
-- ---------------------------------------------------------------------------
create table public.patient_health_reports (
  id             uuid primary key default gen_random_uuid(),
  patient_id     uuid not null references public.patient_profiles (id) on delete cascade,
  generated_by   uuid references public.users (id) on delete set null,

  period_start   timestamptz not null,
  period_end     timestamptz not null,

  summary        text not null,
  sections       jsonb not null default '{}'::jsonb,
  /** The model that phrased it, or 'deterministic' when none was available. */
  generated_with text not null default 'deterministic',

  created_at     timestamptz not null default now(),

  constraint health_report_period_ordered check (period_end > period_start),
  constraint health_report_summary_not_blank
    check (char_length(btrim(summary)) between 1 and 8000),
  constraint health_report_sections_is_object
    check (jsonb_typeof(sections) = 'object')
);

comment on table public.patient_health_reports is
  'Generated patient summaries. Kept rather than regenerated so what a clinician read stays what they read.';

create index health_reports_patient_idx
  on public.patient_health_reports (patient_id, created_at desc);

alter table public.patient_health_reports enable row level security;

-- The patient can read reports written about them. A summary of someone's
-- health that they are not allowed to see is a summary written about them
-- rather than for their care.
create policy "Care team reads patient reports"
  on public.patient_health_reports for select
  to authenticated
  using ( private.can_access_patient(patient_id) );

-- Only an assigned clinician may write one, and only in their own name.
-- `generated_by` is checked against the caller so a report cannot be
-- attributed to a colleague who never read it.
create policy "Assigned doctors write reports"
  on public.patient_health_reports for insert
  to authenticated
  with check (
    generated_by = private.current_app_user_id()
    and exists (
      select 1 from public.patient_doctor_assignments a
      where a.patient_id = patient_health_reports.patient_id
        and a.doctor_id = private.current_doctor_id()
        and a.status = 'ACTIVE'
    )
  );

grant select, insert on public.patient_health_reports to authenticated;

-- ---------------------------------------------------------------------------
-- find_doctor_by_license
--
-- A patient granting access needs to identify the clinician they mean, and the
-- `doctors` SELECT policy deliberately shows them nothing until an assignment
-- exists — which is a chicken-and-egg problem this function resolves.
--
-- **Exact match only, never a prefix or ILIKE.** A searchable directory would
-- let any signed-in account enumerate every clinician on the platform, their
-- hospital and their speciality. Requiring the full licence number means the
-- patient has to have been given it, which is exactly the situation in which
-- they are entitled to look it up.
-- ---------------------------------------------------------------------------
create or replace function public.find_doctor_by_license(p_license text)
returns table (
  id             uuid,
  full_name      text,
  specialization text,
  hospital_name  text,
  verified       boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.full_name, d.specialization, d.hospital_name, d.verified_at is not null
  from public.doctors d
  where upper(btrim(d.license_number)) = upper(btrim(p_license))
    and char_length(btrim(p_license)) >= 3
  limit 1;
$$;

comment on function public.find_doctor_by_license(text) is
  'Exact-licence lookup so a patient can identify the clinician they are granting access to. Never a prefix search.';

revoke all on function public.find_doctor_by_license(text) from public;
grant execute on function public.find_doctor_by_license(text) to authenticated;

-- ---------------------------------------------------------------------------
-- invite_caregiver
--
-- The patient grants; nobody grants themselves. The assignment is created for
-- `private.current_patient_profile_id()` and there is no parameter naming a
-- patient, so this cannot be turned into a way to attach yourself to someone
-- else's record.
--
-- **The disclosure this makes, stated rather than hidden.** Returning
-- 'NO_ACCOUNT' tells the caller whether an email address has an AVERIS account,
-- which is an enumeration oracle. The alternative — a uniformly vague reply —
-- means a patient adding their daughter as a caregiver cannot tell a typo from
-- a person who has not signed up yet, and gets a silent failure in the flow
-- whose entire purpose is making sure someone is watching. The server action
-- rate-limits this call and audits it; that is the trade accepted.
--
-- Created ACTIVE, not PENDING. Consent here belongs to the patient, and a
-- caregiver who has to accept before anyone can be told the patient collapsed
-- is a delay bought for no safety gain — the patient can revoke at any time.
-- ---------------------------------------------------------------------------
create or replace function public.invite_caregiver(
  p_email        text,
  p_relationship text,
  p_permission   public.caregiver_permission
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_patient_id   uuid := private.current_patient_profile_id();
  v_caregiver_id uuid;
  v_self         uuid := private.current_app_user_id();
begin
  if v_patient_id is null then
    return 'NO_PROFILE';
  end if;

  select u.id into v_caregiver_id
  from public.users u
  where lower(u.email) = lower(btrim(p_email));

  if v_caregiver_id is null then
    return 'NO_ACCOUNT';
  end if;

  -- Watching yourself is not a care arrangement, and the row would give a
  -- patient a second, differently-scoped route to their own record.
  if v_caregiver_id = v_self then
    return 'SELF';
  end if;

  -- Aliased because the ON CONFLICT SET list below has to name the existing
  -- row, and a schema-qualified name is not a valid reference there.
  insert into public.patient_caregiver_assignments as pca
    (patient_id, caregiver_id, relationship, permission_level, status)
  values
    (v_patient_id, v_caregiver_id, nullif(btrim(coalesce(p_relationship, '')), ''),
     p_permission, 'ACTIVE')
  on conflict (patient_id, caregiver_id) do update
    -- Re-inviting is how a patient changes the permission level or restores
    -- someone they revoked. Refusing would make the only path to "give my son
    -- vitals as well as alerts" a support request.
    set permission_level = excluded.permission_level,
        relationship     = coalesce(excluded.relationship, pca.relationship),
        status           = 'ACTIVE',
        revoked_at       = null;

  return 'ASSIGNED';
end;
$$;

revoke all on function public.invite_caregiver(text, text, public.caregiver_permission) from public;
grant execute on function public.invite_caregiver(text, text, public.caregiver_permission) to authenticated;

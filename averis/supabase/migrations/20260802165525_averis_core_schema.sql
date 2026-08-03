-- ===========================================================================
-- AVERIS — core schema (Phase 1: patient identity + health profile)
--
-- Security posture:
--   * Row Level Security on every table, deny-by-default.
--   * No privileges granted to `anon` — the entire data surface is
--     authenticated-only.
--   * Every policy pairs `TO authenticated` with an ownership predicate;
--     `TO authenticated` alone would be authentication without authorization.
--   * UPDATE policies carry both USING and WITH CHECK so a row's owner
--     cannot be reassigned.
--   * SECURITY DEFINER helpers live in the non-exposed `private` schema with
--     EXECUTE revoked from PUBLIC, so they are not callable API endpoints.
-- ===========================================================================

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------
-- Roles. Phase 1 issues PATIENT only; DOCTOR and HOSPITAL_ADMIN exist now so
-- future phases need no destructive migration.
-- ---------------------------------------------------------------------------
create type public.user_role as enum ('PATIENT', 'DOCTOR', 'HOSPITAL_ADMIN');

create type public.gender_identity as enum ('FEMALE', 'MALE', 'OTHER', 'PREFER_NOT_TO_SAY');

create type public.blood_group as enum (
  'A_POSITIVE', 'A_NEGATIVE',
  'B_POSITIVE', 'B_NEGATIVE',
  'AB_POSITIVE', 'AB_NEGATIVE',
  'O_POSITIVE', 'O_NEGATIVE',
  'UNKNOWN'
);

-- ---------------------------------------------------------------------------
-- users — application identity, 1:1 with auth.users
-- ---------------------------------------------------------------------------
create table public.users (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid not null unique references auth.users (id) on delete cascade,
  email         text not null,
  full_name     text,
  profile_image text,
  role          public.user_role not null default 'PATIENT',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.users is 'AVERIS application identity, one row per auth.users entry.';

create index users_auth_user_id_idx on public.users (auth_user_id);

-- ---------------------------------------------------------------------------
-- patient_profiles — demographics, 1:1 with users
-- ---------------------------------------------------------------------------
create table public.patient_profiles (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique references public.users (id) on delete cascade,
  date_of_birth     date not null,
  gender            public.gender_identity not null,
  phone_number      text not null,
  blood_group       public.blood_group not null default 'UNKNOWN',
  emergency_contact text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint patient_profiles_dob_is_past check (date_of_birth < current_date),
  constraint patient_profiles_dob_is_plausible check (date_of_birth > date '1900-01-01'),
  constraint patient_profiles_phone_length check (char_length(phone_number) between 7 and 24)
);

comment on table public.patient_profiles is 'Patient demographics. One profile per AVERIS user.';

create index patient_profiles_user_id_idx on public.patient_profiles (user_id);

-- ---------------------------------------------------------------------------
-- patient_health_information — clinical facts, 1:1 with patient_profiles
--
-- Lists are text[] in Phase 1 because they are patient-entered. They stay
-- queryable via the && overlap operator; Phase 2 promotes them to coded
-- clinical entities once AI extraction supplies structure.
-- ---------------------------------------------------------------------------
create table public.patient_health_information (
  id                  uuid primary key default gen_random_uuid(),
  patient_id          uuid not null unique references public.patient_profiles (id) on delete cascade,
  allergies           text[] not null default '{}',
  existing_conditions text[] not null default '{}',
  current_medications text[] not null default '{}',
  medical_notes       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.patient_health_information is 'Patient-reported health background.';

create index patient_health_information_patient_id_idx
  on public.patient_health_information (patient_id);

-- ---------------------------------------------------------------------------
-- Ownership helpers.
--
-- SECURITY DEFINER so RLS policies can resolve ownership without recursing
-- into another table's policies (and without a per-row subquery cost). They
-- derive identity from auth.uid() internally, take no arguments, live in the
-- non-exposed `private` schema, and are executable only by `authenticated`.
-- ---------------------------------------------------------------------------
create function private.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from public.users u where u.auth_user_id = (select auth.uid());
$$;

create function private.current_patient_profile_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.patient_profiles p
  join public.users u on u.id = p.user_id
  where u.auth_user_id = (select auth.uid());
$$;

revoke all on function private.current_app_user_id() from public;
revoke all on function private.current_patient_profile_id() from public;

-- RLS policy expressions are evaluated with the *querying* role's privileges,
-- so `authenticated` needs USAGE on the schema as well as EXECUTE on the
-- functions — without it every policy referencing them fails with
-- "permission denied for schema private".
--
-- This does not expose the schema through the Data API: PostgREST only serves
-- the schemas it is configured with (`public`). Both functions take no
-- arguments and resolve identity from auth.uid() internally, so a caller can
-- only ever learn their own ids.
grant usage on schema private to authenticated;
grant execute on function private.current_app_user_id() to authenticated;
grant execute on function private.current_patient_profile_id() to authenticated;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger users_set_updated_at
  before update on public.users
  for each row execute function private.set_updated_at();

create trigger patient_profiles_set_updated_at
  before update on public.patient_profiles
  for each row execute function private.set_updated_at();

create trigger patient_health_information_set_updated_at
  before update on public.patient_health_information
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Provision an AVERIS identity whenever a Supabase auth user is created.
-- Covers both email/password signup and Google OAuth with one code path.
--
-- Lives in `private` (not `public`) so it is not exposed as a callable
-- endpoint. Idempotent: a repeated auth event will not raise.
-- ---------------------------------------------------------------------------
create function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (auth_user_id, email, full_name, profile_image, role)
  values (
    new.id,
    new.email,
    nullif(trim(coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      ''
    )), ''),
    nullif(trim(coalesce(
      new.raw_user_meta_data ->> 'avatar_url',
      new.raw_user_meta_data ->> 'picture',
      ''
    )), ''),
    'PATIENT'
  )
  on conflict (auth_user_id) do nothing;

  return new;
end;
$$;

revoke all on function private.handle_new_auth_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.users                       enable row level security;
alter table public.patient_profiles            enable row level security;
alter table public.patient_health_information  enable row level security;

-- users -------------------------------------------------------------------
create policy "Users read own identity"
  on public.users for select
  to authenticated
  using ( (select auth.uid()) = auth_user_id );

create policy "Users update own identity"
  on public.users for update
  to authenticated
  using ( (select auth.uid()) = auth_user_id )
  with check ( (select auth.uid()) = auth_user_id );

-- Rows are created by the auth trigger. INSERT is additionally allowed for the
-- owner so a self-heal path exists if the trigger is ever bypassed.
create policy "Users insert own identity"
  on public.users for insert
  to authenticated
  with check ( (select auth.uid()) = auth_user_id );

-- patient_profiles ---------------------------------------------------------
create policy "Patients read own profile"
  on public.patient_profiles for select
  to authenticated
  using ( user_id = private.current_app_user_id() );

create policy "Patients create own profile"
  on public.patient_profiles for insert
  to authenticated
  with check ( user_id = private.current_app_user_id() );

create policy "Patients update own profile"
  on public.patient_profiles for update
  to authenticated
  using ( user_id = private.current_app_user_id() )
  with check ( user_id = private.current_app_user_id() );

-- patient_health_information ----------------------------------------------
create policy "Patients read own health information"
  on public.patient_health_information for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Patients create own health information"
  on public.patient_health_information for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients update own health information"
  on public.patient_health_information for update
  to authenticated
  using ( patient_id = private.current_patient_profile_id() )
  with check ( patient_id = private.current_patient_profile_id() );

-- ===========================================================================
-- Grants — authenticated only. `anon` receives nothing.
-- DELETE is intentionally withheld: Phase 1 has no account-deletion flow, and
-- health records should not be removable by an accidental client call.
-- ===========================================================================
grant usage on schema public to authenticated;

grant select, insert, update on public.users                      to authenticated;
grant select, insert, update on public.patient_profiles           to authenticated;
grant select, insert, update on public.patient_health_information to authenticated;

revoke all on public.users                      from anon;
revoke all on public.patient_profiles           from anon;
revoke all on public.patient_health_information from anon;

-- ===========================================================================
-- AVERIS — Row Level Security verification
--
-- Proves the security claim that matters most: one patient can never read or
-- write another patient's health record, and an anonymous caller sees nothing.
--
-- Runs against any Postgres 15+ instance. Apply in order:
--   1. supabase/tests/00_local_auth_stub.sql   (stubs auth.users / auth.uid())
--   2. supabase/migrations/*_averis_core_schema.sql  (unmodified production DDL)
--   3. this file
--
-- Or simply: ./supabase/tests/run.sh
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- ===========================================================================
-- Fixtures: two unrelated patients
-- ===========================================================================
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'ananya@example.com',
   '{"full_name":"Ananya Krishnan"}'::jsonb),
  ('22222222-2222-4222-8222-222222222222', 'rahul@example.com',
   '{"full_name":"Rahul Sharma"}'::jsonb);

-- The auth trigger should have provisioned both public.users rows.
do $$
declare provisioned int;
begin
  select count(*) into provisioned from public.users;
  if provisioned <> 2 then
    raise exception 'FAIL trigger: expected 2 provisioned users, found %', provisioned;
  end if;
  perform 1 from public.users
   where email = 'ananya@example.com' and full_name = 'Ananya Krishnan' and role = 'PATIENT';
  if not found then
    raise exception 'FAIL trigger: full_name/role not populated from auth metadata';
  end if;
  raise notice 'PASS  trigger provisions public.users with name and PATIENT role';
end
$$;

-- Seed each patient's profile + health information as the owning user, which
-- also exercises the INSERT policies.
set role authenticated;

set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
insert into public.patient_profiles (user_id, date_of_birth, gender, phone_number, blood_group)
values (private.current_app_user_id(), date '1991-03-14', 'FEMALE', '+91 98765 43210', 'B_POSITIVE');
insert into public.patient_health_information (patient_id, allergies, existing_conditions)
values (private.current_patient_profile_id(), array['Penicillin'], array['Asthma']);

set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
insert into public.patient_profiles (user_id, date_of_birth, gender, phone_number, blood_group)
values (private.current_app_user_id(), date '1981-02-11', 'MALE', '+91 90000 11111', 'O_NEGATIVE');
insert into public.patient_health_information (patient_id, allergies)
values (private.current_patient_profile_id(), array['Sulfa']);

reset role;

-- ===========================================================================
-- Assertions
-- ===========================================================================
do $$
declare
  visible          int;
  ananya_profile   uuid;
  rahul_profile    uuid;
  rahul_health     uuid;
  affected         int;
begin
  select p.id into ananya_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'ananya@example.com';
  select p.id into rahul_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'rahul@example.com';
  select h.id into rahul_health from public.patient_health_information h
    where h.patient_id = rahul_profile;

  ---------------------------------------------------------------- as Ananya
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  select count(*) into visible from public.users;
  if visible <> 1 then raise exception 'FAIL: identity leak — saw % users, expected 1', visible; end if;
  raise notice 'PASS  users: patient sees only their own identity row';

  select count(*) into visible from public.patient_profiles;
  if visible <> 1 then raise exception 'FAIL: profile leak — saw % profiles, expected 1', visible; end if;

  select count(*) into visible from public.patient_profiles where id = rahul_profile;
  if visible <> 0 then raise exception 'FAIL: another patient''s profile is readable'; end if;
  raise notice 'PASS  patient_profiles: another patient''s profile is invisible';

  select count(*) into visible from public.patient_health_information;
  if visible <> 1 then raise exception 'FAIL: health leak — saw % rows, expected 1', visible; end if;

  select count(*) into visible from public.patient_health_information where id = rahul_health;
  if visible <> 0 then raise exception 'FAIL: another patient''s health information is readable'; end if;
  raise notice 'PASS  patient_health_information: cross-patient read blocked';

  -- Writes against someone else's row must affect nothing.
  update public.patient_health_information
     set allergies = array['tampered'] where id = rahul_health;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'FAIL: cross-patient UPDATE modified % row(s)', affected; end if;
  raise notice 'PASS  cross-patient UPDATE affects zero rows';

  -- Ownership reassignment must be rejected by the UPDATE WITH CHECK clause.
  begin
    update public.patient_profiles
       set user_id = (select id from public.users where email = 'rahul@example.com')
     where id = ananya_profile;
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: profile ownership was reassigned to another user';
    end if;
    raise notice 'PASS  ownership reassignment blocked (no rows matched WITH CHECK)';
  exception
    when insufficient_privilege or check_violation then
      raise notice 'PASS  ownership reassignment rejected by WITH CHECK';
  end;

  -- Owner can still update their own record.
  update public.patient_health_information
     set allergies = array['Penicillin', 'Peanuts']
   where patient_id = ananya_profile;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'FAIL: owner cannot update own health information'; end if;
  raise notice 'PASS  owner can update their own health information';

  -- DELETE is not granted to authenticated at all.
  begin
    delete from public.patient_health_information where patient_id = ananya_profile;
    raise exception 'FAIL: DELETE succeeded but is not granted';
  exception
    when insufficient_privilege then
      raise notice 'PASS  DELETE is not granted to authenticated';
  end;

  ------------------------------------------------------------ as anonymous
  set local role anon;
  set local request.jwt.claim.sub = '';

  begin
    select count(*) into visible from public.patient_profiles;
    raise exception 'FAIL: anon could query patient_profiles (saw % rows)', visible;
  exception
    when insufficient_privilege then
      raise notice 'PASS  anon has no privilege on patient_profiles';
  end;

  begin
    select count(*) into visible from public.users;
    raise exception 'FAIL: anon could query users (saw % rows)', visible;
  exception
    when insufficient_privilege then
      raise notice 'PASS  anon has no privilege on users';
  end;

  reset role;

  --------------------------------------------------------- privileged helpers
  begin
    perform private.current_app_user_id();
    raise notice 'NOTE  private helper callable by superuser (expected)';
  exception when others then null;
  end;

  raise notice '---';
  raise notice 'ALL RLS ASSERTIONS PASSED';
end
$$;

-- Constraint checks -------------------------------------------------------
do $$
begin
  begin
    insert into public.patient_profiles (user_id, date_of_birth, gender, phone_number)
    values ((select id from public.users limit 1), current_date + 1, 'OTHER', '+91 90000 00000');
    raise exception 'FAIL: future date_of_birth was accepted';
  exception when check_violation then
    raise notice 'PASS  future date_of_birth rejected';
  end;

  begin
    insert into public.patient_profiles (user_id, date_of_birth, gender, phone_number)
    values ((select id from public.users limit 1), date '1990-01-01', 'OTHER', '123');
    raise exception 'FAIL: too-short phone number was accepted';
  exception when check_violation then
    raise notice 'PASS  implausible phone number rejected';
  end;
end
$$;

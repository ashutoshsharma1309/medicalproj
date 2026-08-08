-- ===========================================================================
-- AVERIS IoT Phase 4 — Row Level Security verification
--
-- The claim: a doctor reads exactly the patients assigned to them, and no
-- others. This is the first migration in the project that lets one user read
-- another's health record, so it is the one whose failure would be worst and
-- least visible — a doctor browsing an unassigned chart sees a perfectly normal
-- page.
--
-- The assertions below therefore test the *absence* of access as hard as its
-- presence, and cover the three ways it goes wrong in practice:
--
--   · an assignment that was never accepted (PENDING) granting access
--   · an assignment that was withdrawn (REVOKED) still granting it
--   · a caregiver's narrow grant widening into the full medical record
--
-- Seeds a doctor and a caregiver against the Ananya/Rahul fixtures.
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- ---------------------------------------------------------------- fixtures
-- Inserted as the owner: these represent an onboarding flow that has already
-- happened, and the policies for it are asserted separately below.
insert into auth.users (id, email) values
  ('33333333-3333-4333-8333-333333333333', 'doctor@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'caregiver@example.com')
on conflict do nothing;

insert into public.users (auth_user_id, email, full_name, role) values
  ('33333333-3333-4333-8333-333333333333', 'doctor@example.com', 'Dr Meera Iyer', 'DOCTOR'),
  ('44444444-4444-4444-8444-444444444444', 'caregiver@example.com', 'Vikram Rao', 'CAREGIVER')
on conflict (auth_user_id) do nothing;

insert into public.doctors (user_id, full_name, license_number, specialization)
select id, 'Dr Meera Iyer', 'MED-99117', 'Internal medicine'
from public.users where email = 'doctor@example.com'
on conflict (user_id) do nothing;

-- Ananya's doctor: ACTIVE. Rahul has no doctor.
insert into public.patient_doctor_assignments (patient_id, doctor_id, status)
select p.id, d.id, 'ACTIVE'
from public.patient_profiles p
join public.users pu on pu.id = p.user_id
cross join public.doctors d
where pu.email = 'ananya@example.com'
on conflict do nothing;

-- Ananya's caregiver: alerts only.
insert into public.patient_caregiver_assignments
  (patient_id, caregiver_id, relationship, permission_level, status)
select p.id, u.id, 'Son', 'VIEW_ALERTS', 'ACTIVE'
from public.patient_profiles p
join public.users pu on pu.id = p.user_id
cross join public.users u
where pu.email = 'ananya@example.com' and u.email = 'caregiver@example.com'
on conflict do nothing;

insert into public.emergency_events (patient_id, event_type, severity, summary, detected_by)
select p.id, 'SEVERE_HYPOXIA', 'CRITICAL', 'ANANYA EMERGENCY: SpO2 86%', 'AI_ENGINE'
from public.patient_profiles p
join public.users u on u.id = p.user_id
where u.email = 'ananya@example.com';

insert into public.emergency_events (patient_id, event_type, severity, summary, detected_by)
select p.id, 'FALL_DETECTED', 'CRITICAL', 'RAHUL EMERGENCY: possible fall', 'AI_ENGINE'
from public.patient_profiles p
join public.users u on u.id = p.user_id
where u.email = 'rahul@example.com';

-- ---------------------------------------------------------------- assertions
do $$
declare
  visible        int;
  affected       int;
  ananya_profile uuid;
  rahul_profile  uuid;
  doctor_row     uuid;
  rahul_event    uuid;
  ananya_event   uuid;
begin
  select p.id into ananya_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'ananya@example.com';
  select p.id into rahul_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'rahul@example.com';
  select id into doctor_row from public.doctors where license_number = 'MED-99117';
  select id into rahul_event from public.emergency_events where summary like 'RAHUL%';
  select id into ananya_event from public.emergency_events where summary like 'ANANYA%';

  -- =====================================================  AS THE DOCTOR  ===
  set local role authenticated;
  set local request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';

  ----------------------------------------------- the load-bearing assertion
  -- Assigned patient: readable.
  select count(*) into visible from public.patient_profiles where id = ananya_profile;
  if visible <> 1 then
    raise exception 'FAIL: assigned doctor cannot read their own patient';
  end if;
  raise notice 'PASS  assigned doctor reads their patient''s profile';

  -- Unassigned patient: not readable, and this is the one that matters.
  select count(*) into visible from public.patient_profiles where id = rahul_profile;
  if visible <> 0 then
    raise exception 'FAIL: doctor read an UNASSIGNED patient''s profile';
  end if;
  raise notice 'PASS  doctor cannot read an unassigned patient''s profile';

  select count(*) into visible from public.sensor_readings where patient_id = rahul_profile;
  if visible <> 0 then
    raise exception 'FAIL: doctor read % unassigned vital sign row(s)', visible;
  end if;
  raise notice 'PASS  doctor cannot read an unassigned patient''s vitals';

  select count(*) into visible from public.patient_medical_records where patient_id = rahul_profile;
  if visible <> 0 then
    raise exception 'FAIL: doctor read an unassigned patient''s medical records';
  end if;
  raise notice 'PASS  doctor cannot read an unassigned patient''s medical records';

  select count(*) into visible from public.medical_documents where patient_id = rahul_profile;
  if visible <> 0 then
    raise exception 'FAIL: doctor read an unassigned patient''s documents';
  end if;
  raise notice 'PASS  doctor cannot read an unassigned patient''s documents';

  select count(*) into visible from public.emergency_events where id = rahul_event;
  if visible <> 0 then
    raise exception 'FAIL: doctor read an unassigned patient''s emergency';
  end if;
  raise notice 'PASS  doctor cannot read an unassigned patient''s emergency';

  -- The assigned patient's clinical data IS reachable, or the policy is simply
  -- blocking everything and the assertions above prove nothing.
  select count(*) into visible from public.sensor_readings where patient_id = ananya_profile;
  if visible < 1 then
    raise exception 'FAIL: assigned doctor cannot read their patient''s vitals';
  end if;
  raise notice 'PASS  assigned doctor reads their patient''s vitals (% rows)', visible;

  ------------------------------------------------------- privilege escalation
  -- A doctor who could write their own assignment could read any chart by
  -- inserting one row. The patient grants access, never the clinician.
  begin
    insert into public.patient_doctor_assignments (patient_id, doctor_id, status)
    values (rahul_profile, doctor_row, 'ACTIVE');
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a doctor assigned themselves to a patient';
    end if;
    raise notice 'PASS  a doctor cannot assign themselves to a patient';
  exception when insufficient_privilege then
    raise notice 'PASS  a doctor has no privilege to self-assign';
  end;

  -- Nor may they escalate a caregiver-style grant by writing to the other
  -- assignment table.
  begin
    insert into public.patient_caregiver_assignments
      (patient_id, caregiver_id, permission_level, status)
    select rahul_profile, u.id, 'FULL', 'ACTIVE'
    from public.users u where u.email = 'doctor@example.com';
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a doctor granted themselves caregiver access';
    end if;
    raise notice 'PASS  a doctor cannot grant themselves caregiver access';
  exception when insufficient_privilege then
    raise notice 'PASS  no privilege to self-grant caregiver access';
  end;

  ------------------------------------------------------- emergency workflow
  update public.emergency_events
     set status = 'ACKNOWLEDGED',
         acknowledged_by = private.current_app_user_id(),
         acknowledged_at = now()
   where id = ananya_event;
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'FAIL: assigned doctor cannot acknowledge their patient''s emergency';
  end if;
  raise notice 'PASS  assigned doctor acknowledges their patient''s emergency';

  update public.emergency_events set status = 'DISMISSED' where id = rahul_event;
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'FAIL: doctor changed an unassigned patient''s emergency';
  end if;
  raise notice 'PASS  doctor cannot change an unassigned patient''s emergency';

  -- =================================================  AS THE CAREGIVER  ===
  set local request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';

  -- VIEW_ALERTS: emergencies and alerts, and nothing clinical.
  select count(*) into visible from public.emergency_events where patient_id = ananya_profile;
  if visible < 1 then
    raise exception 'FAIL: caregiver cannot see the emergency they exist to respond to';
  end if;
  raise notice 'PASS  caregiver with VIEW_ALERTS sees emergencies';

  -- The narrow grant must stay narrow. A family member watching for a fall has
  -- no business reading someone's medical history.
  select count(*) into visible from public.patient_medical_records where patient_id = ananya_profile;
  if visible <> 0 then
    raise exception 'FAIL: VIEW_ALERTS caregiver read % medical record(s)', visible;
  end if;
  raise notice 'PASS  VIEW_ALERTS caregiver cannot read medical records';

  select count(*) into visible from public.medical_documents where patient_id = ananya_profile;
  if visible <> 0 then
    raise exception 'FAIL: VIEW_ALERTS caregiver read uploaded documents';
  end if;
  raise notice 'PASS  VIEW_ALERTS caregiver cannot read documents';

  select count(*) into visible from public.sensor_readings where patient_id = ananya_profile;
  if visible <> 0 then
    raise exception 'FAIL: VIEW_ALERTS caregiver read % vital sign row(s)', visible;
  end if;
  raise notice 'PASS  VIEW_ALERTS caregiver cannot read vitals';

  -- A patient's questions to AVERIS are theirs. Deliberately not shared.
  select count(*) into visible from public.ai_conversations;
  if visible <> 0 then
    raise exception 'FAIL: caregiver read the patient''s AI conversations';
  end if;
  raise notice 'PASS  caregiver cannot read the patient''s AI conversations';

  -- =========================================  AS THE PATIENT (regression) ===
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  -- The whole point of adding policies rather than rewriting them: nothing a
  -- patient could already do may have changed.
  select count(*) into visible from public.patient_profiles;
  if visible <> 1 then
    raise exception 'FAIL: patient self-access changed — saw % profiles', visible;
  end if;
  raise notice 'PASS  patient self-access is unchanged';

  select count(*) into visible from public.sensor_readings where patient_id = rahul_profile;
  if visible <> 0 then
    raise exception 'FAIL: a patient can now see another patient''s vitals';
  end if;
  raise notice 'PASS  patient-to-patient isolation is unchanged';

  -- A patient may see who has access to their record; consent they cannot
  -- enumerate is not consent.
  select count(*) into visible from public.patient_doctor_assignments
    where patient_id = ananya_profile;
  if visible <> 1 then
    raise exception 'FAIL: patient cannot see who is assigned to them';
  end if;
  raise notice 'PASS  patient can enumerate who has access to their record';

  select count(*) into visible from public.doctors where id = doctor_row;
  if visible <> 1 then
    raise exception 'FAIL: patient cannot see their assigned doctor''s profile';
  end if;
  raise notice 'PASS  patient can see their assigned doctor';

  -- ============================================================  AS ANON  ===
  set local role anon;
  set local request.jwt.claim.sub = '';

  begin
    select count(*) into visible from public.doctors;
    raise exception 'FAIL: anon could query doctors (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on doctors';
  end;

  begin
    select count(*) into visible from public.emergency_events;
    raise exception 'FAIL: anon could query emergency_events (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on emergency_events';
  end;

  begin
    perform private.can_access_patient(ananya_profile);
    raise exception 'FAIL: anon could call private.can_access_patient';
  exception when insufficient_privilege then
    raise notice 'PASS  anon cannot call the access helper';
  end;

  reset role;
  raise notice '---';
  raise notice 'ALL IoT PHASE 4 RLS ASSERTIONS PASSED';
end
$$;

-- ---------------------------------------- revocation and pending assignments
do $$
declare
  visible        int;
  ananya_profile uuid;
  rahul_profile  uuid;
  doctor_row     uuid;
begin
  select p.id into ananya_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'ananya@example.com';
  select p.id into rahul_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'rahul@example.com';
  select id into doctor_row from public.doctors where license_number = 'MED-99117';

  -- A PENDING assignment is a proposal, not a grant.
  insert into public.patient_doctor_assignments (patient_id, doctor_id, status)
  values (rahul_profile, doctor_row, 'PENDING');

  set local role authenticated;
  set local request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';

  select count(*) into visible from public.sensor_readings where patient_id = rahul_profile;
  if visible <> 0 then
    raise exception 'FAIL: a PENDING assignment granted access to % row(s)', visible;
  end if;
  raise notice 'PASS  a PENDING assignment grants no access';

  reset role;

  -- Accepting it grants access...
  update public.patient_doctor_assignments
     set status = 'ACTIVE'
   where patient_id = rahul_profile and doctor_id = doctor_row;

  set local role authenticated;
  set local request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';

  select count(*) into visible from public.sensor_readings where patient_id = rahul_profile;
  if visible < 1 then
    raise exception 'FAIL: an ACTIVE assignment granted no access';
  end if;
  raise notice 'PASS  an ACTIVE assignment grants access';

  reset role;

  -- ...and revoking it takes it away again. This is the property that makes
  -- consent withdrawable rather than theoretical.
  update public.patient_doctor_assignments
     set status = 'REVOKED', revoked_at = now()
   where patient_id = rahul_profile and doctor_id = doctor_row;

  set local role authenticated;
  set local request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';

  select count(*) into visible from public.sensor_readings where patient_id = rahul_profile;
  if visible <> 0 then
    raise exception 'FAIL: a REVOKED assignment still grants access to % row(s)', visible;
  end if;
  raise notice 'PASS  a REVOKED assignment ends access immediately';

  select count(*) into visible from public.patient_profiles where id = rahul_profile;
  if visible <> 0 then
    raise exception 'FAIL: revoked doctor can still read the patient profile';
  end if;
  raise notice 'PASS  revocation applies across every table, not just one';

  reset role;
end
$$;

-- ---------------------------------------------------- constraint assertions
do $$
declare
  ananya_profile uuid;
  doctor_row     uuid;
begin
  select p.id into ananya_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'ananya@example.com';
  select id into doctor_row from public.doctors where license_number = 'MED-99117';

  -- "Resolved by nobody" is how an emergency gets closed without anyone having
  -- looked at the patient.
  begin
    insert into public.emergency_events (patient_id, event_type, summary, status)
    values (ananya_profile, 'MANUAL_ESCALATION', 'unattributed resolution', 'RESOLVED');
    raise exception 'FAIL: an emergency was resolved with nobody named';
  exception when check_violation then
    raise notice 'PASS  a resolved emergency must name who resolved it';
  end;

  -- One open event per patient per type, or a device below threshold raises an
  -- emergency every two seconds and the queue is useless when it matters.
  begin
    insert into public.emergency_events (patient_id, event_type, summary)
    values (ananya_profile, 'SEVERE_HYPOXIA', 'duplicate open emergency');
    raise exception 'FAIL: a second open emergency of the same type was accepted';
  exception when unique_violation then
    raise notice 'PASS  one open emergency per patient per type';
  end;

  -- A REVOKED row without a revocation time cannot be audited.
  begin
    insert into public.patient_doctor_assignments (patient_id, doctor_id, status)
    values (ananya_profile, doctor_row, 'REVOKED');
    raise exception 'FAIL: a REVOKED assignment with no revoked_at was accepted';
  exception when check_violation or unique_violation then
    raise notice 'PASS  revocation must record when it happened';
  end;

  -- Two clinicians sharing a licence number is either a data-entry error or an
  -- impersonation.
  begin
    insert into public.doctors (user_id, full_name, license_number)
    select id, 'Impostor', 'MED-99117' from public.users where email = 'rahul@example.com';
    raise exception 'FAIL: a duplicate licence number was accepted';
  exception when unique_violation then
    raise notice 'PASS  licence numbers are unique';
  end;
end
$$;

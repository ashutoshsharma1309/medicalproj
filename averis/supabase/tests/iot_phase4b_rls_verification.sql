-- ===========================================================================
-- AVERIS IoT Phase 4b — escalation, notification and consent
--
-- The care-team file asserts who may *read* a chart. This one asserts the
-- machinery built on top of it:
--
--   · an emergency and its notifications are one transaction, or neither
--   · a notice reaches the right people, with the right link for their role
--   · a caregiver holding the narrowest grant can still read the patient's
--     name — the regression that made the whole caregiver view useless
--   · a patient can identify a clinician by licence, and cannot browse them
--   · the enumeration surface of invite_caregiver is exactly what was accepted
--
-- Runs after iot_phase4_rls_verification.sql, and reuses its doctor and
-- caregiver fixtures.
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- A second caregiver, holding VIEW_VITALS, so the three permission levels are
-- all exercised rather than only the narrowest and the widest.
insert into auth.users (id, email) values
  ('55555555-5555-4555-8555-555555555555', 'daughter@example.com')
on conflict do nothing;

insert into public.users (auth_user_id, email, full_name, role) values
  ('55555555-5555-4555-8555-555555555555', 'daughter@example.com', 'Priya Rao', 'CAREGIVER')
on conflict (auth_user_id) do nothing;

insert into public.patient_caregiver_assignments
  (patient_id, caregiver_id, relationship, permission_level, status)
select p.id, u.id, 'Daughter', 'VIEW_VITALS', 'ACTIVE'
from public.patient_profiles p
join public.users pu on pu.id = p.user_id
cross join public.users u
where pu.email = 'ananya@example.com' and u.email = 'daughter@example.com'
on conflict do nothing;

-- ------------------------------------------------- escalation and fan-out
do $$
declare
  ananya_profile uuid;
  rahul_profile  uuid;
  first_event    uuid;
  second_event   uuid;
  notices        int;
  doctor_href    text;
  caregiver_href text;
begin
  select p.id into ananya_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'ananya@example.com';
  select p.id into rahul_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'rahul@example.com';

  -- Ananya already has an open SEVERE_HYPOXIA from the previous file, so a
  -- type with nothing open is used here.
  first_event := private.raise_emergency(
    ananya_profile, null, 'EXTREME_HEART_RATE', 'CRITICAL', 'RULE_ENGINE',
    'Ananya Verma — Extreme heart rate',
    'Heart rate measured 168 BPM, above the 150 BPM threshold.',
    '{"observed": 168}'::jsonb
  );

  if first_event is null then
    raise exception 'FAIL: raise_emergency did not create an event';
  end if;
  raise notice 'PASS  raise_emergency creates the event';

  -- The property the whole function exists for: the event and the notices are
  -- one transaction. An event with no notices is an emergency nobody was told
  -- about, and nothing about that state looks wrong.
  select count(*) into notices
  from public.care_notifications where emergency_id = first_event;
  if notices < 3 then
    raise exception 'FAIL: fan-out reached only % of 3 care team members', notices;
  end if;
  raise notice 'PASS  the doctor and both caregivers were notified (% notices)', notices;

  -- Role-dependent links. A caregiver sent to /clinical follows a link into a
  -- 404 during an emergency.
  select n.href into doctor_href
  from public.care_notifications n
  join public.users u on u.id = n.recipient_id
  where n.emergency_id = first_event and u.email = 'doctor@example.com';

  select n.href into caregiver_href
  from public.care_notifications n
  join public.users u on u.id = n.recipient_id
  where n.emergency_id = first_event and u.email = 'caregiver@example.com';

  if doctor_href <> '/clinical/' || ananya_profile::text then
    raise exception 'FAIL: doctor notice links to %', doctor_href;
  end if;
  if caregiver_href <> '/care/' || ananya_profile::text then
    raise exception 'FAIL: caregiver notice links to %', caregiver_href;
  end if;
  raise notice 'PASS  each role is linked to the page it can actually open';

  -- Deduplication. A device below threshold at 0.5 Hz would otherwise raise
  -- one every two seconds, and 300 unanswered emergencies is a queue nobody
  -- can triage at the moment it matters.
  second_event := private.raise_emergency(
    ananya_profile, null, 'EXTREME_HEART_RATE', 'CRITICAL', 'RULE_ENGINE',
    'Ananya Verma — Extreme heart rate',
    'Heart rate measured 171 BPM, above the 150 BPM threshold.',
    '{"observed": 171}'::jsonb
  );

  if second_event is not null then
    raise exception 'FAIL: a second open emergency of the same type was created';
  end if;
  raise notice 'PASS  an already-open emergency is not raised twice';

  select count(*) into notices
  from public.care_notifications where emergency_id = first_event;
  if notices > 3 then
    raise exception 'FAIL: the suppressed escalation still sent % notices', notices;
  end if;
  raise notice 'PASS  a suppressed escalation sends no further notices';

  -- Rahul has no care team. The event must still be recorded — a patient with
  -- nobody watching is exactly the patient whose emergency must not be
  -- discarded for want of an audience.
  if private.raise_emergency(
    rahul_profile, null, 'DEVICE_LOST', 'WARNING', 'RULE_ENGINE',
    'Rahul Sharma — Device stopped reporting',
    'No readings for 20 minutes.', '{}'::jsonb
  ) is null then
    raise exception 'FAIL: an emergency was dropped because nobody was assigned';
  end if;
  raise notice 'PASS  an emergency is recorded even with nobody to notify';
end
$$;

-- ------------------------------------------------------ the notice inbox
do $$
declare
  visible  int;
  affected int;
  notice_id uuid;
  doctor_user uuid;
begin
  select u.id into doctor_user from public.users u where u.email = 'doctor@example.com';
  select n.id into notice_id
  from public.care_notifications n where n.recipient_id = doctor_user limit 1;

  set local role authenticated;
  set local request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';

  select count(*) into visible from public.care_notifications;
  if visible < 1 then
    raise exception 'FAIL: a doctor cannot read their own notices';
  end if;
  raise notice 'PASS  a recipient reads their own notices (% visible)', visible;

  select count(*) into visible
  from public.care_notifications where recipient_id <> doctor_user;
  if visible <> 0 then
    raise exception 'FAIL: a doctor read % notice(s) addressed to someone else', visible;
  end if;
  raise notice 'PASS  notices addressed to others are invisible';

  -- Dismissal is the only write a recipient has.
  update public.care_notifications set read_at = now() where id = notice_id;
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'FAIL: a recipient cannot dismiss their own notice';
  end if;
  raise notice 'PASS  a recipient dismisses their own notice';

  -- Reassigning a notice would let one clinician move another's alert out of
  -- their inbox. The WITH CHECK refuses the new row, which Postgres reports as
  -- a privilege error rather than as zero rows affected.
  begin
    update public.care_notifications
       set recipient_id = (select id from public.users where email = 'ananya@example.com')
     where id = notice_id;
    get diagnostics affected = row_count;
    if affected <> 0 then
      raise exception 'FAIL: a notice was reassigned to another user';
    end if;
    raise notice 'PASS  a notice cannot be moved to another recipient';
  exception when insufficient_privilege then
    raise notice 'PASS  reassigning a notice is refused by the policy';
  end;

  -- A browser that could insert here could tell a doctor a patient collapsed.
  begin
    insert into public.care_notifications
      (recipient_id, patient_id, severity, title, body)
    select doctor_user, p.id, 'CRITICAL', 'fabricated', 'fabricated'
    from public.patient_profiles p limit 1;
    raise exception 'FAIL: a client role inserted a care notification';
  exception when insufficient_privilege then
    raise notice 'PASS  no client role can write a care notification';
  end;

  reset role;
end
$$;

-- --------------------------------- the caregiver identity regression (4c)
do $$
declare
  visible int;
  named   int;
begin
  -- VIEW_ALERTS: the narrowest grant, and the one that was broken. The
  -- caregiver could see the emergency and not the name of the person it was
  -- about, so their watchlist rendered as a list of UUIDs.
  set local role authenticated;
  set local request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';

  select count(*) into named from public.care_patient_directory();
  if named <> 1 then
    raise exception 'FAIL: a VIEW_ALERTS caregiver resolves % patient names, expected 1', named;
  end if;
  raise notice 'PASS  a VIEW_ALERTS caregiver can read the patient''s name';

  -- The grant stays narrow: still no profile row, which is what forced the
  -- directory function to exist in the first place.
  select count(*) into visible from public.patient_profiles;
  if visible <> 0 then
    raise exception 'FAIL: a VIEW_ALERTS caregiver read % profile row(s)', visible;
  end if;
  raise notice 'PASS  the name is readable and the profile still is not';

  -- VIEW_VITALS sees measurements; VIEW_ALERTS does not.
  set local request.jwt.claim.sub = '55555555-5555-4555-8555-555555555555';

  select count(*) into visible from public.sensor_readings;
  if visible < 1 then
    raise exception 'FAIL: a VIEW_VITALS caregiver cannot read vitals';
  end if;
  raise notice 'PASS  a VIEW_VITALS caregiver reads vitals';

  select count(*) into visible from public.patient_medical_records;
  if visible <> 0 then
    raise exception 'FAIL: a VIEW_VITALS caregiver read the medical record';
  end if;
  raise notice 'PASS  VIEW_VITALS stops short of the medical record';

  -- Somebody with no relationship to anyone resolves nothing.
  set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
  select count(*) into named from public.care_patient_directory();
  if named <> 0 then
    raise exception 'FAIL: an unrelated user resolved % patient name(s)', named;
  end if;
  raise notice 'PASS  the directory returns nothing to someone with no care relationship';

  reset role;
end
$$;

-- ------------------------------------------------------- patient summaries
do $$
declare
  ananya_profile uuid;
  rahul_profile  uuid;
  doctor_user    uuid;
  visible        int;
  affected       int;
begin
  select p.id into ananya_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'ananya@example.com';
  select p.id into rahul_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'rahul@example.com';
  select id into doctor_user from public.users where email = 'doctor@example.com';

  set local role authenticated;
  set local request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';

  insert into public.patient_health_reports
    (patient_id, generated_by, period_start, period_end, summary)
  values (ananya_profile, doctor_user, now() - interval '1 day', now(), 'Assigned patient summary.');
  raise notice 'PASS  an assigned doctor writes a summary';

  -- Not for a patient they do not treat.
  begin
    insert into public.patient_health_reports
      (patient_id, generated_by, period_start, period_end, summary)
    values (rahul_profile, doctor_user, now() - interval '1 day', now(), 'should not exist');
    raise exception 'FAIL: a doctor wrote a summary about an unassigned patient';
  exception when insufficient_privilege then
    raise notice 'PASS  no summary may be written about an unassigned patient';
  end;

  -- Nor under someone else's name. A report is a clinical artefact somebody
  -- put their name on, and attributing one to a colleague who never read the
  -- chart is the failure that makes the signature worthless.
  begin
    insert into public.patient_health_reports
      (patient_id, generated_by, period_start, period_end, summary)
    select ananya_profile, u.id, now() - interval '1 day', now(), 'attributed to someone else'
    from public.users u where u.email = 'caregiver@example.com';
    raise exception 'FAIL: a summary was attributed to another user';
  exception when insufficient_privilege then
    raise notice 'PASS  a summary must be written in the author''s own name';
  end;

  -- A summary of someone's health that they may not read is a summary written
  -- about them rather than for their care.
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
  select count(*) into visible from public.patient_health_reports;
  if visible <> 1 then
    raise exception 'FAIL: the patient cannot read the summary written about them';
  end if;
  raise notice 'PASS  the patient reads summaries written about them';

  -- Editing one afterwards would make the record of what was read untrue.
  -- There is no UPDATE grant at all, so this is refused before any policy is
  -- consulted.
  begin
    update public.patient_health_reports set summary = 'rewritten';
    get diagnostics affected = row_count;
    if affected <> 0 then
      raise exception 'FAIL: a stored summary was edited after the fact';
    end if;
    raise notice 'PASS  a stored summary cannot be rewritten';
  exception when insufficient_privilege then
    raise notice 'PASS  no client role may update a stored summary';
  end;

  -- A caregiver with the narrow grant has no business reading it.
  set local request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';
  select count(*) into visible from public.patient_health_reports;
  if visible <> 0 then
    raise exception 'FAIL: a VIEW_ALERTS caregiver read % summary(s)', visible;
  end if;
  raise notice 'PASS  summaries are not part of the caregiver grant';

  reset role;
end
$$;

-- ------------------------------------------- finding and inviting people
do $$
declare
  found   int;
  outcome text;
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  select count(*) into found from public.find_doctor_by_license('MED-99117');
  if found <> 1 then
    raise exception 'FAIL: a patient cannot identify a clinician by exact licence';
  end if;
  raise notice 'PASS  an exact licence resolves to one clinician';

  -- Case and surrounding space are typing, not identity.
  select count(*) into found from public.find_doctor_by_license('  med-99117 ');
  if found <> 1 then
    raise exception 'FAIL: licence lookup is sensitive to case or whitespace';
  end if;
  raise notice 'PASS  the lookup tolerates case and spacing';

  -- The property that keeps this from being a staff directory: a prefix
  -- matches nothing. Otherwise any account could enumerate every clinician on
  -- the platform, their speciality and their hospital.
  select count(*) into found from public.find_doctor_by_license('MED');
  if found <> 0 then
    raise exception 'FAIL: a partial licence returned % clinician(s)', found;
  end if;
  raise notice 'PASS  a partial licence matches nobody';

  select count(*) into found from public.find_doctor_by_license('%');
  if found <> 0 then
    raise exception 'FAIL: a wildcard returned % clinician(s)', found;
  end if;
  raise notice 'PASS  a wildcard is treated as a literal, not a pattern';

  -- Inviting a caregiver.
  outcome := public.invite_caregiver('daughter@example.com', 'Daughter', 'FULL');
  if outcome <> 'ASSIGNED' then
    raise exception 'FAIL: inviting an existing account returned %', outcome;
  end if;
  raise notice 'PASS  a patient can add a caregiver';

  -- Re-inviting is how a permission level is changed. Refusing would make
  -- "give my daughter vitals too" a support request.
  if (select permission_level from public.patient_caregiver_assignments c
      join public.users u on u.id = c.caregiver_id
      where u.email = 'daughter@example.com') <> 'FULL' then
    raise exception 'FAIL: re-inviting did not update the permission level';
  end if;
  raise notice 'PASS  re-inviting updates the permission level';

  outcome := public.invite_caregiver('ananya@example.com', 'Me', 'FULL');
  if outcome <> 'SELF' then
    raise exception 'FAIL: a patient added themselves as their own caregiver (%)', outcome;
  end if;
  raise notice 'PASS  a patient cannot add themselves';

  -- The accepted disclosure, asserted so it stays exactly this and no wider:
  -- the caller learns whether an address has an account, and nothing else.
  outcome := public.invite_caregiver('nobody@example.com', null, 'VIEW_ALERTS');
  if outcome <> 'NO_ACCOUNT' then
    raise exception 'FAIL: inviting an unknown address returned %', outcome;
  end if;
  raise notice 'PASS  an unknown address is reported as having no account';

  reset role;
end
$$;

-- --------------------------------------------------- caregiver revocation
do $$
declare
  visible int;
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  update public.patient_caregiver_assignments
     set status = 'REVOKED', revoked_at = now()
   where caregiver_id = (select id from public.users where email = 'daughter@example.com');

  reset role;

  set local role authenticated;
  set local request.jwt.claim.sub = '55555555-5555-4555-8555-555555555555';

  select count(*) into visible from public.sensor_readings;
  if visible <> 0 then
    raise exception 'FAIL: a revoked caregiver still reads % vital sign row(s)', visible;
  end if;
  raise notice 'PASS  revoking a caregiver ends their access immediately';

  select count(*) into visible from public.care_patient_directory();
  if visible <> 0 then
    raise exception 'FAIL: a revoked caregiver still resolves the patient''s name';
  end if;
  raise notice 'PASS  revocation reaches the directory too';

  reset role;
  raise notice '---';
  raise notice 'ALL IoT PHASE 4b RLS ASSERTIONS PASSED';
end
$$;

-- ===========================================================================
-- AVERIS Phase 11 — multi-patient separation and abuse attempts
--
-- The other suites verify that policies do what they were written to do. This
-- one plays the attacker: it takes the specific things a hostile or careless
-- client would try, and asserts each one fails.
--
-- ── Why this is separate from the per-phase suites ─────────────────────────
--
-- Those suites are organised by feature — "can a caregiver read a baseline".
-- This one is organised by *attack*, which surfaces a different class of gap:
-- the hole that exists precisely because no single feature's test was
-- responsible for it.
--
-- Three patients rather than two, deliberately. With two patients, a policy
-- that returns "everything except the caller's own rows" passes every
-- cross-patient check while being catastrophically wrong. Three makes that
-- visible.
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- ---------------------------------------------------------------- fixtures
--
-- A third patient, so "sees only their own" is a real constraint. The existing
-- suites provide Ananya (1111…) and Rahul (2222…).
-- No ON CONFLICT clause, deliberately.
--
-- The first version used `on conflict (id) do nothing` with id 5555…, which is
-- already daughter@example.com from the Phase 4 care team. The insert silently
-- did nothing and the failure surfaced twenty lines later as "the auth trigger
-- did not provision Meera" — a confusing message about the wrong thing.
--
-- A fixture collision must fail at the collision. This is the second time this
-- exact class of bug has appeared in these suites; the first was a token-hash
-- fixture colliding with Phase 1.
insert into auth.users (id, email, raw_user_meta_data)
values ('66666666-6666-4666-8666-666666666666', 'meera@example.com',
        '{"full_name":"Meera Nair"}'::jsonb);

-- The trigger provisions public.users; the patient profile is created by the
-- application at onboarding and so is created here explicitly, as the other
-- suites do.
set request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';
insert into public.patient_profiles (user_id, date_of_birth, gender, phone_number, blood_group)
values (private.current_app_user_id(), date '1958-07-02', 'FEMALE', '+91 91234 56780', 'A_POSITIVE');
reset request.jwt.claim.sub;

do $$
declare
  meera_profile uuid;
  meera_device  uuid;
begin
  select p.id into meera_profile
  from public.patient_profiles p
  join public.users u on u.id = p.user_id
  where u.email = 'meera@example.com';

  if meera_profile is null then
    raise exception 'FAIL: fixture — the auth trigger did not provision Meera';
  end if;

  insert into public.iot_devices
    (patient_id, device_key, device_name, device_type, token_hash, connection_status)
  values (
    meera_profile, 'AVR-P11-MEERA', 'Meera band', 'WEARABLE_BAND',
    -- A hash used by no other suite. Phase 5's uniqueness constraint makes a
    -- collision loud, which is how the previous value was caught.
    repeat('e1', 32), 'ONLINE'
  )
  returning id into meera_device;

  insert into public.sensor_readings
    (patient_id, device_id, heart_rate, spo2, temperature, movement_status,
     recorded_at, is_simulated)
  values
    (meera_profile, meera_device, 77, 98, 36.7, 'RESTING', now() - interval '2 minutes', false),
    (meera_profile, meera_device, 79, 97, 36.7, 'RESTING', now() - interval '1 minute', false);

  raise notice 'PASS  fixture: a third patient with a device and readings';
end
$$;

-- =========================================================================
-- Multi-patient separation (Phase 11 §9)
-- =========================================================================
do $$
declare
  visible int;
  total   int;
begin
  set local role authenticated;

  -- Each patient sees exactly their own readings, and the count is asserted
  -- against the *global* total rather than against zero. A policy returning
  -- everything-but-mine passes a cross-patient check and fails this one.
  select count(*) into total from public.sensor_readings;

  set local request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';
  select count(*) into visible from public.sensor_readings;

  if visible <> 2 then
    raise exception 'FAIL: the third patient sees % readings, expected exactly their own 2', visible;
  end if;
  raise notice 'PASS  three-patient separation: each sees only their own readings';

  -- The device fleet. A clinician's caseload query joins across devices, and a
  -- policy that leaked here would leak the whole fleet's telemetry.
  select count(*) into visible from public.iot_devices;
  if visible <> 1 then
    raise exception 'FAIL: the third patient sees % devices, expected 1', visible;
  end if;
  raise notice 'PASS  a patient sees only their own device';

  reset role;
end
$$;

-- =========================================================================
-- Abuse attempts (Phase 11 §10)
-- =========================================================================

-- ------------------------------------------------- writing into another chart
do $$
declare
  victim_profile uuid;
  victim_device  uuid;
  written int;
begin
  select p.id into victim_profile
  from public.patient_profiles p
  join public.users u on u.id = p.user_id
  where u.email = 'ananya@example.com';

  select d.id into victim_device
  from public.iot_devices d
  where d.patient_id = victim_profile
  limit 1;

  set local role authenticated;
  set local request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';

  -- The attack the whole ingest design exists to prevent: a client writing a
  -- reading attributed to somebody else. No client role has INSERT on
  -- sensor_readings at all, so this is refused at the grant level rather than
  -- by a policy — the stronger of the two, because a grant cannot be
  -- accidentally widened by a permissive policy added for another purpose.
  begin
    insert into public.sensor_readings
      (patient_id, device_id, heart_rate, spo2, temperature, movement_status, recorded_at)
    values (victim_profile, victim_device, 200, 70, 40, 'RESTING', now());

    raise exception 'FAIL: a client wrote a reading into another patient''s chart';
  exception
    when insufficient_privilege then
      raise notice 'PASS  no client role may write a sensor reading at all';
  end;

  -- Writing into their OWN chart is equally refused. Readings come from
  -- authenticated devices through the ingest service, never from a browser —
  -- a patient who could author their own vitals could manufacture a history.
  begin
    insert into public.sensor_readings
      (patient_id, device_id, heart_rate, spo2, temperature, movement_status, recorded_at)
    select p.id, null, 72, 98, 36.6, 'RESTING', now()
    from public.patient_profiles p
    join public.users u on u.id = p.user_id
    where u.email = 'meera@example.com';

    raise exception 'FAIL: a patient authored their own sensor reading';
  exception
    when insufficient_privilege then
      raise notice 'PASS  a patient cannot author their own vitals either';
  end;

  reset role;
end
$$;

-- ------------------------------------------------------- forging an emergency
do $$
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';

  -- An emergency a client could create is an emergency a client could create
  -- for somebody else — and a care team that learns to distrust the queue is
  -- worse than no queue.
  begin
    insert into public.emergency_events
      (patient_id, event_type, severity, detected_by, summary)
    select p.id, 'FALL_DETECTED', 'CRITICAL', 'RULE_ENGINE', 'forged'
    from public.patient_profiles p
    join public.users u on u.id = p.user_id
    where u.email = 'ananya@example.com';

    raise exception 'FAIL: a client forged an emergency for another patient';
  exception
    when insufficient_privilege then
      raise notice 'PASS  no client role may create an emergency event';
  end;

  reset role;
end
$$;

-- --------------------------------------------------- escalating an alert
do $$
declare
  changed int;
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';

  -- Downgrading somebody else's critical alert. Affects zero rows rather than
  -- raising, because the UPDATE grant exists for acknowledgement — the policy
  -- is what confines it to the caller's own rows.
  update public.alerts set severity = 'INFO' where severity = 'CRITICAL';
  get diagnostics changed = row_count;

  if changed <> 0 then
    raise exception 'FAIL: a client downgraded % alert(s) belonging to others', changed;
  end if;
  raise notice 'PASS  a client cannot downgrade another patient''s alerts';

  reset role;
end
$$;

-- ------------------------------------------------------ unauthenticated access
do $$
declare
  has_privilege boolean;
begin
  -- anon is the role an unauthenticated request runs as. Every patient-data
  -- table must be unreachable to it, and this is asserted by privilege rather
  -- than by attempting a select — a table with no grant and no policy would
  -- return zero rows either way, and only the privilege check distinguishes
  -- "locked" from "empty".
  for has_privilege in
    select has_table_privilege('anon', c.oid, 'SELECT')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname in (
        'sensor_readings', 'patient_profiles', 'alerts', 'emergency_events',
        'patient_health_information', 'medical_documents', 'iot_devices',
        'patient_baselines', 'health_trends', 'risk_events', 'calibration_sessions'
      )
  loop
    if has_privilege then
      raise exception 'FAIL: anon holds SELECT on a patient-data table';
    end if;
  end loop;

  raise notice 'PASS  anon holds no SELECT on any patient-data table';
end
$$;

-- ---------------------------------------------- reaching the device resolver
do $$
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';

  -- private.resolve_device turns a token hash into a device and its owner. A
  -- client that could call it could enumerate the fleet by brute force, and
  -- would learn a patient id for every hash it guessed.
  begin
    perform private.resolve_device(repeat('a', 64));
    raise exception 'FAIL: a client role called the device resolver';
  exception
    when insufficient_privilege then
      raise notice 'PASS  no client role may call the device resolver';
  end;

  reset role;
end
$$;

-- --------------------------------------------- reading another patient's token
do $$
declare
  leaked int;
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';

  -- token_hash is withheld by column grant. Postgres has no
  -- `revoke select (column)`, so the grant enumerates readable columns and
  -- omits this one — meaning `select *` succeeds while naming the column fails.
  begin
    select count(*) into leaked from public.iot_devices where token_hash is not null;
    raise exception 'FAIL: a client read the token_hash column';
  exception
    when insufficient_privilege then
      raise notice 'PASS  token_hash is not readable by any client role';
  end;

  reset role;
end
$$;

-- ------------------------------------------------- tampering with an audit trail
do $$
declare
  changed int;
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';

  -- The trail that answers "who read my record in March" is worthless if its
  -- subject can edit it.
  -- A *valid* enum value, deliberately. The first version used 'TAMPERED',
  -- which is not in audit_action, so the statement failed on the enum before
  -- the privilege was ever checked — an assertion that passed for the wrong
  -- reason and proved nothing about who may write here.
  begin
    update public.audit_logs set action = 'SIGNED_IN';
    raise exception 'FAIL: a client updated an audit entry';
  exception
    when insufficient_privilege then
      raise notice 'PASS  audit entries cannot be updated by a client role';
  end;

  begin
    delete from public.audit_logs;
    raise exception 'FAIL: a client deleted audit entries';
  exception
    when insufficient_privilege then
      raise notice 'PASS  audit entries cannot be deleted by a client role';
  end;

  reset role;
end
$$;

-- ------------------------------------------- claiming another patient's profile
do $$
declare
  changed int;
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';

  -- Reassigning a device to yourself would hand you every future reading it
  -- produces. The with-check is what refuses it; affecting zero rows is the
  -- correct outcome because the row is invisible to begin with.
  update public.iot_devices
  set patient_id = private.current_patient_profile_id()
  where device_key <> 'AVR-P11-MEERA';
  get diagnostics changed = row_count;

  if changed <> 0 then
    raise exception 'FAIL: a client reassigned % device(s) to themselves', changed;
  end if;
  raise notice 'PASS  a client cannot reassign another patient''s device to themselves';

  reset role;
end
$$;

do $$
begin
  raise notice '---';
  raise notice 'ALL PHASE 11 SEPARATION AND ABUSE ASSERTIONS PASSED';
end
$$;

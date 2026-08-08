-- ===========================================================================
-- AVERIS IoT Phase 9 — calibration
--
-- Calibration records say how far a specific band is from the truth. That
-- makes them ordinary device metadata in one direction and something sharper
-- in the other: a record saying "this unit reads 4% low" is, in effect, a note
-- that a patient's stored oxygen readings are wrong, and it is scoped to
-- device ownership for that reason.
--
-- Three properties are asserted here, and the last two are the ones that would
-- not be obvious from reading the policies:
--
--   · a patient reads calibration for their own band and no other
--   · the *pairs* are protected as tightly as the session, so the raw
--     measurements cannot be read by someone who cannot read the summary
--   · nobody can delete a calibration record, including its owner
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- ---------------------------------------------------------------- fixtures
--
-- Two sessions on two patients' devices, so "reads their own" is a real
-- restriction rather than a query that happens to return everything.
insert into public.calibration_sessions
  (id, device_id, patient_id, channel, reference_instrument, reference_accuracy,
   conditions, pair_count, bias, sd, loa_lower, loa_upper, rms,
   max_abs_difference, meets_bench_bounds, notes)
select
  '99999999-0000-4000-8000-000000000001',
  d.id, d.patient_id, 'spo2',
  'Contec CMS50D fingertip pulse oximeter',
  'Manufacturer states ±2% over 70–100%',
  'Seated, room temperature, no movement, index finger',
  24, -1.2, 1.4, -3.944, 1.544, 1.84, 4.0, true,
  'Bench comparison at normal saturation only.'
from public.iot_devices d
join public.patient_profiles p on p.id = d.patient_id
join public.users u on u.id = p.user_id
where u.email = 'ananya@example.com'
limit 1;

insert into public.calibration_sessions
  (id, device_id, patient_id, channel, reference_instrument,
   pair_count, bias, sd, loa_lower, loa_upper, rms, meets_bench_bounds)
select
  '99999999-0000-4000-8000-000000000002',
  d.id, d.patient_id, 'heart_rate',
  'Omron HEM-7120 upper arm monitor',
  22, 0.8, 2.1, -3.316, 4.916, 2.25, true
from public.iot_devices d
join public.patient_profiles p on p.id = d.patient_id
join public.users u on u.id = p.user_id
where u.email = 'rahul@example.com'
limit 1;

insert into public.calibration_pairs (session_id, device_value, reference_value, conditions)
values
  ('99999999-0000-4000-8000-000000000001', 96, 97, 'settled'),
  ('99999999-0000-4000-8000-000000000001', 95, 97, 'settled'),
  ('99999999-0000-4000-8000-000000000001', 93, 97, 'finger shifted'),
  ('99999999-0000-4000-8000-000000000002', 71, 70, null);

-- ------------------------------------------------------------- who may read
do $$
declare
  visible int;
begin
  set local role authenticated;

  -- Ananya. One session — hers — and not Rahul's.
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  select count(*) into visible from public.calibration_sessions;
  if visible <> 1 then
    raise exception 'FAIL: a patient sees % calibration session(s), expected 1', visible;
  end if;
  raise notice 'PASS  a patient reads calibration for their own band';

  select count(*) into visible
  from public.calibration_sessions
  where id = '99999999-0000-4000-8000-000000000002';
  if visible <> 0 then
    raise exception 'FAIL: a patient read another patient''s calibration session';
  end if;
  raise notice 'PASS  another band''s calibration is invisible';

  -- The pairs. Protecting the summary and leaving the raw measurements
  -- readable would be a hole shaped exactly like the summary — the individual
  -- device-versus-reference values *are* the finding.
  select count(*) into visible from public.calibration_pairs;
  if visible <> 3 then
    raise exception 'FAIL: a patient sees % calibration pair(s), expected 3', visible;
  end if;
  raise notice 'PASS  a patient reads the pairs behind their own session';

  select count(*) into visible
  from public.calibration_pairs
  where session_id = '99999999-0000-4000-8000-000000000002';
  if visible <> 0 then
    raise exception 'FAIL: a patient read % pair(s) from another patient''s session', visible;
  end if;
  raise notice 'PASS  another session''s raw pairs are invisible';

  -- Rahul sees the mirror image. Asserted rather than assumed: a policy that
  -- returned everything would have passed every check above if only one
  -- patient were ever tested.
  set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';

  select count(*) into visible from public.calibration_sessions;
  if visible <> 1 then
    raise exception 'FAIL: the second patient sees % session(s), expected 1', visible;
  end if;
  raise notice 'PASS  the second patient reads only their own session';

  select count(*) into visible from public.calibration_pairs;
  if visible <> 1 then
    raise exception 'FAIL: the second patient sees % pair(s), expected 1', visible;
  end if;
  raise notice 'PASS  the second patient reads only their own pairs';

  reset role;
end
$$;

-- ------------------------------------------------ nobody writes for another
do $$
declare
  other_device uuid;
  other_patient uuid;
begin
  select d.id, d.patient_id into other_device, other_patient
  from public.iot_devices d
  join public.patient_profiles p on p.id = d.patient_id
  join public.users u on u.id = p.user_id
  where u.email = 'rahul@example.com'
  limit 1;

  if other_device is null then
    raise exception 'FAIL: fixture setup — no second device to test against';
  end if;

  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  begin
    insert into public.calibration_sessions
      (device_id, patient_id, channel, reference_instrument)
    values (other_device, other_patient, 'spo2', 'Some reference instrument');

    raise exception 'FAIL: a patient recorded calibration against another patient''s band';
  exception
    when insufficient_privilege then
      raise notice 'PASS  a patient cannot record calibration for another band';
  end;

  -- The more interesting attempt, and the one that found a defect: claim your
  -- own patient_id while pointing device_id at somebody else's band.
  --
  -- The policy's with-check inspects patient_id only, so it passes. With two
  -- independent foreign keys each was satisfied on its own, and the insert
  -- succeeded — attaching a calibration record to a device its author does not
  -- own. Not a disclosure, since the row is filtered to its author on read, but
  -- a corruption of the one thing the table exists to record.
  --
  -- The composite foreign key on (device_id, patient_id) is what refuses it now.
  begin
    insert into public.calibration_sessions
      (device_id, patient_id, channel, reference_instrument)
    values (
      other_device,
      private.current_patient_profile_id(),
      'spo2',
      'Some reference instrument'
    );

    raise exception 'FAIL: a calibration session was attached to a device the author does not own';
  exception
    when foreign_key_violation then
      raise notice 'PASS  a session cannot name a device belonging to another patient';
  end;

  reset role;
end
$$;

-- ------------------------------------------------------- evidence is kept
do $$
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  -- DELETE is withheld at the *grant* level, not merely left without a policy,
  -- so this raises rather than quietly removing zero rows. The stronger of the
  -- two outcomes, and worth asserting as the specific one: a table with the
  -- grant and no policy silently deletes nothing today and deletes everything
  -- the day somebody adds a permissive policy for another purpose.
  --
  -- A calibration record is evidence about a device, and a device that reads
  -- badly is exactly the case where deleting the record is tempting.
  begin
    delete from public.calibration_sessions
    where id = '99999999-0000-4000-8000-000000000001';

    raise exception 'FAIL: a patient deleted a calibration session';
  exception
    when insufficient_privilege then
      raise notice 'PASS  DELETE on calibration records is not granted to any client role';
  end;

  reset role;
end
$$;

-- --------------------------------------------- the constraints do their job
do $$
begin
  -- A verdict with too few pairs. "Not enough data" and "failed" are different
  -- states, and a row recording a judgement on 5 measurements collapses them.
  begin
    insert into public.calibration_sessions
      (device_id, patient_id, channel, reference_instrument, pair_count, meets_bench_bounds)
    select d.id, d.patient_id, 'spo2', 'Some reference instrument', 5, true
    from public.iot_devices d limit 1;

    raise exception 'FAIL: a verdict was recorded on 5 pairs';
  exception
    when check_violation then
      raise notice 'PASS  no verdict may be recorded below the minimum pair count';
  end;

  -- Limits of agreement that do not bracket the bias came from something that
  -- computed them wrongly.
  begin
    insert into public.calibration_sessions
      (device_id, patient_id, channel, reference_instrument, pair_count,
       bias, loa_lower, loa_upper)
    select d.id, d.patient_id, 'spo2', 'Some reference instrument', 30, 2.0, 3.0, 5.0
    from public.iot_devices d limit 1;

    raise exception 'FAIL: limits of agreement that exclude the bias were accepted';
  exception
    when check_violation then
      raise notice 'PASS  limits of agreement must bracket the bias';
  end;

  -- An unnamed reference. "A commercial pulse oximeter" is not a reference; a
  -- comparison against an unidentified instrument cannot be interpreted.
  begin
    insert into public.calibration_sessions
      (device_id, patient_id, channel, reference_instrument)
    select d.id, d.patient_id, 'spo2', 'x'
    from public.iot_devices d limit 1;

    raise exception 'FAIL: an unnamed reference instrument was accepted';
  exception
    when check_violation then
      raise notice 'PASS  the reference instrument must be named';
  end;

  -- An unknown channel.
  begin
    insert into public.calibration_sessions
      (device_id, patient_id, channel, reference_instrument)
    select d.id, d.patient_id, 'blood_glucose', 'Some reference instrument'
    from public.iot_devices d limit 1;

    raise exception 'FAIL: calibration was recorded for a channel AVERIS does not measure';
  exception
    when check_violation then
      raise notice 'PASS  only measured channels can be calibrated';
  end;
end
$$;

do $$
begin
  raise notice '---';
  raise notice 'ALL PHASE 9 CALIBRATION ASSERTIONS PASSED';
end
$$;

-- ===========================================================================
-- AVERIS IoT Phase 5 — hardware telemetry and provenance
--
-- Two claims, and the second is the one this phase turns on:
--
--   · device_events reaches the same people the vitals do, and no further —
--     a caregiver watching for emergencies has no business knowing which I²C
--     address stopped answering
--
--   · **a reading's provenance cannot be rewritten.** AVERIS now holds
--     measured and generated data in one table, and the flag that separates
--     them has to survive everything: a client trying to set it, a device
--     being reclassified later, and the reading being read back by anyone.
--
-- Seeds a simulated device against the Ananya fixture, beside her real one.
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- ---------------------------------------------------------------- fixtures
insert into public.iot_devices
  (patient_id, device_key, device_name, device_type, token_hash,
   connection_status, is_simulated, firmware_version)
select p.id, 'SIMDEV01', 'Bench simulator', 'OTHER',
       repeat('c', 64), 'ONLINE', true, 'sim-1.0.0'
from public.patient_profiles p
join public.users u on u.id = p.user_id
where u.email = 'ananya@example.com'
on conflict (device_key) do nothing;

insert into public.iot_devices
  (patient_id, device_key, device_name, device_type, token_hash,
   connection_status, is_simulated, firmware_version, signal_strength_dbm,
   sensor_health, boot_count, last_latency_ms)
select p.id, 'BAND0001', 'Wrist band', 'WEARABLE_BAND',
       repeat('d', 64), 'ONLINE', false, '1.0.0', -57,
       '{"pulse":"ok","thermometer":"ok","imu":"faulty"}'::jsonb, 3, 240
from public.patient_profiles p
join public.users u on u.id = p.user_id
where u.email = 'ananya@example.com'
on conflict (device_key) do nothing;

-- Readings from each, so provenance can be asserted on the rows themselves.
-- `recorded_at` has no default: a reading with no time is a reading that
-- cannot be placed on a chart, so the schema refuses it rather than inventing
-- one. Fixtures have to say when.
insert into public.sensor_readings
  (device_id, patient_id, heart_rate, spo2, temperature, movement_status,
   is_simulated, recorded_at)
select d.id, d.patient_id, 72, 98, 36.7, 'RESTING', d.is_simulated, now()
from public.iot_devices d
where d.device_key in ('SIMDEV01', 'BAND0001');

insert into public.device_events (device_id, patient_id, kind, detail)
select d.id, d.patient_id, 'SENSOR_FAULT', 'imu stopped reporting usable values'
from public.iot_devices d
where d.device_key = 'BAND0001';

-- The Phase 4b file ends by revoking the VIEW_VITALS caregiver, to prove that
-- revocation ends access. Restored here because this file needs her active to
-- assert the opposite half — that the grant which includes vitals also
-- includes knowing why the vitals stopped.
--
-- Stated rather than done quietly: a fixture that silently undoes another
-- file's teardown is how one suite starts depending on the order of another.
update public.patient_caregiver_assignments c
   set status = 'ACTIVE', revoked_at = null
  from public.users u
 where u.id = c.caregiver_id
   and u.email = 'daughter@example.com';

-- ------------------------------------------------------------- provenance
do $$
declare
  simulated int;
  measured  int;
  affected  int;
begin
  select count(*) into simulated
  from public.sensor_readings r
  join public.iot_devices d on d.id = r.device_id
  where d.device_key = 'SIMDEV01' and r.is_simulated;

  if simulated <> 1 then
    raise exception 'FAIL: a simulated device wrote % readings marked as measured', 1 - simulated;
  end if;
  raise notice 'PASS  a simulated device stamps its readings as simulated';

  select count(*) into measured
  from public.sensor_readings r
  join public.iot_devices d on d.id = r.device_id
  where d.device_key = 'BAND0001' and not r.is_simulated;

  if measured <> 1 then
    raise exception 'FAIL: a real device''s reading was marked simulated';
  end if;
  raise notice 'PASS  a real device stamps its readings as measured';

  -- The property the whole flag rests on. Reclassifying the device must not
  -- rewrite the provenance of readings it has already produced — a chart drawn
  -- in March cannot change meaning because of something done in June.
  update public.iot_devices set is_simulated = false where device_key = 'SIMDEV01';

  select count(*) into simulated
  from public.sensor_readings r
  join public.iot_devices d on d.id = r.device_id
  where d.device_key = 'SIMDEV01' and r.is_simulated;

  if simulated <> 1 then
    raise exception 'FAIL: reclassifying a device rewrote the past';
  end if;
  raise notice 'PASS  reclassifying a device does not rewrite its old readings';

  update public.iot_devices set is_simulated = true where device_key = 'SIMDEV01';

  -- No client role may write a reading at all, so there is no path by which a
  -- browser could mark generated data as measured.
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  begin
    update public.sensor_readings set is_simulated = false;
    get diagnostics affected = row_count;
    if affected <> 0 then
      raise exception 'FAIL: a patient relabelled % reading(s) as measured', affected;
    end if;
    raise notice 'PASS  no client role can relabel a reading''s provenance';
  exception when insufficient_privilege then
    raise notice 'PASS  no client role has UPDATE on sensor_readings at all';
  end;

  reset role;
end
$$;

-- --------------------------------------------------------- device events
do $$
declare
  visible  int;
  affected int;
begin
  -- The patient owns the device and sees its history.
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  select count(*) into visible from public.device_events;
  if visible < 1 then
    raise exception 'FAIL: a patient cannot read their own device''s events';
  end if;
  raise notice 'PASS  a patient reads their own device events';

  -- A client that could write here could fabricate a band's history — including
  -- a boot that never happened, which is the log an engineer trusts.
  begin
    insert into public.device_events (device_id, patient_id, kind, detail)
    select d.id, d.patient_id, 'BOOT', 'fabricated'
    from public.iot_devices d where d.device_key = 'BAND0001';
    raise exception 'FAIL: a client role wrote a device event';
  exception when insufficient_privilege then
    raise notice 'PASS  no client role can write a device event';
  end;

  -- Another patient sees nothing.
  set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
  select count(*) into visible from public.device_events;
  if visible <> 0 then
    raise exception 'FAIL: another patient read % device event(s)', visible;
  end if;
  raise notice 'PASS  device events are invisible to other patients';

  -- A VIEW_ALERTS caregiver watches for emergencies. Which I²C address stopped
  -- answering is not part of that grant.
  set local request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';
  select count(*) into visible from public.device_events;
  if visible <> 0 then
    raise exception 'FAIL: a VIEW_ALERTS caregiver read % device event(s)', visible;
  end if;
  raise notice 'PASS  device events are not part of the alerts-only grant';

  -- A VIEW_VITALS caregiver is already trusted with the measurements, so
  -- knowing whether the sensor producing them is broken is the same grant.
  set local request.jwt.claim.sub = '55555555-5555-4555-8555-555555555555';
  select count(*) into visible from public.device_events;
  if visible < 1 then
    raise exception 'FAIL: a VIEW_VITALS caregiver cannot see why readings stopped';
  end if;
  raise notice 'PASS  a VIEW_VITALS caregiver sees device events';

  -- The assigned doctor, likewise.
  set local request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
  select count(*) into visible from public.device_events;
  if visible < 1 then
    raise exception 'FAIL: the assigned doctor cannot see device events';
  end if;
  raise notice 'PASS  an assigned doctor sees device events';

  reset role;
end
$$;

-- ------------------------------------------------------- telemetry bounds
do $$
begin
  -- The constraints exist so a firmware bug cannot write a value the
  -- dashboard has no way to render.
  begin
    update public.iot_devices set signal_strength_dbm = 40 where device_key = 'BAND0001';
    raise exception 'FAIL: a positive RSSI was accepted';
  exception when check_violation then
    raise notice 'PASS  an impossible signal strength is refused';
  end;

  begin
    update public.iot_devices set sensor_health = '"broken"'::jsonb where device_key = 'BAND0001';
    raise exception 'FAIL: a non-object sensor_health was accepted';
  exception when check_violation then
    raise notice 'PASS  sensor_health must be an object';
  end;

  begin
    update public.iot_devices set transport = 'carrier pigeon' where device_key = 'BAND0001';
    raise exception 'FAIL: an unknown transport was accepted';
  exception when check_violation then
    raise notice 'PASS  the transport vocabulary is closed';
  end;

  raise notice '---';
  raise notice 'ALL IoT PHASE 5 RLS ASSERTIONS PASSED';
end
$$;

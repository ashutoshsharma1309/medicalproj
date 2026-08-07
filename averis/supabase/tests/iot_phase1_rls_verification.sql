-- ===========================================================================
-- AVERIS IoT Phase 1 — Row Level Security verification
--
-- The claim this file exists to prove: a patient cannot read another patient's
-- vital signs, and cannot write their own.
--
-- The second half matters as much as the first and is easier to overlook. A
-- patient who could insert into sensor_readings could fabricate their own vital
-- signs — harmless-sounding until the series feeds a risk model or is shown to
-- a clinician, at which point "the patient could have typed this" makes the
-- whole record worthless.
--
-- Runs after the earlier phases, which seed Ananya and Rahul.
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- ---------------------------------------------------------------- fixtures
set role authenticated;

set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
insert into public.iot_devices
  (patient_id, device_key, device_name, device_type, token_hash, connection_status)
values (
  private.current_patient_profile_id(),
  'ANANYA001', 'Ananya band', 'WEARABLE_BAND',
  repeat('a', 64), 'ONLINE'
);

set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
insert into public.iot_devices
  (patient_id, device_key, device_name, device_type, token_hash, connection_status)
values (
  private.current_patient_profile_id(),
  'RAHUL001', 'Rahul band', 'WEARABLE_BAND',
  repeat('b', 64), 'ONLINE'
);

reset role;

-- Readings and alerts are inserted as the owner: no client role may write
-- them, which is itself asserted below.
insert into public.sensor_readings
  (device_id, patient_id, heart_rate, spo2, temperature, movement_status, recorded_at)
select d.id, d.patient_id, 68, 98, 36.7, 'RESTING', now()
from public.iot_devices d where d.device_key = 'ANANYA001';

insert into public.sensor_readings
  (device_id, patient_id, heart_rate, spo2, temperature, movement_status, recorded_at)
select d.id, d.patient_id, 165, 86, 39.7, 'RESTING', now()
from public.iot_devices d where d.device_key = 'RAHUL001';

insert into public.alerts (patient_id, device_id, alert_type, severity, message)
select d.patient_id, d.id, 'SPO2_LOW', 'CRITICAL', 'RAHUL PRIVATE: SpO2 86%'
from public.iot_devices d where d.device_key = 'RAHUL001';

-- ---------------------------------------------------------------- assertions
do $$
declare
  visible        int;
  affected       int;
  rahul_profile  uuid;
  rahul_device   uuid;
  rahul_reading  bigint;
  rahul_alert    uuid;
  ananya_device  uuid;
begin
  select p.id into rahul_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'rahul@example.com';

  select id into rahul_device from public.iot_devices where device_key = 'RAHUL001';
  select id into ananya_device from public.iot_devices where device_key = 'ANANYA001';
  select id into rahul_reading from public.sensor_readings where patient_id = rahul_profile;
  select id into rahul_alert from public.alerts where message like 'RAHUL PRIVATE%';

  ---------------------------------------------------------------- as Ananya
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  ------------------------------------------------------------------ devices
  select count(*) into visible from public.iot_devices;
  if visible <> 1 then
    raise exception 'FAIL: device leak — saw % devices, expected 1', visible;
  end if;
  raise notice 'PASS  iot_devices: patient sees only their own';

  -- The token hash is the credential. A client that could read it could
  -- impersonate the device and write readings as that patient.
  begin
    select count(*) into visible from public.iot_devices where token_hash is not null;
    raise exception 'FAIL: token_hash is readable by a client role';
  exception when insufficient_privilege then
    raise notice 'PASS  token_hash column is not readable by any client';
  end;

  ----------------------------------------------------------------- readings
  select count(*) into visible from public.sensor_readings;
  if visible <> 1 then
    raise exception 'FAIL: reading leak — saw % readings, expected 1', visible;
  end if;
  raise notice 'PASS  sensor_readings: cross-patient read blocked';

  select count(*) into visible from public.sensor_readings where id = rahul_reading;
  if visible <> 0 then
    raise exception 'FAIL: another patient''s vital signs are readable';
  end if;
  raise notice 'PASS  another patient''s vital signs are unreachable';

  -- A patient must not be able to write their own vital signs.
  begin
    insert into public.sensor_readings
      (device_id, patient_id, heart_rate, recorded_at)
    values (ananya_device, private.current_patient_profile_id(), 60, now());
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a patient fabricated % of their own reading(s)', affected;
    end if;
    raise notice 'PASS  patients cannot write their own readings';
  exception when insufficient_privilege then
    raise notice 'PASS  patients have no insert privilege on sensor_readings';
  end;

  begin
    update public.sensor_readings set heart_rate = 60 where patient_id = private.current_patient_profile_id();
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a patient edited % of their own reading(s)', affected;
    end if;
    raise notice 'PASS  readings are append-only for patients';
  exception when insufficient_privilege then
    raise notice 'PASS  patients have no update privilege on sensor_readings';
  end;

  ------------------------------------------------------------------- alerts
  select count(*) into visible from public.alerts;
  if visible <> 0 then
    raise exception 'FAIL: saw % alert(s) belonging to another patient', visible;
  end if;
  raise notice 'PASS  alerts: cross-patient read blocked';

  -- Raising an alert is the system's; acknowledging is the patient's.
  begin
    insert into public.alerts (patient_id, alert_type, severity, message)
    values (private.current_patient_profile_id(), 'SPO2_LOW', 'CRITICAL', 'self-raised');
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a patient raised their own alert';
    end if;
    raise notice 'PASS  patients cannot raise alerts';
  exception when insufficient_privilege then
    raise notice 'PASS  patients have no insert privilege on alerts';
  end;

  update public.alerts set status = 'ACKNOWLEDGED' where id = rahul_alert;
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'FAIL: acknowledged another patient''s alert (% rows)', affected;
  end if;
  raise notice 'PASS  cannot acknowledge another patient''s alert';

  --------------------------------------------------------- cross-patient writes
  update public.iot_devices set device_name = 'stolen' where id = rahul_device;
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'FAIL: renamed another patient''s device (% rows)', affected;
  end if;
  raise notice 'PASS  cross-patient device UPDATE affects zero rows';

  delete from public.iot_devices where id = rahul_device;
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'FAIL: deleted another patient''s device (% rows)', affected;
  end if;
  raise notice 'PASS  cross-patient device DELETE affects zero rows';

  -- Registering a device under someone else would route its readings into
  -- their chart.
  begin
    insert into public.iot_devices
      (patient_id, device_key, device_name, token_hash)
    values (rahul_profile, 'INJECTED1', 'injected', repeat('c', 64));
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: registered % device(s) under another patient', affected;
    end if;
    raise notice 'PASS  WITH CHECK blocks registering under another patient';
  exception when insufficient_privilege then
    raise notice 'PASS  WITH CHECK rejects registering under another patient';
  end;

  -- The classic UPDATE hole: USING passes because you own the row, and a
  -- missing WITH CHECK would let the new owner stick.
  begin
    update public.iot_devices set patient_id = rahul_profile where id = ananya_device;
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: reassigned my own device to another patient';
    end if;
    raise notice 'PASS  WITH CHECK blocks reassigning my own device';
  exception when insufficient_privilege then
    raise notice 'PASS  WITH CHECK rejects reassigning my own device';
  end;

  -- The owner must still be able to work with their own device.
  update public.iot_devices set device_name = 'Renamed band' where id = ananya_device;
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'FAIL: owner cannot rename their own device';
  end if;
  raise notice 'PASS  owner can rename their own device';

  ------------------------------------------------------------ as anonymous
  set local role anon;
  set local request.jwt.claim.sub = '';

  begin
    select count(*) into visible from public.iot_devices;
    raise exception 'FAIL: anon could query iot_devices (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on iot_devices';
  end;

  begin
    select count(*) into visible from public.sensor_readings;
    raise exception 'FAIL: anon could query sensor_readings (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on sensor_readings';
  end;

  begin
    select count(*) into visible from public.alerts;
    raise exception 'FAIL: anon could query alerts (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on alerts';
  end;

  -- resolve_device turns a token into a patient id. Reachable from a client
  -- role, it would be an oracle for enumerating device credentials.
  begin
    perform * from private.resolve_device(repeat('b', 64));
    raise exception 'FAIL: anon could call private.resolve_device';
  exception when insufficient_privilege then
    raise notice 'PASS  anon cannot call private.resolve_device';
  end;

  reset role;
  raise notice '---';
  raise notice 'ALL IoT PHASE 1 RLS ASSERTIONS PASSED';
end
$$;

-- ---------------------------------------------------- constraint assertions
do $$
declare
  owner_profile uuid;
  a_device      uuid;
begin
  select p.id into owner_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'ananya@example.com';
  select id into a_device from public.iot_devices where device_key = 'ANANYA001';

  -- A plaintext token in the hash column would defeat the whole scheme, and
  -- would look completely normal in a code review.
  begin
    insert into public.iot_devices (patient_id, device_key, device_name, token_hash)
    values (owner_profile, 'PLAIN001', 'plaintext', 'avd_this_is_a_raw_token');
    raise exception 'FAIL: a plaintext token was accepted into token_hash';
  exception when check_violation then
    raise notice 'PASS  token_hash must be a SHA-256 hex digest';
  end;

  -- Physiologically impossible values would poison every average computed
  -- from the series.
  begin
    insert into public.sensor_readings (device_id, patient_id, heart_rate, recorded_at)
    values (a_device, owner_profile, 4000, now());
    raise exception 'FAIL: a heart rate of 4000 was accepted';
  exception when check_violation then
    raise notice 'PASS  impossible heart rate rejected';
  end;

  -- ...but an alarming, real one must be storable, or the system discards
  -- exactly the readings it exists to catch.
  insert into public.sensor_readings (device_id, patient_id, heart_rate, spo2, recorded_at)
  values (a_device, owner_profile, 190, 84, now());
  raise notice 'PASS  alarming but physiologically real values are stored';

  begin
    insert into public.sensor_readings (device_id, patient_id, spo2, recorded_at)
    values (a_device, owner_profile, 140, now());
    raise exception 'FAIL: SpO2 of 140%% was accepted';
  exception when check_violation then
    raise notice 'PASS  impossible SpO2 rejected';
  end;

  -- A reading with no measurements is noise on the wire.
  begin
    insert into public.sensor_readings (device_id, patient_id, movement_status, recorded_at)
    values (a_device, owner_profile, 'NORMAL', now());
    raise exception 'FAIL: a reading with no measurements was accepted';
  exception when check_violation then
    raise notice 'PASS  a reading must carry at least one measurement';
  end;

  -- A future timestamp would sit permanently at the top of every "latest"
  -- query, hiding every real reading behind it.
  begin
    insert into public.sensor_readings (device_id, patient_id, heart_rate, recorded_at)
    values (a_device, owner_profile, 70, now() + interval '2 hours');
    raise exception 'FAIL: a far-future reading was accepted';
  exception when check_violation then
    raise notice 'PASS  far-future timestamps rejected';
  end;

  -- Device keys appear in payloads and logs; a permissive shape invites
  -- injection into anything that formats them.
  begin
    insert into public.iot_devices (patient_id, device_key, device_name, token_hash)
    values (owner_profile, 'has space', 'bad key', repeat('d', 64));
    raise exception 'FAIL: a malformed device key was accepted';
  exception when check_violation then
    raise notice 'PASS  device key shape enforced';
  end;

  begin
    insert into public.iot_devices (patient_id, device_key, device_name, token_hash, battery_percentage)
    values (owner_profile, 'BATT001', 'bad battery', repeat('e', 64), 150);
    raise exception 'FAIL: a battery level of 150%% was accepted';
  exception when check_violation then
    raise notice 'PASS  battery percentage constrained to 0..100';
  end;

  -- One device key across the fleet: two devices sharing one would make
  -- readings ambiguous about which produced them.
  begin
    insert into public.iot_devices (patient_id, device_key, device_name, token_hash)
    values (owner_profile, 'ANANYA001', 'duplicate', repeat('f', 64));
    raise exception 'FAIL: a duplicate device key was accepted';
  exception when unique_violation then
    raise notice 'PASS  device keys are unique across the fleet';
  end;
end
$$;

-- ===========================================================================
-- AVERIS — device authentication
--
-- The brief for this suite is "a device can only upload data for its own
-- registered device". That property is **not** enforced by RLS, and saying so
-- plainly is the point of this file: the ingest service holds a service-role
-- key and bypasses row security entirely, because a worker ingesting for a
-- whole fleet cannot be scoped to one signed-in user.
--
-- So the guarantee is built from three things instead, and each is asserted
-- below:
--
--   1. `private.resolve_device` is the *only* way a patient id enters the
--      write path, and it derives that id from the token hash — never from
--      anything the caller sent.
--   2. A retired device does not resolve, so revocation is immediate.
--   3. No client role can write a reading at all, so nothing reachable from a
--      browser can fabricate one.
--
-- The fourth link — that the `device_id` in the payload must match the device
-- the token resolved to — lives in the application, in
-- `sensor_processing_service._validate`, and is covered by the Python suite.
-- It is named here so the boundary between the two is explicit rather than
-- assumed.
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- ---------------------------------------------------------------- fixtures
-- Two patients, one device each. The token hashes are literals rather than
-- real hashes: this file tests the resolution path, not SHA-256.
--
-- The digits are deliberate. `repeat('a',64)` and `repeat('b',64)` are already
-- taken by the Phase 1 fixtures, and every suite shares one database — the
-- first run of this file resolved a token to Phase 1's device and reported it
-- as a wrong-device failure. A fixture that collides with another file's is a
-- test that fails for a reason that has nothing to do with what it tests.
insert into public.iot_devices
  (patient_id, device_key, device_name, device_type, token_hash, connection_status)
select p.id, 'AUTHDEV1', 'Ananya band', 'WEARABLE_BAND', repeat('1', 64), 'ONLINE'
from public.patient_profiles p
join public.users u on u.id = p.user_id
where u.email = 'ananya@example.com'
on conflict (device_key) do nothing;

insert into public.iot_devices
  (patient_id, device_key, device_name, device_type, token_hash, connection_status)
select p.id, 'AUTHDEV2', 'Rahul band', 'WEARABLE_BAND', repeat('2', 64), 'ONLINE'
from public.patient_profiles p
join public.users u on u.id = p.user_id
where u.email = 'rahul@example.com'
on conflict (device_key) do nothing;

do $$
declare
  ananya_profile uuid;
  rahul_profile  uuid;
  resolved       record;
  hits           int;
begin
  select p.id into ananya_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'ananya@example.com';
  select p.id into rahul_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'rahul@example.com';

  -- ── 1. A token resolves to exactly one device and one owner ────────────
  select * into resolved from private.resolve_device(repeat('1', 64));

  if resolved.patient_id is distinct from ananya_profile then
    raise exception 'FAIL: a token resolved to the wrong patient';
  end if;
  if resolved.device_key <> 'AUTHDEV1' then
    raise exception 'FAIL: a token resolved to the wrong device';
  end if;
  raise notice 'PASS  a device token resolves to its own device and owner';

  -- The property that makes cross-patient writes impossible: there is no
  -- argument to this function that names a patient. The owner is a *result*,
  -- not an input, so a device cannot ask to write somewhere else.
  select count(*) into hits from private.resolve_device(repeat('2', 64))
   where patient_id = ananya_profile;
  if hits <> 0 then
    raise exception 'FAIL: one patient''s token resolved to another''s profile';
  end if;
  raise notice 'PASS  a token cannot resolve to another patient''s profile';

  -- ── 2. An unknown token resolves to nothing ────────────────────────────
  select count(*) into hits from private.resolve_device(repeat('9', 64));
  if hits <> 0 then
    raise exception 'FAIL: an unknown token resolved to % device(s)', hits;
  end if;
  raise notice 'PASS  an unregistered token resolves to nothing';

  -- ── 3. Retirement is revocation, and it is immediate ───────────────────
  update public.iot_devices set connection_status = 'RETIRED' where device_key = 'AUTHDEV2';

  select count(*) into hits from private.resolve_device(repeat('2', 64));
  if hits <> 0 then
    raise exception 'FAIL: a RETIRED device still resolves — its token still works';
  end if;
  raise notice 'PASS  retiring a device stops its token resolving immediately';

  update public.iot_devices set connection_status = 'ONLINE' where device_key = 'AUTHDEV2';

  -- ── 4. Rotation invalidates the previous token ─────────────────────────
  update public.iot_devices
     set token_hash = repeat('3', 64), token_issued_at = now()
   where device_key = 'AUTHDEV1';

  select count(*) into hits from private.resolve_device(repeat('1', 64));
  if hits <> 0 then
    raise exception 'FAIL: a rotated-away token still resolves';
  end if;
  raise notice 'PASS  rotation invalidates the previous token';

  select count(*) into hits from private.resolve_device(repeat('3', 64));
  if hits <> 1 then
    raise exception 'FAIL: the new token does not resolve';
  end if;
  raise notice 'PASS  the newly issued token resolves';
end
$$;

-- --------------------------------------------------- what a client cannot do
do $$
declare
  affected int;
  visible  int;
  ananya_device uuid;
  rahul_profile uuid;
begin
  select id into ananya_device from public.iot_devices where device_key = 'AUTHDEV1';
  select p.id into rahul_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'rahul@example.com';

  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  -- The resolution function is SECURITY DEFINER and bypasses RLS. If a client
  -- role could call it, any signed-in user could turn a guessed token hash
  -- into a patient id — which is the whole ingest credential model undone.
  begin
    perform private.resolve_device(repeat('1', 64));
    raise exception 'FAIL: a client role called private.resolve_device';
  exception when insufficient_privilege then
    raise notice 'PASS  no client role can call the device resolver';
  end;

  -- Nothing reachable from a browser can write a reading, so a patient cannot
  -- fabricate their own vitals — and, more importantly, cannot write into
  -- someone else's chart even with a device id in hand.
  begin
    insert into public.sensor_readings (device_id, patient_id, heart_rate, movement_status)
    values (ananya_device, rahul_profile, 72, 'RESTING');
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a client role wrote a sensor reading';
    end if;
    raise notice 'PASS  no client role can write a sensor reading';
  exception when insufficient_privilege then
    raise notice 'PASS  no client role has INSERT on sensor_readings';
  end;

  -- The token hash is the credential. A patient reading their own device row
  -- must not get it back: a dump of what a browser can see should yield
  -- nothing that can write readings.
  begin
    select count(*) into visible from public.iot_devices where token_hash is not null;
    raise exception 'FAIL: a client role selected token_hash (saw % row(s))', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  token_hash is not selectable by a client role';
  end;

  -- A patient can see their own devices — the negative assertions above are
  -- worthless if the whole table is simply unreadable.
  select count(*) into visible from public.iot_devices;
  if visible < 1 then
    raise exception 'FAIL: a patient cannot see their own devices';
  end if;
  raise notice 'PASS  a patient can still read their own devices (% visible)', visible;

  -- And not anyone else's.
  select count(*) into visible from public.iot_devices where patient_id = rahul_profile;
  if visible <> 0 then
    raise exception 'FAIL: a patient read another patient''s device';
  end if;
  raise notice 'PASS  a patient cannot see another patient''s devices';

  reset role;
  raise notice '---';
  raise notice 'ALL DEVICE AUTHENTICATION ASSERTIONS PASSED';
end
$$;

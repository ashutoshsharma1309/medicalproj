-- ===========================================================================
-- AVERIS IoT Phase 7 — personalisation
--
-- Three tables that describe a person rather than a measurement: their learned
-- baseline, the direction they are moving, and their story in sequence.
--
-- The access question is sharper here than elsewhere. A baseline is not a
-- reading — it is a *derived claim about a patient's normal*, and it is
-- exactly the kind of data that would be valuable to someone who should not
-- have it. So it reaches the people who can already see the vitals it was
-- computed from, and nobody else.
--
-- The other property asserted below cannot be expressed as a policy: a
-- baseline must never be *writable* by a client. A patient who could edit
-- their own baseline could change what counts as unusual for them — and the
-- most likely person to do that is one who wants their monitoring to stop
-- complaining.
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- ---------------------------------------------------------------- fixtures
insert into public.patient_baselines
  (patient_id, avg_heart_rate, heart_rate_low, heart_rate_high, heart_rate_iqr,
   avg_spo2, spo2_low, spo2_high, spo2_iqr,
   window_start, window_end, days_covered, sample_count, confidence)
select p.id, 72, 64, 82, 6, 98, 96, 100, 1,
       now() - interval '30 days', now() - interval '2 days', 21, 4200, 0.85
from public.patient_profiles p
join public.users u on u.id = p.user_id
where u.email = 'ananya@example.com';

insert into public.health_trends
  (patient_id, metric, direction, trend_value, total_change, fit, days_observed,
   concerning, window_start, window_end)
select p.id, 'SPO2', 'FALLING', -1.4, -7.0, 0.94, 5, true,
       now() - interval '5 days', now()
from public.patient_profiles p
join public.users u on u.id = p.user_id
where u.email = 'ananya@example.com';

insert into public.risk_events (patient_id, risk_type, severity, explanation)
select p.id, 'TREND_DETECTED', 'WARNING',
       'Blood oxygen has fallen by 7% across 5 days — about 1.4% a day, 98% to 91%.'
from public.patient_profiles p
join public.users u on u.id = p.user_id
where u.email = 'ananya@example.com';

-- ------------------------------------------------------------- who may read
do $$
declare
  visible int;
begin
  -- The patient themselves.
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  select count(*) into visible from public.patient_baselines;
  if visible <> 1 then
    raise exception 'FAIL: a patient cannot read their own baseline';
  end if;
  raise notice 'PASS  a patient reads their own baseline';

  select count(*) into visible from public.health_trends;
  if visible <> 1 then
    raise exception 'FAIL: a patient cannot read their own trends';
  end if;
  raise notice 'PASS  a patient reads their own trends';

  select count(*) into visible from public.risk_events;
  if visible <> 1 then
    raise exception 'FAIL: a patient cannot read their own risk timeline';
  end if;
  raise notice 'PASS  a patient reads their own risk timeline';

  -- Another patient. A baseline is a derived claim about a person, and it is
  -- exactly the kind of data that is valuable to someone who should not have
  -- it.
  set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';

  select count(*) into visible from public.patient_baselines;
  if visible <> 0 then
    raise exception 'FAIL: another patient read % baseline(s)', visible;
  end if;
  raise notice 'PASS  a baseline is invisible to another patient';

  select count(*) into visible from public.risk_events;
  if visible <> 0 then
    raise exception 'FAIL: another patient read % risk event(s)', visible;
  end if;
  raise notice 'PASS  a risk timeline is invisible to another patient';

  -- The assigned doctor. A deviation is meaningless without the baseline it
  -- deviates from: showing "45% above normal" to a clinician who cannot see
  -- the normal is showing them a number they cannot check.
  set local request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';

  select count(*) into visible from public.patient_baselines;
  if visible <> 1 then
    raise exception 'FAIL: the assigned doctor cannot read the baseline';
  end if;
  raise notice 'PASS  an assigned doctor reads the baseline';

  select count(*) into visible from public.risk_events;
  if visible <> 1 then
    raise exception 'FAIL: the assigned doctor cannot read the risk timeline';
  end if;
  raise notice 'PASS  an assigned doctor reads the risk timeline';

  -- A VIEW_ALERTS caregiver. They watch for emergencies; a derived description
  -- of the patient's usual physiology is not part of that grant.
  set local request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';

  select count(*) into visible from public.patient_baselines;
  if visible <> 0 then
    raise exception 'FAIL: a VIEW_ALERTS caregiver read % baseline(s)', visible;
  end if;
  raise notice 'PASS  a baseline is not part of the alerts-only grant';

  select count(*) into visible from public.health_trends;
  if visible <> 0 then
    raise exception 'FAIL: a VIEW_ALERTS caregiver read % trend(s)', visible;
  end if;
  raise notice 'PASS  trends are not part of the alerts-only grant';

  reset role;
end
$$;

-- ------------------------------------------------------- who may not write
do $$
declare
  ananya_profile uuid;
  affected int;
begin
  select p.id into ananya_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'ananya@example.com';

  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  -- The property that matters most in this file. A patient who could write
  -- their own baseline could change what counts as unusual for them — and the
  -- most likely person to want that is one whose monitoring keeps complaining.
  begin
    insert into public.patient_baselines
      (patient_id, avg_heart_rate, heart_rate_low, heart_rate_high,
       window_start, window_end, days_covered, sample_count, confidence)
    values (ananya_profile, 120, 100, 140, now() - interval '10 days', now(), 10, 500, 1.0);
    raise exception 'FAIL: a patient wrote their own baseline';
  exception when insufficient_privilege then
    raise notice 'PASS  no client role can write a baseline';
  end;

  -- Nor edit the one that exists. An append-only table whose rows can be
  -- updated is not append-only.
  begin
    update public.patient_baselines set avg_heart_rate = 120;
    get diagnostics affected = row_count;
    if affected <> 0 then
      raise exception 'FAIL: a patient rewrote % baseline(s)', affected;
    end if;
    raise notice 'PASS  a stored baseline cannot be edited';
  exception when insufficient_privilege then
    raise notice 'PASS  no client role has UPDATE on patient_baselines';
  end;

  -- A fabricated risk event would put a false entry in the story a clinician
  -- reads to understand how a patient got here.
  begin
    insert into public.risk_events (patient_id, risk_type, severity, explanation)
    values (ananya_profile, 'RECOVERY', 'INFO', 'fabricated');
    raise exception 'FAIL: a patient wrote a risk event';
  exception when insufficient_privilege then
    raise notice 'PASS  no client role can write a risk event';
  end;

  begin
    insert into public.health_trends
      (patient_id, metric, direction, trend_value, days_observed, window_start, window_end)
    values (ananya_profile, 'SPO2', 'RISING', 2.0, 5, now() - interval '5 days', now());
    raise exception 'FAIL: a patient wrote a trend';
  exception when insufficient_privilege then
    raise notice 'PASS  no client role can write a trend';
  end;

  reset role;
end
$$;

-- ---------------------------------------------------- constraint assertions
do $$
declare
  ananya_profile uuid;
begin
  select p.id into ananya_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'ananya@example.com';

  -- A range that does not bracket its own median is not a range, and a
  -- clinician shown one would be comparing against nonsense.
  begin
    insert into public.patient_baselines
      (patient_id, avg_heart_rate, heart_rate_low, heart_rate_high,
       window_start, window_end, days_covered, sample_count, confidence)
    values (ananya_profile, 72, 80, 90, now() - interval '10 days', now(), 10, 500, 0.8);
    raise exception 'FAIL: a baseline whose range excludes its median was accepted';
  exception when check_violation then
    raise notice 'PASS  a baseline range must bracket its median';
  end;

  -- A window that ends before it starts describes nothing.
  begin
    insert into public.patient_baselines
      (patient_id, avg_heart_rate, heart_rate_low, heart_rate_high,
       window_start, window_end, days_covered, sample_count, confidence)
    values (ananya_profile, 72, 64, 80, now(), now() - interval '10 days', 10, 500, 0.8);
    raise exception 'FAIL: an inverted window was accepted';
  exception when check_violation then
    raise notice 'PASS  a baseline window must be ordered';
  end;

  -- Confidence is a proportion.
  begin
    insert into public.patient_baselines
      (patient_id, avg_heart_rate, heart_rate_low, heart_rate_high,
       window_start, window_end, days_covered, sample_count, confidence)
    values (ananya_profile, 72, 64, 80, now() - interval '10 days', now(), 10, 500, 1.8);
    raise exception 'FAIL: a confidence above 1 was accepted';
  exception when check_violation then
    raise notice 'PASS  confidence is bounded to 0–1';
  end;

  -- A trend from one day is a point.
  begin
    insert into public.health_trends
      (patient_id, metric, direction, trend_value, days_observed, window_start, window_end)
    values (ananya_profile, 'SPO2', 'FALLING', -2.0, 1, now() - interval '1 day', now());
    raise exception 'FAIL: a one-day trend was accepted';
  exception when check_violation then
    raise notice 'PASS  a trend needs more than one day';
  end;

  raise notice '---';
  raise notice 'ALL IoT PHASE 7 RLS ASSERTIONS PASSED';
end
$$;

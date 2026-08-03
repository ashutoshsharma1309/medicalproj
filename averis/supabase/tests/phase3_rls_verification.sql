-- ===========================================================================
-- AVERIS Phase 3 — Row Level Security verification
--
-- Proves the digital twin cannot leak. The twin is the most sensitive object
-- in AVERIS: it is the *whole* health picture in one place, so a single leaky
-- policy here exposes more than any individual document ever could.
--
-- Runs after 00_local_auth_stub.sql, the Phase 1/2/3 migrations, and the
-- earlier verification files (which seed Ananya and Rahul).
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- ---------------------------------------------------------------- fixtures
set role authenticated;

set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
insert into public.patient_health_timeline
  (patient_id, event_type, event_title, event_date)
values (private.current_patient_profile_id(), 'LAB_RESULT', 'HbA1c: 5.4 %', '2026-01-10');

insert into public.health_conditions (patient_id, condition_name, first_detected)
values (private.current_patient_profile_id(), 'Iron deficiency anaemia', '2025-11-02');

set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
insert into public.patient_health_timeline
  (patient_id, event_type, event_title, event_date)
values (private.current_patient_profile_id(), 'DIAGNOSIS', 'Type 2 Diabetes recorded', '2022-03-04');

insert into public.health_conditions (patient_id, condition_name, first_detected)
values (private.current_patient_profile_id(), 'Type 2 Diabetes', '2022-03-04');

insert into public.medication_history (patient_id, medicine_name, dosage, start_date)
values (private.current_patient_profile_id(), 'Metformin', '500 mg', '2022-03-10');

insert into public.health_insights (patient_id, insight_type, insight_text, importance_level)
values (
  private.current_patient_profile_id(),
  'TREND',
  'Your HbA1c values have increased across 3 reports.',
  'MEDIUM'
);

reset role;

-- ---------------------------------------------------------------- assertions
do $$
declare
  visible          int;
  affected         int;
  rahul_profile    uuid;
  rahul_event      uuid;
  rahul_condition  uuid;
  rahul_medication uuid;
  rahul_insight    uuid;
  ananya_event     uuid;
begin
  select p.id into rahul_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'rahul@example.com';

  select id into rahul_event from public.patient_health_timeline
    where event_title = 'Type 2 Diabetes recorded';
  select id into rahul_condition from public.health_conditions
    where condition_name = 'Type 2 Diabetes';
  select id into rahul_medication from public.medication_history
    where medicine_name = 'Metformin';
  select id into rahul_insight from public.health_insights
    where insight_type = 'TREND';
  select id into ananya_event from public.patient_health_timeline
    where event_title = 'HbA1c: 5.4 %';

  ---------------------------------------------------------------- as Ananya
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  select count(*) into visible from public.patient_health_timeline;
  if visible <> 1 then
    raise exception 'FAIL: timeline leak — saw % events, expected 1', visible;
  end if;
  raise notice 'PASS  patient_health_timeline: patient sees only their own events';

  select count(*) into visible from public.patient_health_timeline where id = rahul_event;
  if visible <> 0 then raise exception 'FAIL: another patient''s timeline event is readable'; end if;
  raise notice 'PASS  patient_health_timeline: cross-patient read blocked';

  select count(*) into visible from public.health_conditions;
  if visible <> 1 then
    raise exception 'FAIL: condition leak — saw % conditions, expected 1', visible;
  end if;
  raise notice 'PASS  health_conditions: cross-patient read blocked';

  select count(*) into visible from public.medication_history;
  if visible <> 0 then
    raise exception 'FAIL: saw % medication rows belonging to another patient', visible;
  end if;
  raise notice 'PASS  medication_history: cross-patient read blocked';

  select count(*) into visible from public.health_insights;
  if visible <> 0 then
    raise exception 'FAIL: saw % insights belonging to another patient', visible;
  end if;
  raise notice 'PASS  health_insights: cross-patient read blocked';

  ------------------------------------------------- cross-patient writes
  update public.patient_health_timeline set event_title = 'tampered' where id = rahul_event;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'FAIL: cross-patient timeline UPDATE modified % row(s)', affected; end if;
  raise notice 'PASS  cross-patient timeline UPDATE affects zero rows';

  update public.health_conditions set current_status = 'RESOLVED' where id = rahul_condition;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'FAIL: cross-patient condition UPDATE modified % row(s)', affected; end if;
  raise notice 'PASS  cross-patient condition UPDATE affects zero rows';

  update public.medication_history set dosage = '9999 mg' where id = rahul_medication;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'FAIL: cross-patient medication UPDATE modified % row(s)', affected; end if;
  raise notice 'PASS  cross-patient medication UPDATE affects zero rows';

  delete from public.health_insights where id = rahul_insight;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'FAIL: cross-patient insight DELETE removed % row(s)', affected; end if;
  raise notice 'PASS  cross-patient insight DELETE affects zero rows';

  delete from public.patient_health_timeline where id = rahul_event;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'FAIL: cross-patient timeline DELETE removed % row(s)', affected; end if;
  raise notice 'PASS  cross-patient timeline DELETE affects zero rows';

  -- Planting an event on someone else's timeline would let one patient write
  -- fiction into another's medical history. WITH CHECK must refuse it.
  begin
    insert into public.patient_health_timeline
      (patient_id, event_type, event_title, event_date)
    values (rahul_profile, 'DIAGNOSIS', 'injected diagnosis', '2026-01-01');
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: planted % timeline event(s) on another patient', affected;
    end if;
    raise notice 'PASS  WITH CHECK blocks planting a timeline event on another patient';
  exception when insufficient_privilege then
    raise notice 'PASS  WITH CHECK rejects planting a timeline event on another patient';
  end;

  begin
    insert into public.health_insights (patient_id, insight_type, insight_text)
    values (rahul_profile, 'REMINDER', 'injected insight');
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: planted % insight(s) on another patient', affected;
    end if;
    raise notice 'PASS  WITH CHECK blocks planting an insight on another patient';
  exception when insufficient_privilege then
    raise notice 'PASS  WITH CHECK rejects planting an insight on another patient';
  end;

  -- Re-assigning one of your own rows to another patient is the classic
  -- UPDATE hole: USING passes because you own it, and without WITH CHECK the
  -- new owner would stick.
  begin
    update public.patient_health_timeline set patient_id = rahul_profile where id = ananya_event;
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: reassigned % of my own timeline events to another patient', affected;
    end if;
    raise notice 'PASS  WITH CHECK blocks reassigning my own event to another patient';
  exception when insufficient_privilege then
    raise notice 'PASS  WITH CHECK rejects reassigning my own event to another patient';
  end;

  -- The owner must still be able to work with their own twin.
  update public.patient_health_timeline set description = 'edited by owner' where id = ananya_event;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'FAIL: owner cannot update their own timeline event'; end if;
  raise notice 'PASS  owner can update their own timeline event';

  ------------------------------------------------------------ as anonymous
  set local role anon;
  set local request.jwt.claim.sub = '';

  begin
    select count(*) into visible from public.patient_health_timeline;
    raise exception 'FAIL: anon could query patient_health_timeline (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on patient_health_timeline';
  end;

  begin
    select count(*) into visible from public.health_conditions;
    raise exception 'FAIL: anon could query health_conditions (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on health_conditions';
  end;

  begin
    select count(*) into visible from public.medication_history;
    raise exception 'FAIL: anon could query medication_history (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on medication_history';
  end;

  begin
    select count(*) into visible from public.health_insights;
    raise exception 'FAIL: anon could query health_insights (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on health_insights';
  end;

  reset role;
  raise notice '---';
  raise notice 'ALL PHASE 3 RLS ASSERTIONS PASSED';
end
$$;

-- ---------------------------------------------------- constraint assertions
do $$
declare
  owner_profile uuid;
begin
  select p.id into owner_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'ananya@example.com';

  -- One row per condition per patient: regenerating the twin must update the
  -- existing condition rather than pile up duplicates.
  begin
    insert into public.health_conditions (patient_id, condition_name)
    values (owner_profile, 'Iron deficiency anaemia');
    raise exception 'FAIL: duplicate condition accepted for the same patient';
  exception when unique_violation then
    raise notice 'PASS  one condition row per patient enforced';
  end;

  -- A medication that ends before it starts is a data-entry error, not history.
  begin
    insert into public.medication_history (patient_id, medicine_name, start_date, end_date)
    values (owner_profile, 'Backwards', '2026-01-01', '2025-01-01');
    raise exception 'FAIL: medication ending before it started was accepted';
  exception when check_violation then
    raise notice 'PASS  medication dates must be ordered';
  end;

  -- Confidence is a probability here too.
  begin
    insert into public.health_insights (patient_id, insight_type, insight_text, confidence_score)
    values (owner_profile, 'TREND', 'out of range', 1.5);
    raise exception 'FAIL: out-of-range insight confidence was accepted';
  exception when check_violation then
    raise notice 'PASS  insight confidence constrained to 0..1';
  end;

  -- An empty event title would render as a blank row on the patient's timeline.
  begin
    insert into public.patient_health_timeline
      (patient_id, event_type, event_title, event_date)
    values (owner_profile, 'OTHER', '   ', '2026-01-01');
    raise exception 'FAIL: blank timeline title was accepted';
  exception when check_violation then
    raise notice 'PASS  timeline events require a non-empty title';
  end;

  begin
    insert into public.health_conditions (patient_id, condition_name)
    values (owner_profile, '  ');
    raise exception 'FAIL: blank condition name was accepted';
  exception when check_violation then
    raise notice 'PASS  conditions require a non-empty name';
  end;

  -- The dashboard iterates over evidence; a non-array would break the page.
  begin
    insert into public.health_insights (patient_id, insight_type, insight_text, evidence)
    values (owner_profile, 'PATTERN', 'bad evidence', '{"not":"an array"}'::jsonb);
    raise exception 'FAIL: non-array evidence was accepted';
  exception when check_violation then
    raise notice 'PASS  insight evidence must be a JSON array';
  end;
end
$$;

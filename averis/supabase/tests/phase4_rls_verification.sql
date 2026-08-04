-- ===========================================================================
-- AVERIS Phase 4 — Row Level Security verification
--
-- A stored risk score attached to a named person is the most sensitive row
-- AVERIS holds. "Ananya, 78% diabetes risk" is a sentence that must never be
-- readable by anyone else, and unlike a lab value it is a conclusion — it
-- needs no interpretation to do harm.
--
-- Also asserts the deliberate asymmetry: model_metrics is world-readable to
-- signed-in users and writable by none, because a patient told they are in a
-- higher-risk band is entitled to see how often that model is right.
--
-- Runs after the earlier phases, which seed Ananya and Rahul.
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- ---------------------------------------------------------------- fixtures
set role authenticated;

set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
insert into public.health_predictions
  (patient_id, prediction_type, risk_score, risk_category, model_version, confidence_score, explanation)
values (
  private.current_patient_profile_id(), 'DIABETES', 0.2100, 'LOW', 'v1', 0.640,
  '{"narrative":"ananya"}'::jsonb
);

set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
insert into public.health_predictions
  (patient_id, prediction_type, risk_score, risk_category, model_version, confidence_score, explanation)
values (
  private.current_patient_profile_id(), 'CARDIOVASCULAR', 0.7800, 'HIGH', 'v1', 0.820,
  '{"narrative":"rahul"}'::jsonb
);

reset role;

-- model_metrics carries no patient data, so it is seeded as the owner.
insert into public.model_metrics
  (model_name, model_version, algorithm, dataset, accuracy, precision, recall, f1_score, roc_auc, is_serving)
values ('diabetes', 'v1', 'logistic_regression', 'Pima Indians Diabetes',
        0.7143, 0.5926, 0.5926, 0.5926, 0.8080, true);

-- ---------------------------------------------------------------- assertions
do $$
declare
  visible       int;
  affected      int;
  rahul_profile uuid;
  rahul_row     uuid;
  ananya_row    uuid;
begin
  select p.id into rahul_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'rahul@example.com';

  select id into rahul_row from public.health_predictions
    where prediction_type = 'CARDIOVASCULAR';
  select id into ananya_row from public.health_predictions
    where prediction_type = 'DIABETES';

  ---------------------------------------------------------------- as Ananya
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  select count(*) into visible from public.health_predictions;
  if visible <> 1 then
    raise exception 'FAIL: prediction leak — saw % rows, expected 1', visible;
  end if;
  raise notice 'PASS  health_predictions: patient sees only their own assessments';

  select count(*) into visible from public.health_predictions where id = rahul_row;
  if visible <> 0 then
    raise exception 'FAIL: another patient''s risk score is readable';
  end if;
  raise notice 'PASS  health_predictions: cross-patient read blocked';

  delete from public.health_predictions where id = rahul_row;
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'FAIL: cross-patient prediction DELETE removed % row(s)', affected;
  end if;
  raise notice 'PASS  cross-patient prediction DELETE affects zero rows';

  -- Filing a risk score under another patient would put a conclusion in
  -- someone else's record that no model ever produced about them.
  begin
    insert into public.health_predictions
      (patient_id, prediction_type, risk_score, risk_category, model_version)
    values (rahul_profile, 'DIABETES', 0.9900, 'HIGH', 'v1');
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: filed % prediction(s) under another patient', affected;
    end if;
    raise notice 'PASS  WITH CHECK blocks filing a prediction under another patient';
  exception when insufficient_privilege then
    raise notice 'PASS  WITH CHECK rejects filing a prediction under another patient';
  end;

  -- There is no UPDATE policy at all: a prediction records what a model
  -- produced at a point in time, and an editable one makes its own stored
  -- explanation a lie. Even the owner must not be able to rewrite the score.
  begin
    update public.health_predictions set risk_score = 0.0100 where id = ananya_row;
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a patient rewrote their own stored risk score';
    end if;
    raise notice 'PASS  predictions are immutable even to their owner';
  exception when insufficient_privilege then
    raise notice 'PASS  predictions are immutable even to their owner (no grant)';
  end;

  -- The owner can still read and remove their own assessment.
  select count(*) into visible from public.health_predictions where id = ananya_row;
  if visible <> 1 then raise exception 'FAIL: owner cannot read their own prediction'; end if;
  raise notice 'PASS  owner can read their own prediction';

  ------------------------------------------------------------ model_metrics
  select count(*) into visible from public.model_metrics;
  if visible < 1 then
    raise exception 'FAIL: a signed-in patient cannot read model performance';
  end if;
  raise notice 'PASS  model_metrics readable by a signed-in patient';

  begin
    insert into public.model_metrics (model_name, model_version, algorithm, dataset, roc_auc)
    values ('diabetes', 'v1', 'forged', 'forged', 0.9999);
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a patient inserted % model metric row(s)', affected;
    end if;
    raise notice 'PASS  patients cannot write model metrics';
  exception when insufficient_privilege then
    raise notice 'PASS  patients have no insert privilege on model_metrics';
  end;

  begin
    update public.model_metrics set roc_auc = 0.9999;
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a patient rewrote % model metric row(s)', affected;
    end if;
    raise notice 'PASS  patients cannot alter model metrics';
  exception when insufficient_privilege then
    raise notice 'PASS  patients have no update privilege on model_metrics';
  end;

  ------------------------------------------------------------ as anonymous
  set local role anon;
  set local request.jwt.claim.sub = '';

  begin
    select count(*) into visible from public.health_predictions;
    raise exception 'FAIL: anon could query health_predictions (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on health_predictions';
  end;

  begin
    select count(*) into visible from public.model_metrics;
    raise exception 'FAIL: anon could query model_metrics (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on model_metrics';
  end;

  reset role;
  raise notice '---';
  raise notice 'ALL PHASE 4 RLS ASSERTIONS PASSED';
end
$$;

-- ---------------------------------------------------- constraint assertions
do $$
declare owner_profile uuid;
begin
  select p.id into owner_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'ananya@example.com';

  -- A risk score is a probability. Anything else is a bug upstream, and
  -- storing it would render as a nonsensical percentage on the dashboard.
  begin
    insert into public.health_predictions
      (patient_id, prediction_type, risk_score, risk_category, model_version)
    values (owner_profile, 'DIABETES', 1.5000, 'HIGH', 'v1');
    raise exception 'FAIL: a risk score above 1 was accepted';
  exception when check_violation then
    raise notice 'PASS  risk score constrained to 0..1';
  end;

  begin
    insert into public.health_predictions
      (patient_id, prediction_type, risk_score, risk_category, model_version, confidence_score)
    values (owner_profile, 'DIABETES', 0.5000, 'MODERATE', 'v1', 2.0);
    raise exception 'FAIL: out-of-range confidence was accepted';
  exception when check_violation then
    raise notice 'PASS  confidence constrained to 0..1';
  end;

  -- Provenance is the whole point of storing a prediction. A row that cannot
  -- say which model produced it is unauditable.
  begin
    insert into public.health_predictions
      (patient_id, prediction_type, risk_score, risk_category, model_version)
    values (owner_profile, 'DIABETES', 0.5000, 'MODERATE', '   ');
    raise exception 'FAIL: a blank model version was accepted';
  exception when check_violation then
    raise notice 'PASS  predictions must name the model version that produced them';
  end;

  -- The dashboard reads explanation as an object.
  begin
    insert into public.health_predictions
      (patient_id, prediction_type, risk_score, risk_category, model_version, explanation)
    values (owner_profile, 'DIABETES', 0.5000, 'MODERATE', 'v1', '["not","an","object"]'::jsonb);
    raise exception 'FAIL: a non-object explanation was accepted';
  exception when check_violation then
    raise notice 'PASS  explanation must be a JSON object';
  end;

  -- Re-running a training pass must update the row, not accumulate copies.
  begin
    insert into public.model_metrics (model_name, model_version, algorithm, dataset, roc_auc)
    values ('diabetes', 'v1', 'logistic_regression', 'Pima Indians Diabetes', 0.8080);
    raise exception 'FAIL: a duplicate training run was accepted';
  exception when unique_violation then
    raise notice 'PASS  one metrics row per model, version and algorithm';
  end;
end
$$;

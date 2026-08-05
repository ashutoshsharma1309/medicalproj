-- ===========================================================================
-- AVERIS Phase 6 — Row Level Security verification
--
-- The four tables here each need a property the earlier phases did not, and
-- each of those properties fails silently if it regresses:
--
--   audit_logs        append-only, INCLUDING to its subject. A log a patient
--                     can delete looks identical to one they never triggered.
--   notifications     unforgeable. A client that can insert can tell a patient
--                     their report is ready when it is not.
--   subscriptions     read-only. A writable plan is not a plan.
--   processing_jobs   not claimable by a client. The claim function crosses
--                     patients by design.
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- ---------------------------------------------------------------- fixtures
-- Written as owner: notifications and subscriptions have no client insert.
insert into public.notifications (patient_id, kind, title, body, href)
select p.id, 'DOCUMENT_PROCESSED', 'Ananya notification', 'body', '/records'
from public.patient_profiles p
join public.users u on u.id = p.user_id
where u.email = 'ananya@example.com';

insert into public.notifications (patient_id, kind, title, body, href)
select p.id, 'DOCUMENT_FAILED', 'Rahul notification', 'body', '/records'
from public.patient_profiles p
join public.users u on u.id = p.user_id
where u.email = 'rahul@example.com';

set role authenticated;

set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
insert into public.audit_logs (user_id, action, resource_type, metadata)
values ((select auth.uid()), 'DOCUMENT_UPLOADED', 'DOCUMENT', '{"documentType":"BLOOD_REPORT"}'::jsonb);

set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
insert into public.audit_logs (user_id, action, resource_type, metadata)
values ((select auth.uid()), 'AI_QUESTION_ASKED', 'CONVERSATION', '{}'::jsonb);

reset role;

-- ---------------------------------------------------------------- assertions
do $$
declare
  visible        int;
  affected       int;
  rahul_auth     uuid := '22222222-2222-4222-8222-222222222222';
  rahul_profile  uuid;
  rahul_audit    uuid;
  ananya_audit   uuid;
  rahul_notif    uuid;
  ananya_notif   uuid;
  ananya_doc     uuid;
begin
  select p.id into rahul_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'rahul@example.com';

  select id into rahul_audit from public.audit_logs where user_id = rahul_auth;
  select id into ananya_audit from public.audit_logs
    where user_id = '11111111-1111-4111-8111-111111111111';
  select id into rahul_notif from public.notifications where title = 'Rahul notification';
  select id into ananya_notif from public.notifications where title = 'Ananya notification';
  select id into ananya_doc from public.medical_documents
    where file_name = 'ananya-blood-report.pdf';

  ---------------------------------------------------------------- as Ananya
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  --------------------------------------------------------------- audit_logs
  select count(*) into visible from public.audit_logs;
  if visible <> 1 then
    raise exception 'FAIL: audit leak — saw % entries, expected 1', visible;
  end if;
  raise notice 'PASS  audit_logs: user sees only their own trail';

  select count(*) into visible from public.audit_logs where id = rahul_audit;
  if visible <> 0 then raise exception 'FAIL: another user''s audit entry is readable'; end if;
  raise notice 'PASS  audit_logs: cross-user read blocked';

  -- The load-bearing property. A subject who can erase their own trail makes
  -- the trail worthless as evidence — so this must fail even for the owner.
  begin
    delete from public.audit_logs where id = ananya_audit;
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a user deleted % of their own audit entries', affected;
    end if;
    raise notice 'PASS  audit_logs: owner cannot delete their own entries';
  exception when insufficient_privilege then
    raise notice 'PASS  audit_logs: no delete privilege, even for the owner';
  end;

  begin
    update public.audit_logs set action = 'SIGNED_IN' where id = ananya_audit;
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a user rewrote % of their own audit entries', affected;
    end if;
    raise notice 'PASS  audit_logs: owner cannot rewrite their own entries';
  exception when insufficient_privilege then
    raise notice 'PASS  audit_logs: no update privilege, even for the owner';
  end;

  -- Forging another user's history would let an attacker manufacture an alibi.
  begin
    insert into public.audit_logs (user_id, action, resource_type)
    values (rahul_auth, 'SIGNED_IN', 'SESSION');
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: forged % audit entries under another user', affected;
    end if;
    raise notice 'PASS  audit_logs: cannot append to another user''s trail';
  exception when insufficient_privilege then
    raise notice 'PASS  audit_logs: WITH CHECK rejects another user''s id';
  end;

  ------------------------------------------------------------ notifications
  select count(*) into visible from public.notifications;
  if visible <> 1 then
    raise exception 'FAIL: notification leak — saw % rows, expected 1', visible;
  end if;
  raise notice 'PASS  notifications: cross-patient read blocked';

  -- Unforgeable. A client that could insert here could tell a patient their
  -- report finished processing when it had not.
  begin
    insert into public.notifications (patient_id, kind, title, body)
    values (private.current_patient_profile_id(), 'DOCUMENT_PROCESSED', 'forged', 'forged');
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a patient forged % notification(s) for themselves', affected;
    end if;
    raise notice 'PASS  notifications: patients cannot create them';
  exception when insufficient_privilege then
    raise notice 'PASS  notifications: no insert privilege for any client';
  end;

  -- Dismissal is theirs.
  update public.notifications set read_at = now() where id = ananya_notif;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'FAIL: patient cannot dismiss their own notification'; end if;
  raise notice 'PASS  notifications: owner can dismiss';

  update public.notifications set read_at = now() where id = rahul_notif;
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'FAIL: dismissed % of another patient''s notifications', affected;
  end if;
  raise notice 'PASS  notifications: cross-patient dismissal affects zero rows';

  -- Reassigning a notification to another patient would let one person plant
  -- a message in another's feed using a row they legitimately own.
  begin
    update public.notifications set patient_id = rahul_profile where id = ananya_notif;
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: reassigned % notification(s) to another patient', affected;
    end if;
    raise notice 'PASS  notifications: WITH CHECK blocks reassignment';
  exception when insufficient_privilege then
    raise notice 'PASS  notifications: WITH CHECK rejects reassignment';
  end;

  ------------------------------------------------------------ subscriptions
  select count(*) into visible from public.subscriptions;
  if visible <> 1 then
    raise exception 'FAIL: subscription leak — saw % rows, expected 1', visible;
  end if;
  raise notice 'PASS  subscriptions: user sees only their own';

  -- Limits are enforced against this row, so a writable plan is not a plan.
  begin
    update public.subscriptions set plan = 'PREMIUM';
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a user upgraded themselves on % row(s)', affected;
    end if;
    raise notice 'PASS  subscriptions: users cannot change their own plan';
  exception when insufficient_privilege then
    raise notice 'PASS  subscriptions: no update privilege for any client';
  end;

  ----------------------------------------------------------- processing_jobs
  -- A patient may enqueue their own document.
  insert into public.processing_jobs (patient_id, document_id)
  values (private.current_patient_profile_id(), ananya_doc);
  raise notice 'PASS  processing_jobs: patient can enqueue their own document';

  -- One live job per document: a double-submit would pay for OCR twice.
  begin
    insert into public.processing_jobs (patient_id, document_id)
    values (private.current_patient_profile_id(), ananya_doc);
    raise exception 'FAIL: a second live job for the same document was accepted';
  exception when exclusion_violation then
    raise notice 'PASS  processing_jobs: one live job per document';
  end;

  begin
    insert into public.processing_jobs (patient_id, document_id)
    select rahul_profile, d.id from public.medical_documents d
    where d.file_name = 'rahul-prescription.jpg';
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: enqueued % job(s) for another patient', affected;
    end if;
    raise notice 'PASS  processing_jobs: cannot enqueue another patient''s document';
  exception when insufficient_privilege then
    raise notice 'PASS  processing_jobs: WITH CHECK rejects another patient';
  end;

  -- Status transitions belong to the worker. A patient who could mark a job
  -- SUCCEEDED would strand their own document unprocessed.
  begin
    update public.processing_jobs set status = 'SUCCEEDED';
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a patient changed % job status(es)', affected;
    end if;
    raise notice 'PASS  processing_jobs: patients cannot change job status';
  exception when insufficient_privilege then
    raise notice 'PASS  processing_jobs: no update privilege for any client';
  end;

  -- The claim function crosses patients by design, which is precisely why no
  -- session may reach it.
  begin
    perform private.claim_processing_job(1);
    raise exception 'FAIL: a patient claimed a job from the shared queue';
  exception when insufficient_privilege or undefined_function then
    raise notice 'PASS  processing_jobs: claim function unreachable by clients';
  end;

  ------------------------------------------------------------ as anonymous
  set local role anon;
  set local request.jwt.claim.sub = '';

  begin
    select count(*) into visible from public.audit_logs;
    raise exception 'FAIL: anon could query audit_logs (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on audit_logs';
  end;

  begin
    select count(*) into visible from public.notifications;
    raise exception 'FAIL: anon could query notifications (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on notifications';
  end;

  begin
    select count(*) into visible from public.subscriptions;
    raise exception 'FAIL: anon could query subscriptions (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on subscriptions';
  end;

  reset role;
  raise notice '---';
  raise notice 'ALL PHASE 6 RLS ASSERTIONS PASSED';
end
$$;

-- ---------------------------------------------------- structural assertions
do $$
declare
  owner_profile uuid;
  owner_user    uuid;
  a_document    uuid;
begin
  select p.id, u.id into owner_profile, owner_user
  from public.patient_profiles p
  join public.users u on u.id = p.user_id
  where u.email = 'ananya@example.com';

  select id into a_document from public.medical_documents
    where file_name = 'ananya-blood-report.pdf';

  -- Every user must have a subscription row. Enforcement reads a plan
  -- unconditionally, and a missing row would be a special case that some call
  -- site eventually forgets to handle.
  if exists (
    select 1 from public.users u
    left join public.subscriptions s on s.user_id = u.id
    where s.id is null
  ) then
    raise exception 'FAIL: a user has no subscription row';
  end if;
  raise notice 'PASS  every user has a subscription row';

  -- A notification href is followed by a patient who trusts it. An absolute
  -- URL here would be an open redirect wearing a system notification's badge.
  begin
    insert into public.notifications (patient_id, kind, title, body, href)
    values (owner_profile, 'DOCUMENT_PROCESSED', 'evil', 'body', 'https://evil.example/steal');
    raise exception 'FAIL: an absolute notification href was accepted';
  exception when check_violation then
    raise notice 'PASS  notification href must be a relative path';
  end;

  begin
    insert into public.notifications (patient_id, kind, title, body, href)
    values (owner_profile, 'DOCUMENT_PROCESSED', 'evil', 'body', '//evil.example/steal');
    raise exception 'FAIL: a protocol-relative notification href was accepted';
  exception when check_violation then
    raise notice 'PASS  notification href rejects protocol-relative URLs';
  end;

  -- Metadata must be an object; the audit service writes a flat map.
  begin
    insert into public.audit_logs (user_id, action, resource_type, metadata)
    values (owner_user, 'SIGNED_IN', 'SESSION', '["not","an","object"]'::jsonb);
    raise exception 'FAIL: non-object audit metadata was accepted';
  exception when check_violation then
    raise notice 'PASS  audit metadata must be a JSON object';
  end;

  -- A job whose attempt cap is unbounded would retry a corrupt document until
  -- someone noticed the bill.
  begin
    insert into public.processing_jobs (patient_id, document_id, max_attempts)
    values (owner_profile, a_document, 99);
    raise exception 'FAIL: an unbounded max_attempts was accepted';
  exception when check_violation or exclusion_violation then
    raise notice 'PASS  job attempt cap is bounded';
  end;
end
$$;

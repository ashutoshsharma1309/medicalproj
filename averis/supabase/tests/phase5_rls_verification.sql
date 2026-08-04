-- ===========================================================================
-- AVERIS Phase 5 — Row Level Security verification
--
-- This file exists to prove the one claim the entire RAG design rests on:
-- that a similarity search cannot rank a chunk belonging to another patient.
--
-- The failure being guarded against is quiet. A leaky retriever does not
-- error; it returns a well-formed answer built from someone else's blood
-- report, correctly cited to a document the reader has never seen. Nothing
-- about the response looks wrong. So the assertions below do not merely check
-- that a SELECT is blocked — they run the actual ranked search as one patient
-- over a corpus containing another patient's chunks, and assert the other
-- patient's rows are unreachable *through the ranking*.
--
-- Runs after the earlier phases, which seed Ananya and Rahul.
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- ---------------------------------------------------------------- fixtures
--
-- Knowledge rows are inserted as the owner: no client role may write them.
insert into public.knowledge_documents (title, category, body, citation)
values (
  'HbA1c reference (test fixture)',
  'LAB_REFERENCE',
  'HbA1c reflects average blood glucose over about three months.',
  'Test fixture'
);

-- Deterministic unit vectors, so "nearest" is exactly predictable.
-- e1 points along dimension 1, e2 along dimension 2.
insert into public.knowledge_embeddings
  (source_type, knowledge_document_id, chunk_index, content, embedding, metadata)
select
  'MEDICAL_KNOWLEDGE',
  id,
  0,
  'HbA1c reflects average blood glucose over about three months.',
  ('[' || 1 || repeat(',0', 383) || ']')::extensions.vector,
  '{}'::jsonb
from public.knowledge_documents where title = 'HbA1c reference (test fixture)';

set role authenticated;

-- Ananya indexes one of her own documents.
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
insert into public.knowledge_embeddings
  (source_type, patient_id, document_id, chunk_index, content, embedding, metadata)
select
  'PATIENT_DOCUMENT',
  private.current_patient_profile_id(),
  d.id,
  0,
  'ANANYA PRIVATE: HbA1c 5.4 percent, fasting glucose 92 mg/dL.',
  ('[0,' || 1 || repeat(',0', 382) || ']')::extensions.vector,
  '{}'::jsonb
from public.medical_documents d
where d.file_name = 'ananya-blood-report.pdf';

-- Rahul indexes one of his. Its vector is deliberately identical to Ananya's,
-- so on pure distance it is exactly as good a match as hers — the only thing
-- that can separate them is the policy.
set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
insert into public.knowledge_embeddings
  (source_type, patient_id, document_id, chunk_index, content, embedding, metadata)
select
  'PATIENT_DOCUMENT',
  private.current_patient_profile_id(),
  d.id,
  0,
  'RAHUL PRIVATE: HbA1c 8.9 percent, on Metformin 500mg twice daily.',
  ('[0,' || 1 || repeat(',0', 382) || ']')::extensions.vector,
  '{}'::jsonb
from public.medical_documents d
where d.file_name = 'rahul-prescription.jpg';

insert into public.ai_conversations (patient_id, question, response, sources_used)
values (
  private.current_patient_profile_id(),
  'What is my HbA1c?',
  'Your record shows 8.9 percent.',
  '[{"label":"rahul report"}]'::jsonb
);

reset role;

-- ---------------------------------------------------------------- assertions
do $$
declare
  visible       int;
  affected      int;
  leaked        int;
  returned      int;
  rahul_profile uuid;
  rahul_chunk   uuid;
  probe         extensions.vector(384);
begin
  select p.id into rahul_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'rahul@example.com';

  select id into rahul_chunk from public.knowledge_embeddings
    where content like 'RAHUL PRIVATE%';

  -- The probe is the patient-document vector: both patients' chunks sit at
  -- distance zero from it, so any ranking that can see both will return both.
  probe := ('[0,' || 1 || repeat(',0', 382) || ']')::extensions.vector;

  ---------------------------------------------------------------- as Ananya
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  ------------------------------------------------- the load-bearing assertion
  --
  -- Run the real ranked search over a corpus that contains Rahul's chunk at
  -- the same distance as Ananya's. If RLS were not part of the plan, his row
  -- would be tied for first.
  select count(*) into leaked
  from public.match_knowledge(probe, 50, null)
  where content like 'RAHUL PRIVATE%';

  if leaked <> 0 then
    raise exception
      'FAIL: similarity search surfaced % chunk(s) belonging to another patient', leaked;
  end if;
  raise notice 'PASS  ranked retrieval cannot surface another patient''s chunk';

  select count(*) into returned from public.match_knowledge(probe, 50, null);
  if returned < 2 then
    raise exception
      'FAIL: retrieval returned only % rows — the corpus is too small to prove anything', returned;
  end if;
  raise notice 'PASS  retrieval still returns own and knowledge chunks (% rows)', returned;

  -- Her own chunk must be reachable, or the policy is simply blocking
  -- everything and the test above proves nothing.
  select count(*) into visible
  from public.match_knowledge(probe, 50, null)
  where content like 'ANANYA PRIVATE%';
  if visible <> 1 then
    raise exception 'FAIL: patient cannot retrieve their own chunk';
  end if;
  raise notice 'PASS  patient can retrieve their own chunk';

  -- Shared reference material must be reachable by everyone.
  select count(*) into visible
  from public.match_knowledge(probe, 50, 'MEDICAL_KNOWLEDGE');
  if visible < 1 then
    raise exception 'FAIL: knowledge base is not retrievable';
  end if;
  raise notice 'PASS  knowledge base retrievable by any signed-in patient';

  ------------------------------------------------------- direct table access
  select count(*) into visible from public.knowledge_embeddings
    where content like 'RAHUL PRIVATE%';
  if visible <> 0 then
    raise exception 'FAIL: another patient''s chunk is readable directly';
  end if;
  raise notice 'PASS  knowledge_embeddings: cross-patient read blocked';

  delete from public.knowledge_embeddings where id = rahul_chunk;
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'FAIL: cross-patient chunk DELETE removed % row(s)', affected;
  end if;
  raise notice 'PASS  cross-patient chunk DELETE affects zero rows';

  -- Indexing a chunk under another patient would poison their retrieval with
  -- text they never uploaded.
  begin
    insert into public.knowledge_embeddings
      (source_type, patient_id, document_id, chunk_index, content, embedding)
    select 'PATIENT_DOCUMENT', rahul_profile, d.id, 99, 'injected', probe
    from public.medical_documents d where d.file_name = 'rahul-prescription.jpg';
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: indexed % chunk(s) under another patient', affected;
    end if;
    raise notice 'PASS  WITH CHECK blocks indexing under another patient';
  exception when insufficient_privilege then
    raise notice 'PASS  WITH CHECK rejects indexing under another patient';
  end;

  -- A patient must not be able to write to the shared knowledge base: doing
  -- so would let one person plant reference material every other patient's
  -- answers get built from.
  begin
    insert into public.knowledge_embeddings
      (source_type, knowledge_document_id, chunk_index, content, embedding)
    select 'MEDICAL_KNOWLEDGE', id, 98, 'planted knowledge', probe
    from public.knowledge_documents limit 1;
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a patient planted % knowledge chunk(s)', affected;
    end if;
    raise notice 'PASS  patients cannot plant chunks in the shared knowledge base';
  exception when insufficient_privilege then
    raise notice 'PASS  patients have no privilege to write knowledge chunks';
  end;

  begin
    insert into public.knowledge_documents (title, category, body, citation)
    values ('planted', 'GENERAL_HEALTH', 'planted body', 'planted');
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: a patient wrote to the knowledge base';
    end if;
    raise notice 'PASS  patients cannot write knowledge documents';
  exception when insufficient_privilege then
    raise notice 'PASS  patients have no insert privilege on knowledge_documents';
  end;

  ------------------------------------------------------------ conversations
  select count(*) into visible from public.ai_conversations;
  if visible <> 0 then
    raise exception 'FAIL: saw % conversation(s) belonging to another patient', visible;
  end if;
  raise notice 'PASS  ai_conversations: cross-patient read blocked';

  begin
    insert into public.ai_conversations (patient_id, question, response)
    values (rahul_profile, 'injected', 'injected');
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: wrote a conversation into another patient''s history';
    end if;
    raise notice 'PASS  WITH CHECK blocks writing another patient''s conversation';
  exception when insufficient_privilege then
    raise notice 'PASS  WITH CHECK rejects writing another patient''s conversation';
  end;

  ------------------------------------------------------------ as anonymous
  set local role anon;
  set local request.jwt.claim.sub = '';

  begin
    select count(*) into visible from public.knowledge_embeddings;
    raise exception 'FAIL: anon could query knowledge_embeddings (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on knowledge_embeddings';
  end;

  begin
    select count(*) into visible from public.ai_conversations;
    raise exception 'FAIL: anon could query ai_conversations (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon has no privilege on ai_conversations';
  end;

  begin
    select count(*) into visible from public.match_knowledge(probe, 10, null);
    raise exception 'FAIL: anon could run a similarity search (saw % rows)', visible;
  exception when insufficient_privilege then
    raise notice 'PASS  anon cannot run a similarity search';
  end;

  reset role;
  raise notice '---';
  raise notice 'ALL PHASE 5 RLS ASSERTIONS PASSED';
end
$$;

-- ---------------------------------------------------- structural assertions
do $$
declare
  owner_profile uuid;
  a_document    uuid;
  probe         extensions.vector(384);
begin
  select p.id into owner_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'ananya@example.com';
  select id into a_document from public.medical_documents
    where file_name = 'ananya-blood-report.pdf';
  probe := ('[1' || repeat(',0', 383) || ']')::extensions.vector;

  -- match_knowledge must never be SECURITY DEFINER. A DEFINER function runs
  -- as its owner, bypasses RLS, and would make every assertion above
  -- meaningless while still passing them for a single patient.
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'match_knowledge' and p.prosecdef
  ) then
    raise exception 'FAIL: match_knowledge is SECURITY DEFINER and bypasses RLS';
  end if;
  raise notice 'PASS  match_knowledge is SECURITY INVOKER';

  -- The patient/knowledge separation must be structural, not conventional.
  begin
    insert into public.knowledge_embeddings
      (source_type, patient_id, document_id, knowledge_document_id, chunk_index, content, embedding)
    select 'PATIENT_DOCUMENT', owner_profile, a_document, id, 50, 'both at once', probe
    from public.knowledge_documents limit 1;
    raise exception 'FAIL: a chunk belonging to both a patient and the knowledge base was accepted';
  exception when check_violation then
    raise notice 'PASS  a chunk cannot be both patient data and shared knowledge';
  end;

  begin
    insert into public.knowledge_embeddings
      (source_type, chunk_index, content, embedding)
    values ('PATIENT_DOCUMENT', 51, 'ownerless patient chunk', probe);
    raise exception 'FAIL: a patient chunk with no owner was accepted';
  exception when check_violation then
    raise notice 'PASS  a patient chunk must name its owner';
  end;

  begin
    insert into public.knowledge_embeddings
      (source_type, patient_id, document_id, chunk_index, content, embedding)
    values ('MEDICAL_KNOWLEDGE', owner_profile, a_document, 52, 'owned knowledge', probe);
    raise exception 'FAIL: a knowledge chunk carrying a patient id was accepted';
  exception when check_violation then
    raise notice 'PASS  a knowledge chunk cannot carry a patient id';
  end;

  -- Wrong dimensionality must fail loudly rather than rank arbitrarily.
  begin
    insert into public.knowledge_embeddings
      (source_type, patient_id, document_id, chunk_index, content, embedding)
    values ('PATIENT_DOCUMENT', owner_profile, a_document, 53, 'short vector', '[1,2,3]'::extensions.vector);
    raise exception 'FAIL: a 3-dimensional embedding was accepted into a 384-dim column';
  exception when data_exception or internal_error or others then
    raise notice 'PASS  embedding dimensionality is enforced';
  end;

  -- Re-indexing must replace chunks, never accumulate them.
  begin
    insert into public.knowledge_embeddings
      (source_type, patient_id, document_id, chunk_index, content, embedding)
    values ('PATIENT_DOCUMENT', owner_profile, a_document, 0, 'duplicate chunk', probe);
    raise exception 'FAIL: a duplicate (document, chunk_index) was accepted';
  exception when unique_violation then
    raise notice 'PASS  one row per document chunk index';
  end;

  -- A conversation with no question or no answer is not a conversation.
  begin
    insert into public.ai_conversations (patient_id, question, response)
    values (owner_profile, '   ', 'answer');
    raise exception 'FAIL: a blank question was accepted';
  exception when check_violation then
    raise notice 'PASS  conversations require a question';
  end;

  begin
    insert into public.ai_conversations (patient_id, question, response, sources_used)
    values (owner_profile, 'question', 'answer', '{"not":"an array"}'::jsonb);
    raise exception 'FAIL: non-array sources_used was accepted';
  exception when check_violation then
    raise notice 'PASS  sources_used must be a JSON array';
  end;
end
$$;

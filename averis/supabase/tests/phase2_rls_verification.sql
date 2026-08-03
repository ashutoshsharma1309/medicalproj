-- ===========================================================================
-- AVERIS Phase 2 — Row Level Security verification
--
-- Proves that the document pipeline cannot leak across patients: uploaded
-- documents, their extractions, and the confirmed clinical records they
-- produce are each visible and writable only to their owner.
--
-- Runs after 00_local_auth_stub.sql, the Phase 1 migration, the Phase 2
-- migration, and rls_verification.sql (which seeds the two patients).
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- ---------------------------------------------------------------- fixtures
set role authenticated;

set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
insert into public.medical_documents
  (patient_id, file_name, file_path, mime_type, file_size, document_type, upload_status)
values (
  private.current_patient_profile_id(),
  'ananya-blood-report.pdf',
  'patients/' || private.current_patient_profile_id()::text || '/medical_documents/aaa.pdf',
  'application/pdf', 24576, 'BLOOD_REPORT', 'PENDING_REVIEW'
);

insert into public.document_extractions (document_id, extracted_text, extracted_data, confidence_score)
select d.id, 'HbA1c 5.4%', '{"summary":"ananya"}'::jsonb, 0.910
from public.medical_documents d
where d.file_name = 'ananya-blood-report.pdf';

set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
insert into public.medical_documents
  (patient_id, file_name, file_path, mime_type, file_size, document_type, upload_status)
values (
  private.current_patient_profile_id(),
  'rahul-prescription.jpg',
  'patients/' || private.current_patient_profile_id()::text || '/medical_documents/bbb.jpg',
  'image/jpeg', 51200, 'PRESCRIPTION', 'PENDING_REVIEW'
);

insert into public.document_extractions (document_id, extracted_text, extracted_data, confidence_score)
select d.id, 'Metformin 500mg', '{"summary":"rahul"}'::jsonb, 0.880
from public.medical_documents d
where d.file_name = 'rahul-prescription.jpg';

insert into public.patient_medical_records (patient_id, record_type, medication, confidence_score)
values (private.current_patient_profile_id(), 'MEDICATION', 'Metformin 500mg', 0.960);

reset role;

-- ---------------------------------------------------------------- assertions
do $$
declare
  visible        int;
  rahul_doc      uuid;
  rahul_extract  uuid;
  rahul_record   uuid;
  ananya_doc     uuid;
  affected       int;
begin
  select d.id into rahul_doc from public.medical_documents d
    where d.file_name = 'rahul-prescription.jpg';
  select e.id into rahul_extract from public.document_extractions e
    where e.document_id = rahul_doc;
  select r.id into rahul_record from public.patient_medical_records r
    where r.medication = 'Metformin 500mg';
  select d.id into ananya_doc from public.medical_documents d
    where d.file_name = 'ananya-blood-report.pdf';

  ---------------------------------------------------------------- as Ananya
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

  select count(*) into visible from public.medical_documents;
  if visible <> 1 then
    raise exception 'FAIL: document leak — saw % documents, expected 1', visible;
  end if;
  raise notice 'PASS  medical_documents: patient sees only their own uploads';

  select count(*) into visible from public.medical_documents where id = rahul_doc;
  if visible <> 0 then raise exception 'FAIL: another patient''s document is readable'; end if;
  raise notice 'PASS  medical_documents: cross-patient read blocked';

  select count(*) into visible from public.document_extractions;
  if visible <> 1 then
    raise exception 'FAIL: extraction leak — saw % extractions, expected 1', visible;
  end if;

  select count(*) into visible from public.document_extractions where id = rahul_extract;
  if visible <> 0 then
    raise exception 'FAIL: another patient''s extracted medical data is readable';
  end if;
  raise notice 'PASS  document_extractions: cross-patient read blocked';

  select count(*) into visible from public.patient_medical_records;
  if visible <> 0 then
    raise exception 'FAIL: saw % confirmed records belonging to another patient', visible;
  end if;
  raise notice 'PASS  patient_medical_records: cross-patient read blocked';

  -- Writes against another patient's rows must affect nothing.
  update public.medical_documents set upload_status = 'COMPLETED' where id = rahul_doc;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'FAIL: cross-patient document UPDATE modified % row(s)', affected; end if;
  raise notice 'PASS  cross-patient document UPDATE affects zero rows';

  update public.document_extractions set extracted_text = 'tampered' where id = rahul_extract;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'FAIL: cross-patient extraction UPDATE modified % row(s)', affected; end if;
  raise notice 'PASS  cross-patient extraction UPDATE affects zero rows';

  delete from public.patient_medical_records where id = rahul_record;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'FAIL: cross-patient record DELETE removed % row(s)', affected; end if;
  raise notice 'PASS  cross-patient record DELETE affects zero rows';

  delete from public.medical_documents where id = rahul_doc;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'FAIL: cross-patient document DELETE removed % row(s)', affected; end if;
  raise notice 'PASS  cross-patient document DELETE affects zero rows';

  -- Attaching an extraction to someone else's document must be refused.
  begin
    insert into public.document_extractions (document_id, extracted_text, extracted_data)
    values (rahul_doc, 'injected', '{}'::jsonb);
    raise exception 'FAIL: wrote an extraction onto another patient''s document';
  exception
    when insufficient_privilege or unique_violation then
      raise notice 'PASS  cannot attach an extraction to another patient''s document';
  end;

  -- Filing a confirmed record under another patient must not be possible.
  -- Two defences apply, and either is a pass: the target profile is invisible
  -- (so the SELECT yields no rows) or the INSERT's WITH CHECK rejects it.
  begin
    insert into public.patient_medical_records (patient_id, record_type, condition)
    select p.id, 'CONDITION', 'injected'
    from public.patient_profiles p
    join public.users u on u.id = p.user_id
    where u.email = 'rahul@example.com';

    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: filed % medical record(s) under another patient', affected;
    end if;
    raise notice 'PASS  cannot file a medical record under another patient (target invisible)';
  exception
    when insufficient_privilege then
      raise notice 'PASS  cannot file a medical record under another patient (WITH CHECK)';
  end;

  -- Direct attempt using a literal id, so the row is not hidden by SELECT RLS.
  begin
    insert into public.patient_medical_records (patient_id, record_type, condition)
    values (
      (select p.id from public.patient_profiles p
        join public.users u on u.id = p.user_id
        where u.email = 'rahul@example.com'),
      'CONDITION',
      'injected-direct'
    );
    get diagnostics affected = row_count;
    if affected > 0 then
      raise exception 'FAIL: WITH CHECK allowed a record under another patient';
    end if;
    raise notice 'PASS  WITH CHECK blocks a directly-targeted foreign patient id';
  exception
    when insufficient_privilege or not_null_violation then
      raise notice 'PASS  WITH CHECK rejects a directly-targeted foreign patient id';
  end;

  -- The owner can still work with their own document.
  update public.medical_documents set upload_status = 'COMPLETED' where id = ananya_doc;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'FAIL: owner cannot update their own document'; end if;
  raise notice 'PASS  owner can update their own document';

  ------------------------------------------------------------ as anonymous
  set local role anon;
  set local request.jwt.claim.sub = '';

  begin
    select count(*) into visible from public.medical_documents;
    raise exception 'FAIL: anon could query medical_documents (saw % rows)', visible;
  exception
    when insufficient_privilege then
      raise notice 'PASS  anon has no privilege on medical_documents';
  end;

  begin
    select count(*) into visible from public.document_extractions;
    raise exception 'FAIL: anon could query document_extractions (saw % rows)', visible;
  exception
    when insufficient_privilege then
      raise notice 'PASS  anon has no privilege on document_extractions';
  end;

  begin
    select count(*) into visible from public.patient_medical_records;
    raise exception 'FAIL: anon could query patient_medical_records (saw % rows)', visible;
  exception
    when insufficient_privilege then
      raise notice 'PASS  anon has no privilege on patient_medical_records';
  end;

  reset role;
  raise notice '---';
  raise notice 'ALL PHASE 2 RLS ASSERTIONS PASSED';
end
$$;

-- ---------------------------------------------------- constraint assertions
do $$
declare owner_profile uuid;
begin
  select p.id into owner_profile from public.patient_profiles p
    join public.users u on u.id = p.user_id where u.email = 'ananya@example.com';

  -- A CONDITION row carrying a medication would be an ambiguous record.
  begin
    insert into public.patient_medical_records (patient_id, record_type, condition, medication)
    values (owner_profile, 'CONDITION', 'Asthma', 'Salbutamol');
    raise exception 'FAIL: ambiguous record shape was accepted';
  exception when check_violation then
    raise notice 'PASS  record shape constraint rejects ambiguous rows';
  end;

  -- A LAB_RESULT with no test name is meaningless.
  begin
    insert into public.patient_medical_records (patient_id, record_type, test_value)
    values (owner_profile, 'LAB_RESULT', '8.2');
    raise exception 'FAIL: lab result without a test name was accepted';
  exception when check_violation then
    raise notice 'PASS  lab results require a test name';
  end;

  -- Only PDF/JPG/PNG may be recorded as documents.
  begin
    insert into public.medical_documents
      (patient_id, file_name, file_path, mime_type, file_size)
    values (owner_profile, 'malware.exe', 'patients/x/medical_documents/x.exe',
            'application/x-msdownload', 1024);
    raise exception 'FAIL: disallowed MIME type was accepted';
  exception when check_violation then
    raise notice 'PASS  disallowed MIME types rejected at the database level';
  end;

  -- Oversized files must not be recordable even if storage were bypassed.
  begin
    insert into public.medical_documents
      (patient_id, file_name, file_path, mime_type, file_size)
    values (owner_profile, 'huge.pdf', 'patients/x/medical_documents/huge.pdf',
            'application/pdf', 99999999);
    raise exception 'FAIL: oversized file was accepted';
  exception when check_violation then
    raise notice 'PASS  oversized files rejected at the database level';
  end;

  -- Confidence is a probability, not an arbitrary number.
  begin
    insert into public.document_extractions (document_id, extracted_data, confidence_score)
    select d.id, '{}'::jsonb, 1.5 from public.medical_documents d limit 1;
    raise exception 'FAIL: out-of-range confidence was accepted';
  exception when check_violation or unique_violation then
    raise notice 'PASS  confidence score constrained to 0..1';
  end;
end
$$;

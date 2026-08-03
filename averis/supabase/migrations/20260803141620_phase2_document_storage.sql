-- ===========================================================================
-- AVERIS Phase 2 — Supabase Storage for medical documents
--
-- Object layout:
--   patients/{patient_profile_id}/medical_documents/{uuid}.{ext}
--
-- The bucket is PRIVATE. Documents are never publicly addressable; the
-- application issues short-lived signed URLs on demand.
--
-- Storage policies mirror the table policies: a patient can only touch objects
-- under their own patient_profile folder, resolved through the same
-- non-exposed `private` helper used elsewhere. `anon` gets nothing.
--
-- NOTE: the local Postgres test harness has no `storage` schema, so this
-- migration is skipped there. It runs against any real Supabase project.
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'medical-documents',
  'medical-documents',
  false,
  15728640, -- 15 MB, matches the medical_documents CHECK constraint
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Does the given storage object path belong to the caller?
--
-- Path segment 1 is the literal 'patients', segment 2 is the patient profile
-- id. storage.foldername() returns the directory segments of the object name.
-- ---------------------------------------------------------------------------
create function private.owns_storage_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (storage.foldername(object_name))[1] = 'patients'
    and (storage.foldername(object_name))[2] = private.current_patient_profile_id()::text;
$$;

revoke all on function private.owns_storage_object(text) from public;
grant execute on function private.owns_storage_object(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Object policies
--
-- Upsert (replacing a file) requires INSERT + SELECT + UPDATE together, so all
-- three are granted for the owner's own folder. DELETE lets a patient remove a
-- document they uploaded by mistake.
-- ---------------------------------------------------------------------------
create policy "Patients read own medical documents"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'medical-documents'
    and private.owns_storage_object(name)
  );

create policy "Patients upload own medical documents"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'medical-documents'
    and private.owns_storage_object(name)
  );

create policy "Patients update own medical documents"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'medical-documents'
    and private.owns_storage_object(name)
  )
  with check (
    bucket_id = 'medical-documents'
    and private.owns_storage_object(name)
  );

create policy "Patients delete own medical documents"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'medical-documents'
    and private.owns_storage_object(name)
  );

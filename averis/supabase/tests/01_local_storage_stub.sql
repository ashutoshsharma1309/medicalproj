-- ===========================================================================
-- Local-only stub of the parts of Supabase Storage the AVERIS schema touches.
--
-- A real Supabase project provides all of this. The stub exists so the
-- storage migration can be dry-run against plain Postgres before it is applied
-- to a live project — catching syntax and reference errors locally rather than
-- half-way through a paste into the SQL editor.
-- ===========================================================================

create schema if not exists storage;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id        uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name      text,
  owner     uuid
);

alter table storage.objects enable row level security;

-- Supabase's helper: splits an object name into its directory segments.
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1 : array_length(parts, 1) - 1];
end;
$$;

grant usage on schema storage to authenticated, anon;

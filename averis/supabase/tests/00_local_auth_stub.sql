-- ===========================================================================
-- Local-only stub of the pieces of Supabase Auth that the AVERIS schema
-- depends on. A real Supabase project provides all of this.
--
-- Applied BEFORE the migration so `auth.users` and the `anon` /
-- `authenticated` roles exist, letting the production migration run
-- completely unmodified against a plain Postgres instance.
-- ===========================================================================

create schema if not exists auth;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb default '{}'::jsonb
);

-- Supabase derives auth.uid() from the request JWT. Locally it reads a GUC
-- that each test sets — the same technique Supabase's own test helpers use.
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

grant usage on schema auth to authenticated, anon;
grant select on auth.users to authenticated;

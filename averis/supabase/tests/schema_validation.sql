-- ===========================================================================
-- AVERIS — schema validation
--
-- Structural assertions about the schema itself, as opposed to the behavioural
-- assertions in the *_rls_verification.sql files. Those prove that a specific
-- patient cannot read a specific other patient's rows; this proves that no
-- table was added *without* anyone thinking about that question at all.
--
-- The difference matters. Every RLS file tests tables somebody remembered to
-- write a test for. This one fails on the table nobody remembered — which is
-- the only kind that ships a hole.
--
-- Run by scripts/setup_database.sh after migrations, and by
-- supabase/tests/run.sh before the behavioural suites.
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

do $$
declare
  offender    record;
  problems    int := 0;
  table_count int;
  policy_count int;
begin
  -- ── 1. Row Level Security is enabled on every table in `public` ─────────
  --
  -- A new table without RLS is readable by every signed-in user of the
  -- platform. It is the single highest-impact mistake available in this
  -- codebase, it produces no error, and nothing else in the suite would catch
  -- it — a behavioural test can only test a table someone wrote a test for.
  for offender in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not c.relrowsecurity
    order by c.relname
  loop
    raise warning 'FAIL: public.% has no row level security', offender.relname;
    problems := problems + 1;
  end loop;

  -- ── 2. Every table a client can reach has at least one policy ──────────
  --
  -- RLS with no policies denies everything. That is a bug when someone meant
  -- clients to read the table, and correct when they did not — and the two are
  -- distinguishable: **a grant to a client role is the statement of intent.**
  --
  -- `retention_policies` is operational configuration only the worker touches.
  -- It has RLS on and no policies because no client should ever read it, and
  -- adding a policy that denies everything would be noise pretending to be
  -- rigour. `sensor_readings` with a SELECT grant and no policy would be the
  -- real bug this check exists for: somebody meant patients to read it and the
  -- policy never landed.
  --
  -- So the check is scoped to tables `authenticated` or `anon` actually holds a
  -- privilege on. The first version flagged all three operational tables and
  -- would have been silenced by three meaningless policies — which is how a
  -- validator stops catching the thing it was written for.
  for offender in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relrowsecurity
      and exists (
        select 1 from information_schema.role_table_grants g
        where g.table_schema = 'public'
          and g.table_name = c.relname
          and g.grantee in ('authenticated', 'anon')
      )
      and not exists (select 1 from pg_policies p
                      where p.schemaname = 'public' and p.tablename = c.relname)
    order by c.relname
  loop
    raise warning 'FAIL: public.% is granted to a client role but has no policies',
      offender.relname;
    problems := problems + 1;
  end loop;

  -- ── 2b. A table with no policies must also have no client grants ───────
  --
  -- The mirror of the check above, and the reason narrowing it is safe: if a
  -- table is deliberately service-role only, a client grant appearing on it
  -- later is the mistake — and it would otherwise be silently permitted by the
  -- narrowed rule above.
  for offender in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not exists (select 1 from pg_policies p
                      where p.schemaname = 'public' and p.tablename = c.relname)
      and exists (
        select 1 from information_schema.role_table_grants g
        where g.table_schema = 'public'
          and g.table_name = c.relname
          and g.grantee = 'anon'
      )
    order by c.relname
  loop
    raise warning 'FAIL: public.% has no policies but is granted to anon', offender.relname;
    problems := problems + 1;
  end loop;

  -- ── 3. No policy grants to PUBLIC ──────────────────────────────────────
  --
  -- A policy with no `TO` clause applies to every role including `anon`. The
  -- convention in this schema is `TO authenticated` with an ownership
  -- predicate; a policy that omits it is authentication-free access wearing
  -- the shape of a policy.
  for offender in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and (roles is null or roles = '{public}')
    order by tablename, policyname
  loop
    raise warning 'FAIL: policy "%" on public.% applies to PUBLIC',
      offender.policyname, offender.tablename;
    problems := problems + 1;
  end loop;

  -- ── 4. `anon` holds no table privileges ────────────────────────────────
  --
  -- RLS is the second line. The first is that the unauthenticated role has no
  -- grant to exercise it against — `scripts/verify-remote.sh` checks the same
  -- property from outside, over HTTP, against a real project.
  for offender in
    select distinct table_name
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee = 'anon'
    order by table_name
  loop
    raise warning 'FAIL: anon has privileges on public.%', offender.table_name;
    problems := problems + 1;
  end loop;

  -- ── 5. The private schema is not reachable by clients ──────────────────
  --
  -- Its functions are SECURITY DEFINER and bypass RLS by design. `anon` having
  -- USAGE would make them callable API endpoints.
  if has_schema_privilege('anon', 'private', 'USAGE') then
    raise warning 'FAIL: anon has USAGE on schema private';
    problems := problems + 1;
  end if;

  -- ── 6. No token or secret column is readable by clients ────────────────
  --
  -- `iot_devices.token_hash` is the case this was written for. A SELECT grant
  -- on it would let any signed-in patient read the hash of their own device
  -- token — not immediately exploitable, and precisely the kind of thing that
  -- becomes exploitable later.
  -- Restricted to string-typed columns. `iot_devices.token_issued_at` matches
  -- the name pattern and is a timestamptz: it records *when* a token was
  -- issued and cannot hold one. Flagging it would be a false positive that
  -- teaches whoever runs this to skim past the output — which is how the real
  -- finding gets missed.
  for offender in
    select c.table_name, c.column_name
    from information_schema.column_privileges c
    join information_schema.columns col
      on col.table_schema = c.table_schema
     and col.table_name = c.table_name
     and col.column_name = c.column_name
    where c.table_schema = 'public'
      and c.grantee in ('anon', 'authenticated')
      and c.privilege_type = 'SELECT'
      and col.data_type in ('text', 'character varying', 'character', 'bytea')
      and (c.column_name like '%token%' or c.column_name like '%secret%'
           or c.column_name like '%password%')
    order by c.table_name, c.column_name
  loop
    raise warning 'FAIL: % can be selected on public.%', offender.column_name, offender.table_name;
    problems := problems + 1;
  end loop;

  -- ── Inventory, so a partial migration run is visible ────────────────────
  select count(*) into table_count
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r';

  select count(*) into policy_count from pg_policies where schemaname = 'public';

  raise notice '---';
  raise notice 'Schema: % tables, % policies', table_count, policy_count;

  -- A schema this size with a handful of policies means migrations stopped
  -- part way through, which otherwise presents as a confusing RLS failure
  -- twenty assertions later.
  if table_count < 25 then
    raise exception 'FAIL: only % tables — migrations did not all apply', table_count;
  end if;

  if problems > 0 then
    raise exception '% schema validation problem(s). See the warnings above.', problems;
  end if;

  raise notice 'PASS  every public table has RLS, policies, and no anon grants';
  raise notice 'ALL SCHEMA VALIDATION CHECKS PASSED';
end
$$;

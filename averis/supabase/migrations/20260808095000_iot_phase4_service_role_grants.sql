-- ===========================================================================
-- AVERIS IoT — Phase 4d: the ingest service could not call the functions it
-- calls
--
-- The core schema revokes everything on `private` from PUBLIC and grants usage
-- to `authenticated` only:
--
--   revoke all on schema private from public;
--   grant usage on schema private to authenticated;
--
-- That is the right default. But the ingest service does not connect as
-- `authenticated` — it holds a service-role key, and PostgREST executes its
-- requests as `service_role`. So every `private` RPC the service makes has
-- been reaching a schema it has no USAGE on, which fails with "permission
-- denied for schema private" before the function's own EXECUTE grant is even
-- considered.
--
-- This affects `resolve_device`, added in Phase 1 and never granted to
-- anything, as much as the two functions added in Phase 4b. Fixing only the
-- new ones would leave the *first* call every device makes broken and the ones
-- after it working, which is a worse state to debug than either.
--
-- Why this was invisible: nothing in the test suite runs as `service_role`,
-- because the local auth stub did not create that role until this phase. The
-- suite has been thorough about what `authenticated` may reach and silent
-- about the only other role that touches the database.
--
-- ── The grant is deliberately narrow ───────────────────────────────────────
--
-- USAGE on the schema plus EXECUTE on three named functions. Not `grant
-- execute on all functions in schema private`, and no default privileges: a
-- future helper in `private` should have to say out loud that the ingest
-- service may call it, because `private` is where the functions that bypass
-- RLS live.
-- ===========================================================================

grant usage on schema private to service_role;

-- The device credential lookup. Every ingest request starts here.
grant execute on function private.resolve_device(text) to service_role;

-- Already granted EXECUTE in Phase 4b; the schema USAGE above is what makes
-- those grants reachable. Repeated for the reader rather than because Postgres
-- needs it — a grant list that omits the functions it is about sends the next
-- person to the wrong file.
grant execute on function private.care_team_recipients(uuid) to service_role;
grant execute on function private.raise_emergency(
  uuid, uuid, public.emergency_type, public.alert_severity,
  public.detected_by, text, text, jsonb
) to service_role;

-- The service writes readings, alerts, predictions and insights directly over
-- PostgREST. On a real Supabase project service_role already holds these
-- through default privileges on `public`; stated here so the schema is
-- self-contained and a plain-Postgres deployment behaves the same way.
grant usage on schema public to service_role;
grant select, insert, update on public.sensor_readings   to service_role;
grant select, insert, update on public.alerts            to service_role;
grant select, insert, update on public.iot_devices       to service_role;
grant select, insert         on public.health_predictions to service_role;
grant select, insert         on public.ai_insights       to service_role;
grant select                 on public.patient_profiles  to service_role;
grant select                 on public.users             to service_role;
grant select, insert, update on public.emergency_events  to service_role;
grant select, insert         on public.care_notifications to service_role;

-- Sequences behind the two tables the service inserts into with bigserial keys.
grant usage, select on all sequences in schema public to service_role;

-- ===========================================================================
-- AVERIS IoT — Phase 4c: a caregiver could not read the name of the person
-- they are caring for
--
-- The policy added in the care-team migration was written inline:
--
--   using (
--     exists (
--       select 1 from public.patient_profiles p
--       where p.user_id = users.id and private.can_see_patient_alerts(p.id)
--     )
--   )
--
-- It is the only policy in that file that reaches into another table directly
-- instead of asking one of the `private` helpers, and that exception is the
-- bug. **A subquery inside a policy is itself subject to the referenced
-- table's row security for the querying user.** So the `exists` above can only
-- find a `patient_profiles` row the caller may already read — and a caregiver
-- holding VIEW_ALERTS deliberately may not read patient_profiles at all.
--
-- The result: the narrowest, most common caregiver grant produced an inbox and
-- a watchlist full of UUIDs. Every access decision was correct; the feature was
-- useless. That is the shape of failure to expect from an inline predicate —
-- not a leak, a silent hole in exactly the case the helpers were written to
-- cover, which is why the other twenty policies all call one.
--
-- Fixed the same way everything else in this schema is: one SECURITY DEFINER
-- helper, which evaluates its own lookup without inheriting the caller's
-- restrictions on the tables it consults.
-- ===========================================================================

/**
 * Is this user the subject of care the caller is part of?
 *
 * SECURITY DEFINER so the patient_profiles lookup inside it runs to
 * completion. It takes a user id and returns a boolean — there is no way to
 * pass it something that widens access, because the *answer* still comes from
 * private.can_see_patient_alerts(), which reads only the caller's own identity
 * from auth.uid().
 */
create or replace function private.is_care_subject(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.patient_profiles p
    where p.user_id = p_user_id
      and private.can_see_patient_alerts(p.id)
  );
$$;

revoke all on function private.is_care_subject(uuid) from public;
grant execute on function private.is_care_subject(uuid) to authenticated;

drop policy if exists "Care team reads assigned patient identity" on public.users;

create policy "Care team reads assigned patient identity"
  on public.users for select
  to authenticated
  using ( private.is_care_subject(users.id) );

-- ---------------------------------------------------------------------------
-- care_patient_directory
--
-- The policy above makes the *user* row readable. Getting from a patient id to
-- that user row still means reading `patient_profiles.user_id`, and the
-- narrowest caregiver grant may not read patient_profiles — so a caregiver
-- holding VIEW_ALERTS could see a name they had no way to look up.
--
-- This closes the join. It takes no arguments on purpose: there is no
-- parameter to substitute, and the rows it returns are decided entirely by
-- private.can_see_patient_alerts() against the caller's own identity. It
-- returns a name and nothing else — not the profile, not the email, not the
-- date of birth — because the only thing missing was the label on a list.
-- ---------------------------------------------------------------------------
create or replace function public.care_patient_directory()
returns table (patient_id uuid, full_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, u.full_name
  from public.patient_profiles p
  join public.users u on u.id = p.user_id
  where private.can_see_patient_alerts(p.id);
$$;

comment on function public.care_patient_directory() is
  'Patient ids and names the caller is a care team member for. Takes no arguments, so there is nothing to substitute.';

revoke all on function public.care_patient_directory() from public;
grant execute on function public.care_patient_directory() to authenticated;

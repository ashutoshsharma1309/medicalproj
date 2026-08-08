-- ===========================================================================
-- AVERIS — a patient could not see who is on their own care team
--
-- Found by executing the Phase 4b revocation assertions against a real
-- database. The test tried to revoke a caregiver with:
--
--   update public.patient_caregiver_assignments set status = 'REVOKED'
--    where caregiver_id = (select id from public.users where email = ...)
--
-- and revoked nothing — because the subquery returned no rows. A patient can
-- read their own `users` row and the rows of patients they are a care team
-- member *for*; there was no policy letting them read the row of somebody they
-- had granted access *to*.
--
-- ── Why this matters more than a missing name ──────────────────────────────
--
-- `/care-team` lists caregivers so a patient can withdraw access. Without the
-- identity, every row renders as "Caregiver" with no name and no email — and a
-- patient looking at two identical unnamed rows cannot revoke the right one.
-- Consent that cannot be exercised specifically is not much better than
-- consent that cannot be exercised at all, and this is the page the entire
-- Phase 4 access model rests on.
--
-- It is the mirror of the Phase 4c defect: that one stopped a caregiver seeing
-- the patient, this one stopped the patient seeing the caregiver. Both came
-- from the same assumption — that the identity policy written for one
-- direction covered both.
--
-- ── The same shape as the fix that came before it ──────────────────────────
--
-- A SECURITY DEFINER function taking no arguments, returning only what the
-- page needs. Not a policy on `users`: a policy wide enough to cover this
-- would make every clinician's and caregiver's row readable by any patient who
-- had ever assigned them, and the directory is a narrower grant that returns
-- three columns to exactly the person who granted the access.
-- ===========================================================================

create or replace function public.my_care_team_directory()
returns table (
  user_id   uuid,
  full_name text,
  email     text,
  care_role text
)
language sql
stable
security definer
set search_path = ''
as $$
  -- Doctors this patient has assigned, in any state. Revoked entries stay
  -- visible on /care-team so "who could see my data in March" is answerable,
  -- and a row with no name would leave that question half-answered.
  select u.id, u.full_name, u.email, 'DOCTOR'
  from public.patient_doctor_assignments a
  join public.doctors d on d.id = a.doctor_id
  join public.users u on u.id = d.user_id
  where a.patient_id = private.current_patient_profile_id()

  union

  select u.id, u.full_name, u.email, 'CAREGIVER'
  from public.patient_caregiver_assignments c
  join public.users u on u.id = c.caregiver_id
  where c.patient_id = private.current_patient_profile_id();
$$;

comment on function public.my_care_team_directory() is
  'Who the calling patient has granted access to. Takes no arguments; scoped entirely by the caller''s own profile.';

revoke all on function public.my_care_team_directory() from public;
grant execute on function public.my_care_team_directory() to authenticated;

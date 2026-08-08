"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  findDoctorAction,
  assignDoctorAction,
  EMPTY_LOOKUP,
  type DoctorLookupState,
} from "./actions";

/**
 * Adding a clinician, in two steps.
 *
 * Look up, then grant. The separation is the whole point: a patient who types
 * a licence number and is told "access granted" has consented to a string, not
 * to a person. Seeing the name and the hospital before the second click is
 * what makes it consent.
 *
 * The lookup is exact-match by design — there is no directory to browse here,
 * because a searchable one would let any account enumerate every clinician on
 * the platform.
 */
export function AddDoctor() {
  const [lookup, findAction] = useActionState(findDoctorAction, EMPTY_LOOKUP);
  const [grant, grantAction] = useActionState(assignDoctorAction, EMPTY_LOOKUP);

  // The grant's result outranks the lookup's: after a successful grant the
  // found card is stale, and leaving it on screen invites a second click.
  const state: DoctorLookupState = grant.message || grant.error ? grant : lookup;

  return (
    <div className="px-6 py-5">
      <form action={findAction} className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor="license" className="sr-only">
          Clinician licence number
        </label>
        <input
          id="license"
          name="license"
          type="text"
          required
          minLength={3}
          maxLength={60}
          autoComplete="off"
          placeholder="Their licence number — for example MED-99117"
          className="field-input flex-1"
        />
        <SubmitButton idle="Find clinician" busy="Looking…" />
      </form>

      {state.error && (
        <p className="field-error mt-2" role="alert">
          {state.error}
        </p>
      )}

      {state.message && (
        <p className="mt-2 text-[13.5px] text-[var(--color-positive)]" role="status">
          {state.message}
        </p>
      )}

      {state.found && (
        <form action={grantAction} className="mt-4 rounded-lg border border-rule p-4">
          <input type="hidden" name="doctorId" value={state.found.id} />
          <p className="text-[15px] font-medium">{state.found.fullName}</p>
          <p className="mono mt-1 text-[12.5px] text-muted">
            {[state.found.specialization, state.found.hospitalName].filter(Boolean).join(" · ") ||
              "No speciality recorded"}
          </p>
          {!state.found.verified && (
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
              AVERIS has not verified this licence. Grant access only if you know this clinician.
            </p>
          )}
          <p className="mt-3 text-[13.5px] leading-relaxed text-ink-soft">
            They will be able to see your monitoring data, alerts and AI risk assessments, and to
            respond to your emergency events. You can withdraw this at any time.
          </p>
          <div className="mt-3">
            <SubmitButton idle="Grant access" busy="Granting…" />
          </div>
        </form>
      )}
    </div>
  );
}

function SubmitButton({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary sm:w-44" disabled={pending}>
      {pending ? busy : idle}
    </button>
  );
}

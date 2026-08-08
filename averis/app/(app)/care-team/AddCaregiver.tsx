"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { inviteCaregiverAction, type CaregiverInviteState } from "./actions";

/**
 * Adding someone who is not a clinician.
 *
 * The permission choice is presented as three sentences rather than three enum
 * names, because this is the moment a patient decides how much of their life a
 * family member sees. "VIEW_ALERTS" tells them nothing; "only when something
 * needs attention" tells them what they are agreeing to.
 *
 * Alerts-only is the default and is listed first — the narrowest grant that
 * still does the job the caregiver is there for.
 */

const LEVELS = [
  {
    value: "VIEW_ALERTS",
    label: "Emergency alerts only",
    detail: "They are notified when something needs attention. They cannot see your measurements.",
  },
  {
    value: "VIEW_VITALS",
    label: "Alerts and current vitals",
    detail: "They also see your heart rate, blood oxygen and temperature.",
  },
  {
    value: "FULL",
    label: "Full monitoring access",
    detail: "They see everything a clinician does, except your documents and your questions to AVERIS.",
  },
] as const;

const INITIAL: CaregiverInviteState = { message: null, error: null };

export function AddCaregiver() {
  const [state, formAction] = useActionState(inviteCaregiverAction, INITIAL);

  return (
    <form action={formAction} className="px-6 py-5">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <label htmlFor="caregiver-email" className="sr-only">
            Their email address
          </label>
          <input
            id="caregiver-email"
            name="email"
            type="email"
            required
            maxLength={200}
            autoComplete="off"
            placeholder="The email address they signed up with"
            className="field-input w-full"
          />
        </div>
        <div className="sm:w-48">
          <label htmlFor="relationship" className="sr-only">
            Relationship
          </label>
          <input
            id="relationship"
            name="relationship"
            type="text"
            maxLength={60}
            autoComplete="off"
            placeholder="Daughter, son…"
            className="field-input w-full"
          />
        </div>
      </div>

      <fieldset className="mt-4">
        <legend className="eyebrow mb-2">What they can see</legend>
        <div className="space-y-2">
          {LEVELS.map((level, index) => (
            <label key={level.value} className="flex gap-3 rounded-lg border border-rule p-3">
              <input
                type="radio"
                name="permission"
                value={level.value}
                defaultChecked={index === 0}
                className="mt-1"
              />
              <span>
                <span className="block text-[14px] font-medium">{level.label}</span>
                <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">
                  {level.detail}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {state.error && (
        <p className="field-error mt-3" role="alert">
          {state.error}
        </p>
      )}
      {state.message && (
        <p className="mt-3 text-[13.5px] text-[var(--color-positive)]" role="status">
          {state.message}
        </p>
      )}

      <div className="mt-4">
        <SubmitButton />
      </div>
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary sm:w-44" disabled={pending}>
      {pending ? "Adding…" : "Add caregiver"}
    </button>
  );
}

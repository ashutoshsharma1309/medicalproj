"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { registerDeviceAction, type RegisterState } from "./actions";
import { TokenReveal } from "./TokenReveal";

/**
 * Device registration.
 *
 * The token appears once, here, and the copy explains why plainly rather than
 * burying it — a patient who does not understand that it cannot be recovered
 * will close the panel and then be unable to connect their device.
 */

const INITIAL: RegisterState = { token: null, deviceKey: null, error: null };

const DEVICE_TYPES = [
  { value: "WEARABLE_BAND", label: "Wearable band" },
  { value: "PULSE_OXIMETER", label: "Pulse oximeter" },
  { value: "SMART_WATCH", label: "Smart watch" },
  { value: "CHEST_STRAP", label: "Chest strap" },
  { value: "OTHER", label: "Other" },
];

export function RegisterDevice() {
  const [state, formAction] = useActionState(registerDeviceAction, INITIAL);

  if (state.token && state.deviceKey) {
    return <TokenReveal token={state.token} deviceKey={state.deviceKey} />;
  }

  return (
    <form action={formAction} className="px-6 py-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label htmlFor="deviceName" className="field-label">
            Device name
          </label>
          <input
            id="deviceName"
            name="deviceName"
            type="text"
            required
            maxLength={120}
            placeholder="AVERIS Wearable"
            className="field-input"
          />
          <p className="field-hint">What you will recognise it by.</p>
        </div>

        <div>
          <label htmlFor="deviceType" className="field-label">
            Type
          </label>
          <select id="deviceType" name="deviceType" className="field-input" defaultValue="WEARABLE_BAND">
            {DEVICE_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="deviceKey" className="field-label">
            Device key <span className="text-muted">(optional)</span>
          </label>
          <input
            id="deviceKey"
            name="deviceKey"
            type="text"
            maxLength={64}
            placeholder="AVR001"
            className="field-input mono"
          />
          <p className="field-hint">
            The identifier burned into the firmware. Left blank, AVERIS picks the next free one.
          </p>
        </div>

        <div className="sm:col-span-2">
          <label className="flex items-start gap-2.5">
            <input type="checkbox" name="isSimulated" className="mt-1" />
            <span>
              <span className="block text-[14px]">This is a simulator, not a real device</span>
              <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">
                Every reading it sends is permanently marked as generated. Tick this for the
                sensor simulator — data that cannot later be told apart from measurements is
                worse than no data.
              </span>
            </span>
          </label>
        </div>

        <div className="flex items-end">
          <SubmitButton />
        </div>
      </div>

      {state.error && (
        <p className="field-error mt-3" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary w-full" disabled={pending}>
      {pending ? "Registering…" : "Register device"}
    </button>
  );
}

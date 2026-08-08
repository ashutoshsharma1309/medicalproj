"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { submitCalibration, type CalibrationFormState } from "./actions";
import { Button, Callout, Field, Input, Select, TextArea } from "@/components/ui";
import {
  CHANNEL_LABELS,
  CHANNEL_PROTOCOL,
  REFERENCE_SUGGESTIONS,
  type CalibrationChannel,
} from "@/lib/calibration/channels";

/**
 * Entering a calibration sitting.
 *
 * The form shows the protocol for the selected channel beside the inputs rather
 * than linking to it. The person filling this in is holding two devices and a
 * finger; they are not going to open a document, and the guidance is exactly
 * the kind that makes the whole comparison meaningless when skipped — both
 * readings at the same moment, same hand, still for two minutes.
 *
 * It starts with more rows than a short sitting needs and grows on demand.
 * Twenty pairs is the point where the statistics become reportable, so the form
 * is built for twenty rather than making somebody click twenty times to get
 * there.
 */

const INITIAL: CalibrationFormState = {};
const STARTING_ROWS = 20;

export function CalibrationForm({ deviceKey }: { deviceKey: string }) {
  const [state, action] = useActionState(submitCalibration, INITIAL);
  const [channel, setChannel] = useState<CalibrationChannel>("spo2");
  const [rows, setRows] = useState(STARTING_ROWS);

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="deviceKey" value={deviceKey} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Channel" htmlFor="cal-channel" required>
          <Select
            id="cal-channel"
            name="channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value as CalibrationChannel)}
          >
            {(Object.keys(CHANNEL_LABELS) as CalibrationChannel[]).map((key) => (
              <option key={key} value={key}>
                {CHANNEL_LABELS[key]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Reference instrument"
          htmlFor="cal-reference"
          required
          hint="Make and model. Without it the comparison cannot be interpreted later."
        >
          <Input
            id="cal-reference"
            name="referenceInstrument"
            required
            minLength={3}
            placeholder={REFERENCE_SUGGESTIONS[channel][0]}
            list="reference-suggestions"
          />
          <datalist id="reference-suggestions">
            {REFERENCE_SUGGESTIONS[channel].map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        </Field>

        <Field
          label="Reference's own accuracy"
          htmlFor="cal-reference-accuracy"
          hint="From its manual, e.g. ±2%. The reference has error too, and this comparison cannot be tighter than it."
        >
          <Input id="cal-reference-accuracy" name="referenceAccuracy" placeholder="Manufacturer states ±2% over 70–100%" />
        </Field>

        <Field
          label="Conditions"
          htmlFor="cal-conditions"
          hint="Room temperature, posture, movement, which finger."
        >
          <Input id="cal-conditions" name="conditions" placeholder="Seated, 24 °C, still, left index finger" />
        </Field>
      </div>

      {/* The protocol, beside the inputs rather than behind a link. */}
      <Callout tone="brand" title={`Before you start — ${CHANNEL_LABELS[channel].toLowerCase()}`}>
        <ul className="mt-1 space-y-1.5">
          {CHANNEL_PROTOCOL[channel].map((line) => (
            <li key={line} className="text-[14px] leading-relaxed">
              {line}
            </li>
          ))}
        </ul>
      </Callout>

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-[15px] font-semibold">Paired readings</h3>
          <p className="text-[13px] text-ink-soft">
            Both taken at the same moment. Blank rows are ignored.
          </p>
        </div>

        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[520px] text-[14px]">
            <thead className="bg-surface-sunk text-left text-[13px] text-ink-soft">
              <tr>
                <th className="w-12 px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">AVERIS band</th>
                <th className="px-3 py-2 font-medium">Reference</th>
                <th className="px-3 py-2 font-medium">Note (optional)</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="px-3 py-1.5 text-ink-soft">{i + 1}</td>
                  <td className="px-2 py-1.5">
                    <Input name="device_value" type="number" step="0.1" inputMode="decimal" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input name="reference_value" type="number" step="0.1" inputMode="decimal" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input name="pair_conditions" placeholder="finger shifted" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <button
          type="button"
          onClick={() => setRows((n) => n + 10)}
          className="mt-2 text-[14px] font-semibold text-brand underline underline-offset-2"
        >
          Add ten more rows
        </button>
      </div>

      <Field
        label="Notes"
        htmlFor="cal-notes"
        hint="Anything that would change how somebody reads this later."
      >
        <TextArea id="cal-notes" name="notes" rows={2} />
      </Field>

      {state.error && (
        <Callout tone="critical" title="Not recorded">
          {state.error}
        </Callout>
      )}

      {state.message && (
        <Callout tone="brand" title="Session recorded">
          {state.message}
        </Callout>
      )}

      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Recording…" : "Record this session"}
    </Button>
  );
}

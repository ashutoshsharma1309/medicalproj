"use client";

import { useParams } from "next/navigation";
import { acknowledgeEmergency, resolveEmergency, startResponse } from "./actions";

/**
 * Emergency response controls.
 *
 * Only the transitions valid from the current state are offered. Showing
 * "Resolve" on an unacknowledged event invites closing something nobody has
 * looked at, which is the failure this workflow exists to prevent.
 */
export function EmergencyActions({ eventId, status }: { eventId: string; status: string }) {
  const params = useParams<{ patientId: string }>();
  const patientId = params?.patientId ?? "";

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {status === "NEW" && (
        <form action={acknowledgeEmergency}>
          <input type="hidden" name="eventId" value={eventId} />
          <input type="hidden" name="patientId" value={patientId} />
          <button type="submit" className="btn btn-primary text-[13px]">
            Acknowledge
          </button>
        </form>
      )}

      {status === "ACKNOWLEDGED" && (
        <form action={startResponse}>
          <input type="hidden" name="eventId" value={eventId} />
          <input type="hidden" name="patientId" value={patientId} />
          <button type="submit" className="btn btn-secondary text-[13px]">
            Mark under review
          </button>
        </form>
      )}

      {(status === "ACKNOWLEDGED" || status === "IN_PROGRESS") && (
        <form action={resolveEmergency} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="eventId" value={eventId} />
          <input type="hidden" name="patientId" value={patientId} />
          <input
            type="text"
            name="note"
            maxLength={500}
            placeholder="Resolution note"
            className="field-input h-9 w-56 text-[13px]"
          />
          <button type="submit" className="btn btn-ghost text-[13px]">
            Resolve
          </button>
        </form>
      )}
    </div>
  );
}

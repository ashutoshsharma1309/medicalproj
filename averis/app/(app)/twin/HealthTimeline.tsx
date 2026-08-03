import Link from "next/link";
import { formatDate } from "@/lib/utils/format";
import type { HealthEventType, TimelineEvent } from "@/lib/services/twin/types";

/**
 * Vertical medical timeline.
 *
 * Grouped by year with a continuous spine, so a patient reads their history as
 * one journey rather than a list of rows. Event type is carried by a small
 * marker and a label — never by colour alone.
 */

const EVENT_PRESENTATION: Record<HealthEventType, { label: string; colour: string }> = {
  DIAGNOSIS: { label: "Diagnosis", colour: "var(--color-brand)" },
  MEDICATION_STARTED: { label: "Medication", colour: "var(--color-brand-mid)" },
  MEDICATION_CHANGED: { label: "Medication change", colour: "var(--color-brand-mid)" },
  MEDICATION_STOPPED: { label: "Medication stopped", colour: "var(--color-muted)" },
  LAB_RESULT: { label: "Test result", colour: "var(--color-notice)" },
  DOCUMENT_ADDED: { label: "Document", colour: "var(--color-faint)" },
  ALLERGY_RECORDED: { label: "Allergy", colour: "var(--color-critical)" },
  OTHER: { label: "Event", colour: "var(--color-muted)" },
};

export function HealthTimeline({
  groups,
}: {
  groups: { year: string; events: TimelineEvent[] }[];
}) {
  if (groups.length === 0) {
    return (
      <div className="px-6 py-10 text-center">
        <p className="text-[15px] font-medium">Your timeline is empty</p>
        <p className="mx-auto mt-1.5 max-w-md text-[14px] leading-relaxed text-ink-soft">
          Once you confirm information from a document, the events appear here in order — with
          the earliest record at the bottom.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8 px-6 py-6">
      {groups.map((group) => (
        <section key={group.year} className="grid grid-cols-[56px_1fr] gap-5">
          <div className="mono pt-0.5 text-right text-[15px] font-semibold text-brand">
            {group.year}
          </div>

          {/* The spine runs the height of the year's events. */}
          <ol className="relative space-y-5 border-l border-rule-strong pl-6">
            {group.events.map((event, index) => {
              const presentation = EVENT_PRESENTATION[event.eventType];
              return (
                <li key={`${event.eventDate}-${index}`} className="relative">
                  <span
                    className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--color-surface)]"
                    style={{ background: presentation.colour }}
                    aria-hidden="true"
                  />

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="mono text-[12px] text-muted">
                      {formatDate(event.eventDate)}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                      {presentation.label}
                    </span>
                  </div>

                  <p className="mt-0.5 text-[14.5px] font-medium">{event.eventTitle}</p>

                  {event.description && (
                    <p className="mt-0.5 max-w-2xl text-[13.5px] leading-relaxed text-ink-soft">
                      {event.description}
                    </p>
                  )}

                  {event.sourceDocumentId && (
                    <Link
                      href={`/records/${event.sourceDocumentId}`}
                      className="mt-1 inline-block text-[12.5px] font-medium text-brand hover:underline"
                    >
                      View source document →
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

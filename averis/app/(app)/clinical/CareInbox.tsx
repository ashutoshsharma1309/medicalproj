"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Chip } from "@/components/ui";
import { dismissNotice, dismissAllNotices } from "./actions";
import type { CareNotice } from "@/lib/care/care-inbox-service";

/**
 * The care team's alert inbox.
 *
 * **Two delivery paths, on purpose.** A Postgres realtime subscription pushes
 * new notices within a second, and a slow interval re-reads regardless. The
 * poll is not redundancy for its own sake: a websocket can die quietly —
 * laptop lid closed, proxy timeout, a sleeping tab — and a notification system
 * whose failure mode is "silence" is indistinguishable from "no emergencies"
 * at exactly the moment that distinction matters. Sixty seconds is the worst
 * case if the socket is gone; a second is the normal case.
 *
 * **Realtime carries no data of its own.** The payload is ignored and the page
 * re-reads through RLS instead. Trusting a pushed row would mean trusting a
 * channel to have filtered someone else's patient out of it; re-reading means
 * the same policy that renders the page decides what is in it.
 *
 * The list is server-rendered, so it is correct before any of this runs and
 * with JavaScript disabled.
 */

/** Backstop cadence when the socket is not delivering. */
const REFRESH_MS = 60_000;

const SEVERITY_TONE: Record<string, "critical" | "notice" | "default"> = {
  CRITICAL: "critical",
  WARNING: "notice",
  INFO: "default",
};

export function CareInbox({
  notices,
  recipientId,
}: {
  notices: CareNotice[];
  recipientId: string;
}) {
  const router = useRouter();
  const [live, setLive] = useState(false);
  // Set when a notice arrives after the page rendered, so the reader knows the
  // list moved under them rather than wondering whether it is current.
  const [arrived, setArrived] = useState(0);
  const arrivedRef = useRef(0);

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`care-notices:${recipientId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "care_notifications",
          // Server-side filter. Not the access control — RLS is — but it keeps
          // a busy ward from pushing every notice to every clinician's socket.
          filter: `recipient_id=eq.${recipientId}`,
        },
        () => {
          arrivedRef.current += 1;
          setArrived(arrivedRef.current);
          router.refresh();
        },
      )
      .subscribe((status) => setLive(status === "SUBSCRIBED"));

    const timer = setInterval(() => router.refresh(), REFRESH_MS);

    return () => {
      clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, [recipientId, router]);

  const unread = notices.filter((n) => !n.readAt);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 py-3.5">
        <div className="flex items-center gap-2.5">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              live ? "bg-[var(--color-positive)]" : "bg-[var(--color-faint)]"
            }`}
            aria-hidden="true"
          />
          <span className="mono text-[11.5px] text-muted">
            {live ? "Live" : `Checking every ${REFRESH_MS / 1000}s`}
            {arrived > 0 && ` · ${arrived} arrived since you opened this page`}
          </span>
        </div>

        {unread.length > 0 && (
          <form action={dismissAllNotices}>
            <button
              type="submit"
              className="mono text-[11.5px] text-brand underline-offset-2 hover:underline"
            >
              Dismiss all {unread.length}
            </button>
          </form>
        )}
      </div>

      {notices.length === 0 ? (
        <p className="border-t border-rule px-6 py-5 text-[14px] text-muted">
          No alerts. AVERIS notifies you here when a patient you are responsible for needs
          attention.
        </p>
      ) : (
        <ul className="divide-y divide-rule border-t border-rule">
          {notices.map((notice) => (
            <li
              key={notice.id}
              className={`px-6 py-3.5 ${notice.readAt ? "opacity-60" : ""}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Chip tone={SEVERITY_TONE[notice.severity] ?? "default"}>
                      {notice.severity.toLowerCase()}
                    </Chip>
                    {notice.href ? (
                      <Link
                        href={notice.href}
                        className="text-[14.5px] font-medium text-brand hover:underline"
                      >
                        {notice.title}
                      </Link>
                    ) : (
                      <span className="text-[14.5px] font-medium">{notice.title}</span>
                    )}
                  </div>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-ink-soft">
                    {notice.body}
                  </p>
                  <p className="mono mt-1 text-[11px] text-muted">
                    <time dateTime={notice.createdAt}>
                      {new Date(notice.createdAt).toLocaleString()}
                    </time>
                  </p>
                </div>

                {!notice.readAt && (
                  <form action={dismissNotice}>
                    <input type="hidden" name="noticeId" value={notice.id} />
                    <button
                      type="submit"
                      className="mono text-[11.5px] text-muted underline-offset-2 hover:text-brand hover:underline"
                    >
                      Dismiss
                    </button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="border-t border-rule px-6 py-3 text-[12.5px] leading-relaxed text-muted">
        Dismissing an alert clears it from this list. It does not acknowledge or resolve the
        emergency — that happens on the patient&rsquo;s chart, next to the evidence for it.
      </p>
    </div>
  );
}

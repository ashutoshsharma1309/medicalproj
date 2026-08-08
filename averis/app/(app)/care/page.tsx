import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, Chip, Callout } from "@/components/ui";
import { formatDate } from "@/lib/utils/format";
import { listCareNotices } from "@/lib/care/care-inbox-service";
import { loadWatchlist, PERMISSION_DESCRIPTION } from "@/lib/care/caregiver-service";
import { CareInbox } from "../clinical/CareInbox";

export const metadata = { title: "People you care for" };
export const dynamic = "force-dynamic";

/**
 * The caregiver's view.
 *
 * Deliberately not a smaller clinical dashboard. A family member is not
 * triaging a caseload — they are watching one or two people they love, and the
 * question they open this page with is "is everything alright?", not "who
 * needs attention first".
 *
 * So there is no risk score, no trend line and no AI assessment here even for a
 * caregiver holding FULL. Those are clinical instruments: a risk percentage
 * shown to a worried son at midnight produces a phone call to a doctor or a
 * sleepless night, and in neither case did the number help. What a caregiver
 * gets is what is actionable to them — whether an emergency is open, whether
 * the device is still reporting, and the vitals if the patient chose to share
 * them.
 */
export default async function CaregiverPage() {
  const account = await requireUser();
  const supabase = await createClient();

  const [watchlist, notices] = await Promise.all([
    loadWatchlist(supabase, account.appUserId),
    listCareNotices(supabase, account.appUserId),
  ]);

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">AVERIS Care</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">People you care for</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          {watchlist.length === 0
            ? "Nobody has given you access yet."
            : `You are listed as a caregiver for ${watchlist.length} ${
                watchlist.length === 1 ? "person" : "people"
              }. They decide what you can see, and can change it at any time.`}
        </p>
      </header>

      <Card>
        <CardHeader
          eyebrow="Alerts"
          title="Emergency notifications"
          action={
            notices.filter((n) => !n.readAt).length > 0 ? (
              <Chip tone="critical">{notices.filter((n) => !n.readAt).length} unread</Chip>
            ) : null
          }
        />
        <CareInbox notices={notices} recipientId={account.appUserId} />
      </Card>

      {watchlist.length === 0 ? (
        <Callout tone="brand" title="Waiting on an invitation">
          A patient adds you from their own account, using the email address you signed up with.
          Once they do, the people you care for appear here.{" "}
          <Link href="/dashboard" className="font-semibold underline underline-offset-2">
            Back to your dashboard
          </Link>
        </Callout>
      ) : (
        <Card>
          <CardHeader eyebrow="Watchlist" title="Current status" />
          <ul className="divide-y divide-rule">
            {watchlist.map((person) => {
              const stale =
                person.lastSyncAt === null ||
                Date.now() - Date.parse(person.lastSyncAt) > 15 * 60 * 1000;

              return (
                <li key={person.patientId} className="px-6 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-[15px] font-medium">{person.fullName}</span>
                      {person.relationship && (
                        <span className="mono text-[12px] text-muted">
                          {person.relationship}
                        </span>
                      )}
                      {person.openEmergencies > 0 && (
                        <Chip tone="critical">
                          {person.openEmergencies} open emergency
                          {person.openEmergencies > 1 ? " events" : " event"}
                        </Chip>
                      )}
                    </div>
                    <span className="mono text-[11.5px] text-muted">
                      {PERMISSION_DESCRIPTION[person.permission]}
                    </span>
                  </div>

                  {person.openEmergencies === 0 && (
                    <p className="mt-1.5 text-[13.5px] text-ink-soft">
                      No emergency alerts.{" "}
                      {stale
                        ? "Their device is not currently reporting, so AVERIS is not monitoring them right now."
                        : "Their device is reporting normally."}
                    </p>
                  )}

                  {person.latestVitals ? (
                    <dl className="mt-2.5 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                      <Vital label="Heart rate" value={person.latestVitals.heartRate} unit="BPM" stale={stale} />
                      <Vital label="Blood oxygen" value={person.latestVitals.spo2} unit="%" stale={stale} />
                      <Vital
                        label="Temperature"
                        value={person.latestVitals.temperature}
                        unit="°C"
                        precision={1}
                        stale={stale}
                      />
                      <div>
                        <dt className="font-mono text-[9.5px] uppercase tracking-[0.13em] text-muted">
                          Last reading
                        </dt>
                        <dd className="mono mt-0.5 text-[13px]">
                          {person.lastSyncAt ? formatDate(person.lastSyncAt) : "—"}
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    person.permission === "VIEW_ALERTS" && (
                      <p className="mono mt-2 text-[11.5px] text-muted">
                        {person.fullName.split(" ")[0]} has shared emergency alerts with you, not
                        their measurements.
                      </p>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <p className="pb-2 text-[13px] leading-relaxed text-muted">
        AVERIS tells you when something needs attention. It does not diagnose, and it is not a
        substitute for emergency services — if you believe someone is in danger, call them.
      </p>
    </div>
  );
}

function Vital({
  label,
  value,
  unit,
  precision = 0,
  stale,
}: {
  label: string;
  value: number | null;
  unit: string;
  precision?: number;
  stale: boolean;
}) {
  return (
    <div className={stale ? "opacity-55" : ""}>
      <dt className="font-mono text-[9.5px] uppercase tracking-[0.13em] text-muted">{label}</dt>
      <dd className="mono mt-0.5 text-[13.5px]">
        {value === null ? (
          <span className="text-muted">—</span>
        ) : (
          <>
            {value.toFixed(precision)}
            <span className="ml-1 text-[11px] text-muted">{unit}</span>
          </>
        )}
      </dd>
    </div>
  );
}

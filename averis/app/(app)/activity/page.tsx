import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { listAudit, AUDIT_DESCRIPTION } from "@/lib/audit/audit-service";
import { listNotifications } from "@/lib/notifications/notification-service";
import { readEntitlements } from "@/lib/plans/entitlements";
import { Card, CardHeader, Chip, Callout } from "@/components/ui";
import { formatDate } from "@/lib/utils/format";
import { PLANS } from "@/lib/plans/limits";

export const metadata = { title: "Activity" };
export const dynamic = "force-dynamic";

/**
 * Account activity.
 *
 * Shows a patient their own audit trail, which is the reason the trail is
 * worth keeping rather than merely required. A log that only the operator can
 * read protects the operator; one the subject can read lets them notice
 * access they did not expect.
 *
 * The entries are deliberately thin — an action, a resource, a time. That is
 * what the audit service records, because a trail that repeated the contents
 * of each document would be a second copy of the health record under different
 * access rules.
 */
export default async function ActivityPage() {
  const account = await requireUser();
  const supabase = await createClient();

  const [entries, notifications, entitlements] = await Promise.all([
    listAudit(supabase, account.authUserId, 50).catch(() => []),
    account.patientProfileId
      ? listNotifications(supabase, account.patientProfileId).catch(() => [])
      : Promise.resolve([]),
    readEntitlements(supabase, account.appUserId),
  ]);

  const limits = PLANS[entitlements.plan];

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">Account</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">Activity and plan</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          Everything AVERIS has recorded about how your account has been used. This log cannot be
          edited or deleted — including by you — which is what makes it worth reading.
        </p>
      </header>

      {/* -------------------------------------------------------- plan */}
      <Card>
        <CardHeader
          eyebrow="Plan"
          title={entitlements.plan === "PREMIUM" ? "Premium" : "Free"}
          action={
            <Chip tone={entitlements.status === "ACTIVE" ? "positive" : "notice"}>
              {entitlements.status.toLowerCase().replace(/_/g, " ")}
            </Chip>
          }
        />
        <dl className="grid grid-cols-2 gap-x-8 gap-y-4 px-6 py-5 sm:grid-cols-4">
          <Stat
            label="Documents / month"
            value={limits.documentsPerMonth === null ? "Unlimited" : String(limits.documentsPerMonth)}
          />
          <Stat
            label="Questions / day"
            value={limits.questionsPerDay === null ? "Unlimited" : String(limits.questionsPerDay)}
          />
          <Stat label="Risk intelligence" value={limits.riskIntelligence ? "Included" : "—"} />
          <Stat label="AI health summary" value={limits.aiHealthSummary ? "Included" : "—"} />
        </dl>
        <div className="border-t border-rule px-6 py-4">
          <p className="text-[13px] leading-relaxed text-muted">
            Your documents and everything derived from them stay available regardless of plan or
            billing state. Limits apply to new uploads and questions, never to records you
            already have.
          </p>
        </div>
      </Card>

      {/* ------------------------------------------------ notifications */}
      {notifications.length > 0 && (
        <Card>
          <CardHeader
            eyebrow="Notifications"
            title="Recent updates"
            action={
              <span className="mono text-[12.5px] text-muted">
                {notifications.filter((n) => !n.readAt).length} unread
              </span>
            }
          />
          <ul className="divide-y divide-rule">
            {notifications.map((notification) => (
              <li key={notification.id} className="px-6 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[14.5px] font-medium">
                    {!notification.readAt && (
                      <span
                        className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-brand align-middle"
                        aria-label="Unread"
                      />
                    )}
                    {notification.title}
                  </span>
                  <span className="mono text-[12px] text-muted">
                    {formatDate(notification.createdAt)}
                  </span>
                </div>
                <p className="mt-1 text-[13.5px] leading-relaxed text-ink-soft">
                  {notification.body}
                </p>
                {notification.href && (
                  <Link
                    href={notification.href}
                    className="mt-1.5 inline-block text-[12.5px] font-medium text-brand hover:underline"
                  >
                    Open →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ----------------------------------------------------- audit */}
      <Card>
        <CardHeader
          eyebrow="Audit trail"
          title="What has happened on your account"
          action={<span className="mono text-[12.5px] text-muted">{entries.length} entries</span>}
        />

        {entries.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-[15px] font-medium">Nothing recorded yet</p>
            <p className="mx-auto mt-1.5 max-w-md text-[14px] leading-relaxed text-ink-soft">
              Uploading a document or asking AVERIS a question will appear here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-rule">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-6 py-3">
                <span className="text-[14px]">{AUDIT_DESCRIPTION[entry.action]}</span>
                <span className="mono shrink-0 text-[12px] text-muted">
                  {formatDate(entry.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Callout tone="brand" title="Why this log cannot be edited">
        Audit entries have no update or delete permission for any account, including yours. An
        activity record that its subject can revise would not be evidence of anything.
      </Callout>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted">{label}</dt>
      <dd className="mt-1 text-[14px] font-medium">{value}</dd>
    </div>
  );
}

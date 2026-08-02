import { db } from "@/lib/db";
import { Stat, SectionCard, EmptyState } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Admin Overview" };
export const dynamic = "force-dynamic";

const ACTION_LABEL: Record<string, string> = {
  "auth.login": "Sign-ins",
  "ai.extract": "Document extractions",
  "ai.risk_assess": "Risk assessments",
  "ai.note_generate": "Notes drafted",
  "ai.knowledge_query": "Knowledge queries",
  "meds.safety_check": "Safety checks",
  "triage.create": "Triage scorings",
};

export default async function AdminOverview() {
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
  const [users, patients, notes, docs, actions, recent] = await Promise.all([
    db.user.count(),
    db.patient.count(),
    db.clinicalNote.count(),
    db.document.count(),
    db.auditLog.groupBy({ by: ["action"], _count: { _all: true } }),
    db.auditLog.count({ where: { createdAt: { gte: dayAgo } } }),
  ]);

  const aiActions = actions
    .filter((a) => a.action.startsWith("ai.") || a.action === "meds.safety_check" || a.action === "triage.create")
    .sort((a, b) => b._count._all - a._count._all);
  const maxCount = Math.max(1, ...aiActions.map((a) => a._count._all));

  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">System administration</div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">Platform overview</h1>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Registered users" value={users} sub="Across all roles" />
        <Stat label="Patient records" value={patients} sub="Active in registry" />
        <Stat label="Clinical notes" value={notes} sub="Drafted or finalized" />
        <Stat label="Events · 24h" value={recent} sub="Audit trail entries" />
      </div>

      <SectionCard eyebrow="Intelligence layer" title="Engine utilization (all time)">
        {aiActions.length === 0 ? (
          <EmptyState title="No engine activity yet" hint="Extractions, risk assessments and safety checks are counted here." />
        ) : (
          <div className="space-y-3 px-5 pb-5">
            {aiActions.map((a) => (
              <div key={a.action}>
                <div className="flex items-baseline justify-between">
                  <span className="text-[13px] font-medium">
                    {ACTION_LABEL[a.action] ?? a.action}
                  </span>
                  <span className="mono-data text-xs font-semibold">{a._count._all}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-scrub-wash">
                  <div
                    className="h-1.5 rounded-full bg-scrub"
                    style={{ width: `${Math.max(4, (a._count._all / maxCount) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <RecentAudit />
    </div>
  );
}

async function RecentAudit() {
  const logs = await db.auditLog.findMany({
    include: { user: true },
    orderBy: { createdAt: "desc" },
    take: 8,
  });
  return (
    <SectionCard eyebrow="Compliance" title="Latest audit events">
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id}>
              <td className="mono-data text-xs">{fmtDateTime(l.createdAt)}</td>
              <td>{l.user?.name ?? "—"}</td>
              <td className="mono-data text-xs">{l.action}</td>
              <td className="max-w-72 truncate text-muted">{l.detail ?? l.resource ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionCard>
  );
}

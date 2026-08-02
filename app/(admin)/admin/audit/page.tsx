import { db } from "@/lib/db";
import { SectionCard } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Audit Trail" };
export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const logs = await db.auditLog.findMany({
    include: { user: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return (
    <div className="space-y-5">
      <header>
        <div className="eyebrow">Compliance</div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">Audit trail</h1>
        <p className="mt-1 text-[13px] text-muted">
          Every authentication, record access and AI invocation is written to an immutable log —
          the last 200 events are shown.
        </p>
      </header>
      <SectionCard>
        <table className="table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Resource</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td className="mono-data text-xs">{fmtDateTime(l.createdAt)}</td>
                <td>{l.user?.name ?? "—"}</td>
                <td className="mono-data text-xs">{l.action}</td>
                <td className="mono-data text-xs text-muted">{l.resource ?? "—"}</td>
                <td className="max-w-80 truncate text-muted">{l.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
    </div>
  );
}

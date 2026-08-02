import { db } from "@/lib/db";
import { SectionCard, Chip } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Users" };
export const dynamic = "force-dynamic";

const ROLE_TONE: Record<string, string> = { DOCTOR: "medium", ADMIN: "high", PATIENT: "low" };

export default async function UsersPage() {
  const users = await db.user.findMany({
    include: { _count: { select: { auditLogs: true, notes: true } } },
    orderBy: { createdAt: "asc" },
  });

  return (
    <div className="space-y-5">
      <header>
        <div className="eyebrow">Access control</div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">Users &amp; roles</h1>
      </header>
      <SectionCard>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Title</th>
              <th>Since</th>
              <th>Activity</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="font-semibold">{u.name}</td>
                <td className="mono-data text-xs">{u.email}</td>
                <td><Chip tone={ROLE_TONE[u.role] ?? "neutral"}>{u.role.toLowerCase()}</Chip></td>
                <td className="text-muted">{u.title ?? "—"}</td>
                <td className="mono-data text-xs">{fmtDate(u.createdAt)}</td>
                <td className="mono-data text-xs text-muted">
                  {u._count.auditLogs} events · {u._count.notes} notes
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
    </div>
  );
}

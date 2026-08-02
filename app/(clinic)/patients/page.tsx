import Link from "next/link";
import { db } from "@/lib/db";
import { SectionCard, SeverityChip } from "@/components/ui";
import { ageOf, fmtDate } from "@/lib/format";

export const metadata = { title: "Patients" };
export const dynamic = "force-dynamic";

export default async function PatientsPage(props: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await props.searchParams;
  const patients = await db.patient.findMany({
    where: q
      ? {
          OR: [
            { firstName: { contains: q, mode: "insensitive" } },
            { lastName: { contains: q, mode: "insensitive" } },
            { mrn: { contains: q, mode: "insensitive" } },
          ],
        }
      : undefined,
    include: {
      conditions: { where: { status: { not: "RESOLVED" } } },
      allergies: true,
      riskAssessments: { orderBy: { createdAt: "desc" }, take: 2 },
    },
    orderBy: { lastName: "asc" },
  });

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <div className="eyebrow">Registry</div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight">Patients</h1>
        </div>
        <form className="w-72">
          <input
            type="search"
            name="q"
            defaultValue={q}
            className="field"
            placeholder="Search name or MRN…"
            aria-label="Search patients"
          />
        </form>
      </header>

      <SectionCard>
        <table className="table">
          <thead>
            <tr>
              <th>Patient</th>
              <th>MRN</th>
              <th>Age / Sex</th>
              <th>Active problems</th>
              <th>Allergies</th>
              <th>Highest risk</th>
            </tr>
          </thead>
          <tbody>
            {patients.map((p) => {
              const topRisk = [...p.riskAssessments].sort((a, b) => b.score - a.score)[0];
              return (
                <tr key={p.id}>
                  <td>
                    <Link href={`/patients/${p.id}`} className="font-semibold hover:text-scrub">
                      {p.lastName}, {p.firstName}
                    </Link>
                    <div className="text-xs text-faint">DOB {fmtDate(p.dateOfBirth)}</div>
                  </td>
                  <td className="mono-data text-xs">{p.mrn}</td>
                  <td>
                    {ageOf(p.dateOfBirth)} · {p.sex[0]}
                  </td>
                  <td className="max-w-56 text-muted">
                    {p.conditions.map((c) => c.name).join("; ") || "—"}
                  </td>
                  <td>
                    {p.allergies.length > 0 ? (
                      <span className="chip chip-critical">{p.allergies.length} documented</span>
                    ) : (
                      <span className="text-xs text-faint">None known</span>
                    )}
                  </td>
                  <td>
                    {topRisk ? (
                      <span className="flex items-center gap-2">
                        <SeverityChip level={topRisk.band} />
                        <span className="mono-data text-xs text-muted">
                          {topRisk.domain} {topRisk.score}
                        </span>
                      </span>
                    ) : (
                      <span className="text-xs text-faint">Not yet assessed</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </SectionCard>
    </div>
  );
}

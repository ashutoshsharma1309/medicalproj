import Link from "next/link";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { Stat, SectionCard, SeverityChip, EmptyState } from "@/components/ui";
import { fmtDateTime, minutesSince, ageOf } from "@/lib/format";

export const metadata = { title: "Today" };
export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const user = await getSession();
  const [patientCount, waiting, criticalWaiting, draftNotes, recentDocs, recentEvents] =
    await Promise.all([
      db.patient.count(),
      db.triageCase.findMany({
        where: { status: "WAITING" },
        include: { patient: true },
        orderBy: [{ acuity: "asc" }, { arrivedAt: "asc" }],
      }),
      db.triageCase.count({ where: { status: "WAITING", priority: "CRITICAL" } }),
      db.clinicalNote.count({ where: { status: "DRAFT" } }),
      db.document.findMany({
        include: { patient: true },
        orderBy: { uploadedAt: "desc" },
        take: 4,
      }),
      db.timelineEvent.findMany({
        where: { severity: { in: ["CRITICAL", "HIGH"] } },
        include: { patient: true },
        orderBy: { occurredAt: "desc" },
        take: 5,
      }),
    ]);

  const now = new Date();
  const greeting =
    now.getHours() < 12 ? "Good morning" : now.getHours() < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">
          {now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
        </div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">
          {greeting}, {user?.name?.replace("Dr. ", "Dr ")}
        </h1>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Patients on service" value={patientCount} sub="Under your care team" />
        <Stat
          label="ED queue"
          value={waiting.length}
          sub="Awaiting assessment"
          tone={waiting.length > 3 ? "warn" : "default"}
        />
        <Stat
          label="Critical acuity"
          value={criticalWaiting}
          sub="Immediate attention required"
          tone={criticalWaiting > 0 ? "critical" : "ok"}
        />
        <Stat label="Draft notes" value={draftNotes} sub="Pending review and sign-off" />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <SectionCard
          className="lg:col-span-3"
          eyebrow="Emergency department"
          title="Triage queue"
          action={
            <Link href="/triage" className="btn btn-secondary text-xs">
              Open board
            </Link>
          }
        >
          {waiting.length === 0 ? (
            <EmptyState title="No patients waiting" hint="New arrivals appear here, highest acuity first." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Priority</th>
                  <th>Patient</th>
                  <th>Chief complaint</th>
                  <th>Waiting</th>
                </tr>
              </thead>
              <tbody>
                {waiting.slice(0, 5).map((t) => (
                  <tr key={t.id}>
                    <td><SeverityChip level={t.priority} label={`ESI ${t.acuity}`} /></td>
                    <td>
                      <Link href={`/patients/${t.patientId}`} className="font-medium hover:text-scrub">
                        {t.patient.lastName}, {t.patient.firstName}
                      </Link>
                      <span className="ml-2 text-xs text-faint">{ageOf(t.patient.dateOfBirth)}y</span>
                    </td>
                    <td className="text-muted">{t.chiefComplaint}</td>
                    <td className="mono-data text-xs">{minutesSince(t.arrivedAt)} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>

        <SectionCard className="lg:col-span-2" eyebrow="Signals" title="Recent high-severity events">
          {recentEvents.length === 0 ? (
            <EmptyState title="No recent alerts" />
          ) : (
            <ul className="divide-y divide-hairline">
              {recentEvents.map((e) => (
                <li key={e.id} className="flex items-start gap-3 px-5 py-3">
                  <SeverityChip level={e.severity} />
                  <div className="min-w-0">
                    <Link
                      href={`/patients/${e.patientId}`}
                      className="block truncate text-[13px] font-medium hover:text-scrub"
                    >
                      {e.title}
                    </Link>
                    <div className="text-xs text-muted">
                      {e.patient.lastName}, {e.patient.firstName} · {fmtDateTime(e.occurredAt)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard
        eyebrow="Document intelligence"
        title="Recently processed documents"
        action={
          <Link href="/intelligence" className="btn btn-secondary text-xs">
            Analyze a document
          </Link>
        }
      >
        {recentDocs.length === 0 ? (
          <EmptyState title="No documents yet" hint="Upload lab reports or discharge summaries to extract structured intelligence." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Patient</th>
                <th>Type</th>
                <th>Engine</th>
                <th>Processed</th>
              </tr>
            </thead>
            <tbody>
              {recentDocs.map((d) => (
                <tr key={d.id}>
                  <td className="font-medium">{d.filename}</td>
                  <td>
                    <Link href={`/patients/${d.patientId}`} className="hover:text-scrub">
                      {d.patient.lastName}, {d.patient.firstName}
                    </Link>
                  </td>
                  <td className="text-muted">{d.kind.replace(/_/g, " ")}</td>
                  <td className="mono-data text-xs text-muted">{d.extractedWith}</td>
                  <td className="mono-data text-xs">{fmtDateTime(d.uploadedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
    </div>
  );
}

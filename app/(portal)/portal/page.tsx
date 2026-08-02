import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { SectionCard, Chip, EmptyState } from "@/components/ui";
import { fmtDate, fmtDateTime, ageOf } from "@/lib/format";

export const metadata = { title: "My Health" };
export const dynamic = "force-dynamic";

export default async function PortalPage() {
  const user = await getSession();
  const patient = await db.patient.findFirst({
    where: { userId: user!.id },
    include: {
      conditions: { where: { status: { not: "RESOLVED" } }, orderBy: { diagnosedAt: "desc" } },
      allergies: true,
      medications: { where: { status: "ACTIVE" }, orderBy: { startedAt: "desc" } },
      labReports: { include: { values: true }, orderBy: { collectedAt: "desc" }, take: 3 },
      timelineEvents: { orderBy: { occurredAt: "desc" }, take: 8 },
      notes: { where: { status: "FINALIZED" }, orderBy: { createdAt: "desc" }, take: 3 },
      documents: { orderBy: { uploadedAt: "desc" }, take: 5 },
    },
  });

  // First login after signup → medical profile onboarding
  if (!patient || !patient.profileCompleted) redirect("/portal/setup");

  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">Personal health record</div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">
          Hello, {patient.firstName}
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          A clear view of your conditions, medicines and results — in plain language.
        </p>
      </header>

      {patient.allergies.length > 0 && (
        <div className="allergy-band flex items-center gap-3 rounded-md px-4 py-3">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-critical">
            Allergies
          </span>
          <span className="text-[13px] font-medium text-critical">
            {patient.allergies.map((a) => a.substance).join(" · ")} — always mention these to any
            clinician or pharmacist treating you.
          </span>
        </div>
      )}

      <SectionCard
        eyebrow="Personal information"
        title="Your details"
        action={
          <Link href="/portal/setup" className="btn btn-secondary text-xs">
            Edit profile
          </Link>
        }
      >
        <dl className="grid grid-cols-2 gap-x-8 gap-y-4 px-5 pb-5 sm:grid-cols-3 lg:grid-cols-4">
          {(
            [
              ["Record number", patient.mrn, true],
              ["Date of birth", `${fmtDate(patient.dateOfBirth)} (${ageOf(patient.dateOfBirth)}y)`, false],
              ["Gender", patient.sex, false],
              ["Blood group", patient.bloodType ?? "Not recorded", true],
              ["Phone", patient.phone ?? "Not recorded", true],
              ["Emergency contact", patient.emergencyContactName ? `${patient.emergencyContactName}${patient.emergencyContactPhone ? ` · ${patient.emergencyContactPhone}` : ""}` : "Not recorded", false],
              ["Previous surgeries", patient.surgeries ?? "None recorded", false],
            ] as const
          ).map(([label, value, mono]) => (
            <div key={label}>
              <dt className="eyebrow">{label}</dt>
              <dd className={`mt-0.5 text-[13.5px] font-medium ${mono ? "mono-data" : ""}`}>{value}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>

      <SectionCard
        eyebrow="Documents"
        title="Your uploaded documents"
        action={
          <Link href="/portal/documents" className="btn btn-primary text-xs">
            Upload a document
          </Link>
        }
      >
        {patient.documents.length === 0 ? (
          <EmptyState
            title="No documents yet"
            hint="Upload a prescription or report — Meridian reads it and suggests profile updates for your approval."
          />
        ) : (
          <ul className="divide-y divide-hairline">
            {patient.documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="min-w-0">
                  <Link
                    href={`/portal/documents/${d.id}`}
                    className="block truncate text-[13.5px] font-medium hover:text-scrub"
                  >
                    {d.filename}
                  </Link>
                  <span className="text-xs text-faint">
                    {d.kind.replace(/_/g, " ")} · {fmtDateTime(d.uploadedAt)}
                  </span>
                </div>
                <Chip
                  tone={
                    d.extractionStatus === "CONFIRMED"
                      ? "low"
                      : d.extractionStatus === "EXTRACTED"
                        ? "high"
                        : "neutral"
                  }
                >
                  {d.extractionStatus === "EXTRACTED"
                    ? "Review needed"
                    : d.extractionStatus.toLowerCase()}
                </Chip>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard eyebrow="Conditions" title="What we're looking after">
          <ul className="divide-y divide-hairline">
            {patient.conditions.map((c) => (
              <li key={c.id} className="px-5 py-3">
                <div className="text-[13.5px] font-semibold">{c.name}</div>
                <div className="text-xs text-muted">Since {fmtDate(c.diagnosedAt)}</div>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard eyebrow="Medicines" title="Your current medications">
          <ul className="divide-y divide-hairline">
            {patient.medications.map((m) => (
              <li key={m.id} className="flex items-baseline justify-between px-5 py-3">
                <div>
                  <div className="text-[13.5px] font-semibold">{m.name}</div>
                  <div className="text-xs text-muted">
                    {m.dose} — {m.frequency}
                  </div>
                </div>
                <span className="mono-data text-xs text-faint">since {fmtDate(m.startedAt)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>

      <SectionCard eyebrow="Results" title="Recent test results">
        {patient.labReports.length === 0 ? (
          <EmptyState title="No results yet" />
        ) : (
          <div className="divide-y divide-hairline">
            {patient.labReports.map((r) => {
              const abnormal = r.values.filter((v) => v.flag);
              return (
                <div key={r.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-[13.5px] font-semibold">{r.title}</span>
                    <span className="text-xs text-faint">{fmtDate(r.collectedAt)}</span>
                    {abnormal.length > 0 ? (
                      <Chip tone="high">{abnormal.length} to discuss</Chip>
                    ) : (
                      <Chip tone="low">All in range</Chip>
                    )}
                  </div>
                  {r.summary && (
                    <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-muted">{r.summary}</p>
                  )}
                  {abnormal.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {abnormal.map((v) => (
                        <Chip key={v.id} tone={v.flag === "H" ? "critical" : "medium"}>
                          {v.analyte}: {v.value} {v.unit} ({v.flag === "H" ? "high" : "low"})
                        </Chip>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard eyebrow="Visits" title="From your recent visits">
          {patient.notes.length === 0 ? (
            <EmptyState title="No visit summaries yet" />
          ) : (
            <ul className="divide-y divide-hairline">
              {patient.notes.map((n) => (
                <li key={n.id} className="px-5 py-3.5">
                  <div className="text-xs text-faint">{fmtDate(n.createdAt)}</div>
                  <p className="mt-1 text-[13px] leading-relaxed">{n.summary}</p>
                  {n.followUp && (
                    <p className="mt-1.5 text-[13px] font-medium text-scrub">Next: {n.followUp}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard eyebrow="History" title="Your health timeline">
          <ul className="timeline-spine mx-5 mb-5 mt-1 space-y-4 pl-7">
            {patient.timelineEvents.map((e) => (
              <li key={e.id} className="relative">
                <span
                  className="timeline-dot"
                  style={{ background: "var(--color-scrub-mid)", left: "-28px" }}
                />
                <div className="mono-data text-xs text-faint">{fmtDate(e.occurredAt)}</div>
                <div className="text-[13px] font-medium">{e.title}</div>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>
    </div>
  );
}

import { db } from "@/lib/db";
import { ageOf } from "@/lib/format";
import { TriageBoard } from "./TriageBoard";
import { TriageForm } from "./TriageForm";

export const metadata = { title: "Emergency Triage" };
export const dynamic = "force-dynamic";

export default async function TriagePage() {
  const [cases, patients] = await Promise.all([
    db.triageCase.findMany({
      where: { status: { not: "DISCHARGED" } },
      include: { patient: true },
      orderBy: [{ acuity: "asc" }, { arrivedAt: "asc" }],
    }),
    db.patient.findMany({ orderBy: { lastName: "asc" } }),
  ]);

  const board = cases.map((c) => ({
    id: c.id,
    patientId: c.patientId,
    patientName: `${c.patient.lastName}, ${c.patient.firstName}`,
    age: ageOf(c.patient.dateOfBirth),
    arrivedAt: c.arrivedAt.toISOString(),
    chiefComplaint: c.chiefComplaint,
    symptoms: c.symptoms as string[],
    vitals: c.vitals as Record<string, number>,
    acuity: c.acuity,
    priority: c.priority,
    score: c.score,
    rationale: c.rationale as { factor: string; points: number; why: string }[],
    status: c.status,
    assignedTo: c.assignedTo,
  }));

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <div className="eyebrow">Emergency department</div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight">Triage queue</h1>
          <p className="mt-1 text-[13px] text-muted">
            Ordered by acuity, then arrival. Every score is decomposed into its contributing
            factors — expand a card to see why.
          </p>
        </div>
      </header>

      <TriageBoard initial={board} />

      <TriageForm patients={patients.map((p) => ({ id: p.id, label: `${p.lastName}, ${p.firstName} · ${p.mrn}` }))} />
    </div>
  );
}

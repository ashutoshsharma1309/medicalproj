import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { ageOf, fmtDate, initials } from "@/lib/format";
import { PatientTabs } from "./PatientTabs";

export default async function PatientLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const patient = await db.patient.findUnique({
    where: { id },
    include: { allergies: true, conditions: { where: { status: { not: "RESOLVED" } } } },
  });
  if (!patient) notFound();

  const bmi =
    patient.heightCm && patient.weightKg
      ? patient.weightKg / Math.pow(patient.heightCm / 100, 2)
      : null;

  return (
    <div className="space-y-5">
      {/* Patient spine — identity banner styled after a chart header */}
      <header className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-6 py-4">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-scrub text-[15px] font-semibold text-white">
              {initials(patient.firstName, patient.lastName)}
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                {patient.lastName}, {patient.firstName}
              </h1>
              <div className="mono-data text-xs text-muted">
                {patient.mrn} · {ageOf(patient.dateOfBirth)}y {patient.sex} · DOB{" "}
                {fmtDate(patient.dateOfBirth)}
              </div>
            </div>
          </div>

          <dl className="flex gap-8 text-[13px]">
            <div>
              <dt className="eyebrow">Blood type</dt>
              <dd className="mono-data mt-0.5 font-semibold">{patient.bloodType ?? "—"}</dd>
            </div>
            <div>
              <dt className="eyebrow">BMI</dt>
              <dd className="mono-data mt-0.5 font-semibold">{bmi ? bmi.toFixed(1) : "—"}</dd>
            </div>
            <div>
              <dt className="eyebrow">Smoking</dt>
              <dd className="mt-0.5 font-medium">{patient.smoker ? "Current smoker" : "Non-smoker"}</dd>
            </div>
            <div className="max-w-72">
              <dt className="eyebrow">Active problems</dt>
              <dd className="mt-0.5 truncate font-medium">
                {patient.conditions.map((c) => c.name).join("; ") || "None active"}
              </dd>
            </div>
          </dl>
        </div>

        {patient.allergies.length > 0 && (
          <div className="allergy-band mx-6 mb-4 flex items-center gap-3 rounded-md px-4 py-2">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-critical">
              Allergy
            </span>
            <span className="text-[13px] font-medium text-critical">
              {patient.allergies
                .map((a) => `${a.substance}${a.reaction ? ` (${a.reaction})` : ""}`)
                .join("  ·  ")}
            </span>
          </div>
        )}

        <PatientTabs patientId={patient.id} />
      </header>

      {children}
    </div>
  );
}

import type { AssessmentSetup } from "@/lib/carebridge/types";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11.5px] font-semibold uppercase tracking-wide text-cb-faint">{label}</dt>
      <dd className="mt-0.5 text-[14px] text-cb-ink">{value || "Not reported"}</dd>
    </div>
  );
}

export function PatientInfoCard({ setup }: { setup: AssessmentSetup }) {
  return (
    <section className="cb-card p-5" aria-label="Patient information">
      <h2 className="text-[13.5px] font-semibold text-cb-ink">Patient information</h2>
      <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Field label="Age" value={setup.age ? `${setup.age} years old` : ""} />
        <Field label="Preferred language" value={setup.language} />
        <Field label="Existing conditions" value={setup.existingConditions} />
        <Field label="Current medications" value={setup.currentMedications} />
      </dl>
    </section>
  );
}

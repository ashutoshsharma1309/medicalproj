import type { DoctorSummary as DoctorSummaryT } from "@/lib/carebridge/types";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-3 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-[12.5px] font-semibold uppercase tracking-wide text-cb-faint">{label}</dt>
      <dd className="text-[14px] leading-relaxed text-cb-ink">{children}</dd>
    </div>
  );
}

export function DoctorSummary({ summary }: { summary: DoctorSummaryT }) {
  return (
    <section className="cb-card p-5 sm:p-6" aria-label="Pre-consultation summary">
      <header>
        <p className="text-[12px] font-semibold uppercase tracking-wide text-cb-primary">
          CareBridge · Pre-Consultation Summary
        </p>
        <h2 className="mt-1 text-[19px] font-semibold text-cb-ink">
          Prepared for your consultation
        </h2>
        <p className="mt-1 text-[12.5px] text-cb-faint">
          Generated {new Date(summary.generatedAt).toLocaleString()}
        </p>
      </header>

      <dl className="mt-4 divide-y divide-cb-border">
        <Row label="Patient">{summary.patientAge} years old · {summary.language}</Row>
        <Row label="Primary concern">{summary.primaryConcern || "Not reported"}</Row>
        <Row label="Symptoms">{summary.symptoms.join(", ") || "Not reported"}</Row>
        <Row label="Duration">{summary.duration}</Row>
        <Row label="Severity">{summary.severity}</Row>
        {summary.reportedTemperature && <Row label="Reported temperature">{summary.reportedTemperature}</Row>}
        <Row label="Relevant history">{summary.relevantHistory}</Row>
        <Row label="Current medications">{summary.currentMedications}</Row>
        <Row label="Reported warning signs">{summary.warningSigns}</Row>
      </dl>

      <p className="mt-4 border-t border-cb-border pt-4 text-[12px] leading-relaxed text-cb-faint">
        This summary was organized by CareBridge, an AI-powered pre-consultation assistant. It
        provides informational support and does not replace professional medical advice, diagnosis,
        or treatment.
      </p>
    </section>
  );
}

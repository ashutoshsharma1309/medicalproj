import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { loadCaseload, triageReason } from "@/lib/care/care-team-service";
import type { CaseloadPatient } from "@/lib/care/triage";
import { Card, CardHeader, Chip, Callout } from "@/components/ui";
import { formatDate } from "@/lib/utils/format";
import { recordAudit } from "@/lib/audit/audit-service";

export const metadata = { title: "Clinical Monitoring" };
export const dynamic = "force-dynamic";

/**
 * The clinician's caseload.
 *
 * Answers the four questions the brief asks, in order, because that is the
 * order a clinician asks them: who needs attention (the sort), what is
 * happening (the vitals column), why AVERIS said so (the triage reason and the
 * link to the assessment), and what to do (the emergency queue).
 *
 * The list shows every assigned patient, not just the concerning ones. A
 * monitoring platform that hides the quiet patients is one where nobody
 * notices a device going silent — which is why "not reporting" sorts upward
 * rather than being filtered out.
 */
export default async function ClinicalPage() {
  const account = await requireUser();
  const supabase = await createClient();

  const { data: doctor } = await supabase
    .from("doctors")
    .select("id, full_name, specialization, hospital_name")
    .eq("user_id", account.appUserId)
    .maybeSingle();

  if (!doctor) {
    // Not an authorization check — RLS already returns nothing to a
    // non-clinician. This is so the page explains itself rather than rendering
    // an empty table.
    return (
      <div className="space-y-6">
        <header>
          <p className="eyebrow">AVERIS Clinical</p>
          <h1 className="mt-2 text-[24px] font-semibold leading-tight">
            Clinical monitoring
          </h1>
        </header>
        <Callout tone="brand" title="This area is for clinicians">
          Your account is not registered as a clinician. If you are a doctor using AVERIS, ask
          an administrator to add your licence details.{" "}
          <Link href="/dashboard" className="font-semibold underline underline-offset-2">
            Back to your dashboard
          </Link>
        </Callout>
      </div>
    );
  }

  const caseload = await loadCaseload(supabase);

  // Every clinician's view of a caseload is recorded. This is the main control
  // against a doctor browsing charts they have access to but no reason to open
  // — access control says who *may* look; the audit trail is what makes
  // looking accountable.
  await recordAudit(supabase, account.authUserId, {
    action: "HEALTH_SUMMARY_VIEWED",
    resourceType: "PROFILE",
    metadata: { outcome: "caseload_viewed", recordCount: caseload.length },
  });

  const needingAttention = caseload.filter(
    (p) => p.openEmergencies > 0 || p.riskLevel === "HIGH" || p.riskLevel === "CRITICAL",
  );

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">AVERIS Clinical</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">
          {doctor.full_name}
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          {[doctor.specialization, doctor.hospital_name].filter(Boolean).join(" · ") ||
            "Clinical monitoring"}
          {" — "}
          {caseload.length} assigned {caseload.length === 1 ? "patient" : "patients"}.
        </p>
      </header>

      {caseload.length === 0 ? (
        <Callout tone="brand" title="No patients assigned yet">
          Patients grant access from their own account. Once someone assigns you, they appear
          here ordered by who needs attention first.
        </Callout>
      ) : (
        <>
          {needingAttention.length > 0 ? (
            <Callout tone="critical" title={`${needingAttention.length} needing attention`}>
              {needingAttention.map((p) => p.fullName).join(", ")} —{" "}
              {needingAttention.filter((p) => p.openEmergencies > 0).length} with open emergency
              events.
            </Callout>
          ) : (
            <Callout tone="brand" title="No open emergencies">
              Every assigned patient is below the high-risk threshold. Patients whose devices
              stop reporting still appear near the top of the list.
            </Callout>
          )}

          <Card>
            <CardHeader
              eyebrow="Caseload"
              title="Patients by priority"
              action={
                <span className="mono text-[12.5px] text-muted">
                  emergencies first, then risk
                </span>
              }
            />
            <ul className="divide-y divide-rule">
              {caseload.map((patient) => (
                <PatientRow key={patient.patientId} patient={patient} />
              ))}
            </ul>
          </Card>
        </>
      )}

      <p className="pb-2 text-[13px] leading-relaxed text-muted">
        AVERIS surfaces measurements and the thresholds they crossed. It does not diagnose, and
        clinical decisions remain yours. Every chart you open is recorded in the patient&rsquo;s
        access log.
      </p>
    </div>
  );
}

const RISK_TONE: Record<string, "positive" | "notice" | "critical" | "default"> = {
  LOW: "positive",
  MODERATE: "notice",
  HIGH: "critical",
  CRITICAL: "critical",
};

// Shape as well as colour: AVERIS's amber and red are indistinguishable under
// deuteranopia, and a triage list read by colour alone is one a colourblind
// clinician cannot use.
const RISK_GLYPH: Record<string, string> = {
  LOW: "●",
  MODERATE: "▲",
  HIGH: "■",
  CRITICAL: "■",
};

function PatientRow({ patient }: { patient: CaseloadPatient }) {
  const silent = patient.deviceStatus === "OFFLINE" || patient.deviceStatus === null;

  return (
    <li className="px-6 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            href={`/clinical/${patient.patientId}`}
            className="text-[15px] font-medium text-brand hover:underline"
          >
            {patient.fullName}
          </Link>
          {patient.age !== null && (
            <span className="mono text-[12.5px] text-muted">{patient.age}y</span>
          )}
          {patient.openEmergencies > 0 && (
            <Chip tone="critical">
              {patient.openEmergencies} emergency
              {patient.openEmergencies > 1 ? " events" : ""}
            </Chip>
          )}
          {patient.riskLevel && (
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true">{RISK_GLYPH[patient.riskLevel]}</span>
              <Chip tone={RISK_TONE[patient.riskLevel] ?? "default"}>
                {patient.riskLevel.toLowerCase()}
                {patient.riskScore !== null && ` ${Math.round(patient.riskScore * 100)}%`}
              </Chip>
            </span>
          )}
        </div>

        <span className="mono text-[12px] text-muted">{triageReason(patient)}</span>
      </div>

      <dl className="mt-2.5 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Vital label="Heart rate" value={patient.latestVitals?.heartRate} unit="BPM" stale={silent} />
        <Vital label="SpO2" value={patient.latestVitals?.spo2} unit="%" stale={silent} />
        <Vital
          label="Temp"
          value={patient.latestVitals?.temperature}
          unit="°C"
          precision={1}
          stale={silent}
        />
        <div>
          <dt className="font-mono text-[9.5px] uppercase tracking-[0.13em] text-muted">
            Device
          </dt>
          <dd className="mono mt-0.5 text-[13.5px]">
            {silent ? (
              <span className="text-[var(--color-critical)]">Not reporting</span>
            ) : (
              "Reporting"
            )}
          </dd>
          {patient.lastSyncAt && (
            <dd className="mono text-[11px] text-muted">{formatDate(patient.lastSyncAt)}</dd>
          )}
        </div>
      </dl>
    </li>
  );
}

function Vital({
  label,
  value,
  unit,
  precision = 0,
  stale,
}: {
  label: string;
  value: number | null | undefined;
  unit: string;
  precision?: number;
  stale: boolean;
}) {
  return (
    <div className={stale ? "opacity-55" : ""}>
      <dt className="font-mono text-[9.5px] uppercase tracking-[0.13em] text-muted">{label}</dt>
      <dd className="mono mt-0.5 text-[13.5px]">
        {value === null || value === undefined ? (
          // Never 0 — a zero reads as a measurement.
          <span className="text-muted">—</span>
        ) : (
          <>
            {value.toFixed(precision)}
            <span className="ml-1 text-[11px] text-muted">{unit}</span>
          </>
        )}
      </dd>
    </div>
  );
}

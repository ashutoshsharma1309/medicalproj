"use client";

import { useCareBridgeAssessment } from "@/lib/carebridge/assessment-context";
import { RiskStatusCard } from "@/components/carebridge/RiskStatusCard";
import { EmptyState } from "@/components/carebridge/EmptyState";
import { LoadingState } from "@/components/carebridge/LoadingState";
import { PrimaryButton } from "@/components/carebridge/PrimaryButton";
import { SecondaryButton } from "@/components/carebridge/SecondaryButton";
import type { ResultStatus } from "@/lib/carebridge/types";
import { IconChevronRight } from "@/components/carebridge/icons";

const PREVIEW_OPTIONS: { status: ResultStatus; label: string }[] = [
  { status: "routine", label: "Routine" },
  { status: "consult_soon", label: "Consult Soon" },
  { status: "urgent", label: "Urgent Attention" },
];

export default function AssessmentResultPage() {
  const { hasAssessment, findings, resultStatus, resultStatusOverride, setResultStatusOverride, isHydrated } =
    useCareBridgeAssessment();

  if (!isHydrated) return <LoadingState message="Loading your assessment…" />;

  if (!hasAssessment) {
    return (
      <EmptyState
        title="No assessment available yet"
        hint="Complete the health interview first to see your result here."
        action={<PrimaryButton href="/assessment">Start Health Assessment</PrimaryButton>}
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <p className="cb-status cb-status-neutral">Step 3 of 3</p>
        <h1 className="mt-3 text-[24px] font-semibold text-cb-ink">Your assessment result</h1>
        <p className="mt-1.5 text-[14px] text-cb-muted">
          Here's what CareBridge organized from your conversation.
        </p>
      </div>

      <RiskStatusCard status={resultStatus} />

      <section className="cb-card p-5">
        <h2 className="text-[13.5px] font-semibold text-cb-ink">Symptom summary</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {findings.symptoms.map((s) => (
            <span key={s} className="cb-status cb-status-neutral">
              {s}
            </span>
          ))}
        </div>
      </section>

      <section className="cb-card grid grid-cols-2 gap-4 p-5 sm:grid-cols-3">
        <div>
          <p className="text-[11.5px] font-semibold uppercase tracking-wide text-cb-faint">Duration</p>
          <p className="mt-0.5 text-[14px] text-cb-ink">{findings.duration}</p>
        </div>
        <div>
          <p className="text-[11.5px] font-semibold uppercase tracking-wide text-cb-faint">Severity</p>
          <p className="mt-0.5 text-[14px] text-cb-ink">{findings.severity}</p>
        </div>
        <div>
          <p className="text-[11.5px] font-semibold uppercase tracking-wide text-cb-faint">Temperature</p>
          <p className="mt-0.5 text-[14px] text-cb-ink">{findings.temperature ?? "Not reported"}</p>
        </div>
      </section>

      <section className="cb-card p-5">
        <h2 className="text-[13.5px] font-semibold text-cb-ink">Reported information</h2>
        <dl className="mt-2 space-y-2 text-[13.5px]">
          <div className="flex justify-between gap-4">
            <dt className="text-cb-muted">Warning signs</dt>
            <dd className="text-cb-ink">{findings.warningSigns}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-cb-muted">Relevant history</dt>
            <dd className="text-cb-ink">{findings.relevantHistory}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-cb-muted">Current medications</dt>
            <dd className="text-cb-ink">{findings.currentMedications}</dd>
          </div>
        </dl>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row">
        <PrimaryButton href="/assessment/summary" icon={<IconChevronRight />} className="sm:flex-1">
          View doctor-ready summary
        </PrimaryButton>
        <SecondaryButton href="/assessment">Start new assessment</SecondaryButton>
      </div>

      <section className="cb-card p-4">
        <p className="text-[11.5px] font-semibold uppercase tracking-wide text-cb-faint">
          Demo: preview other outcomes
        </p>
        <p className="cb-hint mt-1">
          For reviewing this Phase 2 prototype only — Phase 5's Safety Engine will decide this for
          real.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {PREVIEW_OPTIONS.map((opt) => (
            <button
              key={opt.status}
              type="button"
              className={`cb-quick-reply ${resultStatusOverride === opt.status ? "cb-btn-primary" : ""}`}
              onClick={() => setResultStatusOverride(resultStatusOverride === opt.status ? null : opt.status)}
              aria-pressed={resultStatusOverride === opt.status}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useCareBridgeAssessment } from "@/lib/carebridge/assessment-context";
import { buildDoctorSummary, formatSummaryAsText } from "@/lib/carebridge/mock/summary";
import { PatientInfoCard } from "@/components/carebridge/PatientInfoCard";
import { DoctorSummary } from "@/components/carebridge/DoctorSummary";
import { EmptyState } from "@/components/carebridge/EmptyState";
import { LoadingState } from "@/components/carebridge/LoadingState";
import { PrimaryButton } from "@/components/carebridge/PrimaryButton";
import { SecondaryButton } from "@/components/carebridge/SecondaryButton";
import { IconCopy, IconDownload, IconRefresh } from "@/components/carebridge/icons";

export default function AssessmentSummaryPage() {
  const router = useRouter();
  const { hasAssessment, setup, findings, resultStatus, resetAssessment, isHydrated } =
    useCareBridgeAssessment();
  const [copied, setCopied] = useState(false);

  const summary = useMemo(
    () => buildDoctorSummary(setup, findings, resultStatus),
    [setup, findings, resultStatus],
  );
  const summaryText = useMemo(() => formatSummaryAsText(summary), [summary]);

  if (!isHydrated) return <LoadingState message="Loading your summary…" />;

  if (!hasAssessment) {
    return (
      <EmptyState
        title="No assessment available yet"
        hint="Complete the health interview first to generate a doctor-ready summary."
        action={<PrimaryButton href="/assessment">Start Health Assessment</PrimaryButton>}
      />
    );
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(summaryText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the visible text can still be selected manually */
    }
  }

  function handleDownload() {
    const blob = new Blob([summaryText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "carebridge-summary.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleStartNew() {
    resetAssessment();
    router.push("/");
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <p className="cb-status cb-status-neutral">Ready to share</p>
        <h1 className="mt-3 text-[24px] font-semibold text-cb-ink">Pre-Consultation Summary</h1>
        <p className="mt-1.5 text-[14px] text-cb-muted">
          This is exactly what will be shared with your doctor — nothing more.
        </p>
      </div>

      <PatientInfoCard setup={setup} />
      <DoctorSummary summary={summary} />

      <div className="flex flex-wrap gap-3">
        <SecondaryButton onClick={handleDownload} icon={<IconDownload />}>
          Download summary
        </SecondaryButton>
        <SecondaryButton onClick={handleCopy} icon={<IconCopy />}>
          {copied ? "Copied!" : "Copy summary"}
        </SecondaryButton>
        <SecondaryButton onClick={handleStartNew} icon={<IconRefresh />} tone="ghost">
          Start new assessment
        </SecondaryButton>
      </div>
    </div>
  );
}

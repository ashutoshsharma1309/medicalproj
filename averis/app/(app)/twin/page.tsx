import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { buildDigitalTwin } from "@/lib/services/twin/digital-twin-service";
import { generateHealthSummary } from "@/lib/services/twin/health-summary-service";
import { groupByYear } from "@/lib/services/twin/timeline-service";
import { assessAllRisks } from "@/lib/ml/risk-service";
import { riskInsights } from "@/lib/ml/twin-integration";
import { Card, CardHeader, Chip, Callout, ButtonLink, DataPoint } from "@/components/ui";
import { formatDate } from "@/lib/utils/format";
import { OverviewMeter } from "./OverviewMeter";
import { HealthTimeline } from "./HealthTimeline";
import { InsightList } from "./InsightList";

export const metadata = { title: "Health Twin" };
export const dynamic = "force-dynamic";

export default async function HealthTwinPage() {
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const supabase = await createClient();
  const twin = await buildDigitalTwin(supabase, account.patientProfileId);
  const summary = await generateHealthSummary(twin);

  // Risk assessments render alongside the record-derived insights, but are
  // computed separately: one is arithmetic over confirmed data, the other a
  // statistical estimate from a public cohort. Sharing a code path would blur
  // a distinction the patient needs.
  const assessments = await assessAllRisks(supabase, account.patientProfileId);
  const insights = [...riskInsights(Object.values(assessments)), ...twin.insights];

  const currentMedications = twin.medications.filter((m) => m.endDate === null);
  const pastMedications = twin.medications.filter((m) => m.endDate !== null);
  const hasAnything = twin.documentCount > 0 || twin.conditions.length > 0;

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">AVERIS Health Twin</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">Your health journey</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          Everything AVERIS holds about you, assembled into one picture — built only from
          information you have confirmed.
        </p>
      </header>

      {!hasAnything && (
        <Callout tone="brand" title="Your twin is waiting for its first document">
          Add a report or prescription and AVERIS will start building your timeline, track your
          conditions and medications over time, and surface observations from your record.{" "}
          <Link href="/records" className="font-semibold underline underline-offset-2">
            Add a document
          </Link>
        </Callout>
      )}

      {/* ------------------------------------------------ 1. Health overview */}
      <Card>
        <CardHeader eyebrow="Section 1" title="Health overview" />

        <div className="border-b border-rule px-6 py-5">
          <p className="eyebrow mb-2">AVERIS health summary</p>
          <p className="max-w-3xl text-[15px] leading-relaxed">{summary.summary}</p>
          <p className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted">
            {summary.fallback
              ? "Assembled directly from your record — AI summary unavailable"
              : `Written by ${summary.model} from facts already in your record`}
            {summary.guardrailTriggered && " · adjusted to remove clinical interpretation"}
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-x-8 gap-y-6 border-b border-rule px-6 py-5 sm:grid-cols-4">
          <DataPoint label="Age" value={twin.age !== null ? `${twin.age} years` : "—"} mono />
          <DataPoint label="Blood group" value={twin.profile.bloodGroup ?? "—"} mono />
          <DataPoint label="Conditions tracked" value={String(twin.conditions.length)} mono />
          <DataPoint label="Documents" value={String(twin.documentCount)} mono />
        </dl>

        <div className="grid gap-6 px-6 py-5 md:grid-cols-2">
          <div>
            <p className="eyebrow mb-2.5">Conditions</p>
            {twin.conditions.length === 0 ? (
              <p className="text-[14px] text-muted">None recorded yet.</p>
            ) : (
              <ul className="space-y-2">
                {twin.conditions.map((condition) => (
                  <li key={condition.conditionName} className="flex items-baseline justify-between gap-4">
                    <span className="text-[14.5px] font-medium">{condition.conditionName}</span>
                    <span className="mono shrink-0 text-[12.5px] text-muted">
                      {condition.firstDetected
                        ? `since ${formatDate(condition.firstDetected)}`
                        : "date unknown"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="eyebrow mb-2.5">Current medication</p>
            {currentMedications.length === 0 ? (
              <p className="text-[14px] text-muted">None recorded yet.</p>
            ) : (
              <ul className="space-y-2">
                {currentMedications.map((medication, i) => (
                  <li key={`${medication.medicineName}-${i}`}>
                    <span className="text-[14.5px] font-medium">{medication.medicineName}</span>{" "}
                    <span className="text-[13.5px] text-muted">
                      {[medication.dosage, medication.frequency].filter(Boolean).join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {pastMedications.length > 0 && (
              <>
                <p className="eyebrow mt-4 mb-2">Previously recorded</p>
                <ul className="space-y-1">
                  {pastMedications.map((medication, i) => (
                    <li key={`${medication.medicineName}-past-${i}`} className="text-[13.5px] text-muted">
                      {medication.medicineName}
                      {medication.endDate && ` — until ${formatDate(medication.endDate)}`}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>

        {twin.profile.allergies.length > 0 && (
          <div className="border-t border-rule px-6 py-4">
            <Callout tone="critical" title="Allergies on your record">
              {twin.profile.allergies.join(" · ")} — mention these to any clinician or
              pharmacist treating you.
            </Callout>
          </div>
        )}
      </Card>

      {/* --------------------------------------------- Record overview score */}
      <Card>
        <CardHeader eyebrow="Record quality" title="How complete your record is" />
        <div className="grid gap-6 px-6 py-6 md:grid-cols-3">
          <OverviewMeter
            label="Record completeness"
            value={twin.overview.recordCompleteness}
            explanation={twin.overview.explanations.recordCompleteness}
          />
          <OverviewMeter
            label="Medication tracking"
            value={twin.overview.medicationTracking}
            explanation={twin.overview.explanations.medicationTracking}
          />
          <OverviewMeter
            label="Recent monitoring"
            value={twin.overview.recentMonitoring}
            explanation={twin.overview.explanations.recentMonitoring}
          />
        </div>
        <div className="border-t border-rule px-6 py-3.5">
          <p className="text-[13px] leading-relaxed text-muted">
            These figures describe how complete and current your <em>records</em> are. They are
            not a measure of your health, and they say nothing about any medical condition.
          </p>
        </div>
      </Card>

      {/* ---------------------------------------------- 2. Medical timeline */}
      <Card>
        <CardHeader
          eyebrow="Section 2"
          title="Medical timeline"
          action={
            <span className="mono text-[12.5px] text-muted">
              {twin.timeline.length} {twin.timeline.length === 1 ? "event" : "events"}
            </span>
          }
        />
        <HealthTimeline groups={groupByYear(twin.timeline)} />
      </Card>

      {/* ---------------------------------------------- 3. Health insights */}
      <Card>
        <CardHeader
          eyebrow="Section 3"
          title="Health insights"
          action={
            <span className="mono text-[12.5px] text-muted">
              {insights.length} {insights.length === 1 ? "observation" : "observations"}
            </span>
          }
        />
        <InsightList insights={insights} />
      </Card>

      {/* ----------------------------------------------- 4. Health records */}
      <Card>
        <CardHeader
          eyebrow="Section 4"
          title="Connected records"
          action={
            <Link href="/records" className="text-[13.5px] font-medium text-brand hover:underline">
              Medical Records Center
            </Link>
          }
        />
        <div className="px-6 py-5">
          {twin.documentCount === 0 ? (
            <div className="text-center">
              <p className="text-[15px] font-medium">No documents connected yet</p>
              <div className="mt-4">
                <ButtonLink href="/records">Add your first document</ButtonLink>
              </div>
            </div>
          ) : (
            <p className="text-[14.5px] leading-relaxed text-ink-soft">
              Your twin is built from <strong>{twin.documentCount}</strong> document
              {twin.documentCount === 1 ? "" : "s"}
              {twin.lastDocumentAt && `, most recently on ${formatDate(twin.lastDocumentAt)}`}.
              Every event and observation above links back to the document it came from.
            </p>
          )}
        </div>
      </Card>

      <p className="pb-2 text-[13px] leading-relaxed text-muted">
        AVERIS organizes your health information and does not provide medical advice or a
        diagnosis. Discuss anything in your record with your healthcare provider.
      </p>
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, Chip, Callout } from "@/components/ui";
import { formatDate } from "@/lib/utils/format";
import { EMERGENCY_LABEL, type EmergencyType } from "@/lib/care/escalation";
import { PERMISSION_DESCRIPTION, type CaregiverPermission } from "@/lib/care/caregiver-service";

export const metadata = { title: "Someone you care for" };
export const dynamic = "force-dynamic";

/**
 * One person, for their caregiver.
 *
 * This is where an emergency notification lands, so it opens with the thing
 * that was raised rather than with a summary of everything that is fine.
 *
 * A caregiver cannot acknowledge or resolve an emergency here, and that is not
 * an oversight in the UI — the database refuses it. Closing an emergency is a
 * statement that a clinician has dealt with the patient, and a worried family
 * member clearing an alert because they phoned and got no answer would produce
 * exactly the false reassurance the workflow exists to prevent.
 */
export default async function CaregiverPatientPage(props: {
  params: Promise<{ patientId: string }>;
}) {
  const { patientId } = await props.params;
  const account = await requireUser();
  const supabase = await createClient();

  const { data: assignment } = await supabase
    .from("patient_caregiver_assignments")
    .select("permission_level, relationship, status")
    .eq("patient_id", patientId)
    .eq("caregiver_id", account.appUserId)
    .eq("status", "ACTIVE")
    .maybeSingle();

  // A revoked or absent grant renders a 404, not a "no access" page. The
  // second confirms the patient exists, which is itself information a
  // revoked caregiver should not be given.
  if (!assignment) notFound();

  const permission = assignment.permission_level as CaregiverPermission;

  const [directory, emergencies, readings] = await Promise.all([
    // The name, without needing patient_profiles — which a VIEW_ALERTS
    // caregiver deliberately cannot read.
    supabase.rpc("care_patient_directory"),
    supabase
      .from("emergency_events")
      .select("id, event_type, severity, status, summary, created_at, resolved_at")
      .eq("patient_id", patientId)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("sensor_readings")
      .select("heart_rate, spo2, temperature, recorded_at")
      .eq("patient_id", patientId)
      .order("recorded_at", { ascending: false })
      .limit(1),
  ]);

  const name =
    (directory.data ?? []).find((row) => row.patient_id === patientId)?.full_name ??
    "The person you care for";
  const open = (emergencies.data ?? []).filter((e) =>
    ["NEW", "ACKNOWLEDGED", "IN_PROGRESS"].includes(e.status),
  );
  const latest = readings.data?.[0] ?? null;

  return (
    <div className="space-y-7">
      <header>
        <Link href="/care" className="text-[13px] text-brand hover:underline">
          ← People you care for
        </Link>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">{name}</h1>
        <p className="mt-1.5 mono text-[12.5px] text-muted">
          {[assignment.relationship, PERMISSION_DESCRIPTION[permission]]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </header>

      {open.length > 0 ? (
        <Callout tone="critical" title={`${open.length} open emergency ${open.length === 1 ? "alert" : "alerts"}`}>
          A clinician has been notified. If you believe {name.split(" ")[0]} is in immediate
          danger, call them or the emergency services — AVERIS is a monitoring system, not a
          response service.
        </Callout>
      ) : (
        <Callout tone="brand" title="No open emergency alerts">
          AVERIS will tell you here, and by notification, if something needs attention.
        </Callout>
      )}

      {(emergencies.data ?? []).length > 0 && (
        <Card>
          <CardHeader eyebrow="Alerts" title="Recent emergency events" />
          <ul className="divide-y divide-rule">
            {(emergencies.data ?? []).map((event) => (
              <li key={event.id} className="px-6 py-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Chip tone={event.severity === "CRITICAL" ? "critical" : "notice"}>
                    {EMERGENCY_LABEL[event.event_type as EmergencyType] ?? event.event_type}
                  </Chip>
                  <span className="mono text-[12px] text-muted">
                    {formatDate(event.created_at)}
                  </span>
                  {event.resolved_at && (
                    <span className="mono text-[11.5px] text-[var(--color-positive)]">
                      resolved {formatDate(event.resolved_at)}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-[14.5px] leading-relaxed">{event.summary}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {permission === "VIEW_ALERTS" ? (
        <Card>
          <CardHeader eyebrow="Measurements" title="Not shared with you" />
          <p className="px-6 py-5 text-[14px] leading-relaxed text-ink-soft">
            {name.split(" ")[0]} has chosen to share emergency alerts with you rather than their
            measurements. They can change that from their own account at any time.
          </p>
        </Card>
      ) : (
        <Card>
          <CardHeader
            eyebrow="Measurements"
            title="Most recent reading"
            action={
              latest ? (
                <span className="mono text-[12.5px] text-muted">
                  {formatDate(latest.recorded_at)}
                </span>
              ) : null
            }
          />
          {latest ? (
            <dl className="grid grid-cols-2 gap-x-8 gap-y-5 px-6 py-5 sm:grid-cols-3">
              <Reading label="Heart rate" value={latest.heart_rate} unit="BPM" />
              <Reading label="Blood oxygen" value={latest.spo2} unit="%" />
              <Reading label="Temperature" value={latest.temperature} unit="°C" precision={1} />
            </dl>
          ) : (
            <p className="px-6 py-5 text-[14px] text-muted">
              No readings on file. AVERIS never fills this in with placeholder values.
            </p>
          )}
        </Card>
      )}

      <p className="pb-2 text-[13px] leading-relaxed text-muted">
        AVERIS reports measurements and the thresholds they crossed. It does not diagnose, and
        only the treating clinician can close an emergency.
      </p>
    </div>
  );
}

function Reading({
  label,
  value,
  unit,
  precision = 0,
}: {
  label: string;
  value: number | null;
  unit: string;
  precision?: number;
}) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</dt>
      <dd className="mono mt-1.5 text-[22px] font-semibold leading-none">
        {value === null ? (
          <span className="text-muted">—</span>
        ) : (
          <>
            {value.toFixed(precision)}
            <span className="ml-1 text-[12px] font-normal text-muted">{unit}</span>
          </>
        )}
      </dd>
    </div>
  );
}

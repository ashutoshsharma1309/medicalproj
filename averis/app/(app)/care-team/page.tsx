import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, Chip } from "@/components/ui";
import { formatDate } from "@/lib/utils/format";
import { listMyCaregivers, listMyDoctors } from "@/lib/care/access-service";
import { PERMISSION_DESCRIPTION } from "@/lib/care/caregiver-service";
import { AddDoctor } from "./AddDoctor";
import { AddCaregiver } from "./AddCaregiver";
import { revokeCaregiverAction, revokeDoctorAction } from "./actions";

export const metadata = { title: "Your care team" };
export const dynamic = "force-dynamic";

/**
 * Who can see my health data.
 *
 * The page the whole Phase 4 access model rests on: every "care team reads
 * assigned patient" policy in the schema is inert until a patient grants
 * something here, and access arranged through a support request is not
 * consent.
 *
 * Revoked entries stay visible rather than disappearing. A patient asking
 * "who could see my data in March?" is asking a question about the past, and a
 * list that only shows the present cannot answer it.
 */
export default async function CareTeamPage() {
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const supabase = await createClient();
  const [doctors, caregivers] = await Promise.all([
    listMyDoctors(supabase, account.patientProfileId),
    listMyCaregivers(supabase, account.patientProfileId),
  ]);

  const activeDoctors = doctors.filter((d) => d.status === "ACTIVE");
  const activeCaregivers = caregivers.filter((c) => c.status === "ACTIVE");

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">Your data</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">Your care team</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          {activeDoctors.length + activeCaregivers.length === 0
            ? "Nobody can see your health data. AVERIS is monitoring you, but there is currently no one it can notify."
            : `${activeDoctors.length} ${
                activeDoctors.length === 1 ? "clinician" : "clinicians"
              } and ${activeCaregivers.length} ${
                activeCaregivers.length === 1 ? "caregiver" : "caregivers"
              } can see your monitoring data. You can withdraw access at any time.`}
        </p>
      </header>

      <Card>
        <CardHeader
          eyebrow="Clinicians"
          title="Doctors who can see your data"
          action={
            <span className="mono text-[12.5px] text-muted">
              {activeDoctors.length} active
            </span>
          }
        />
        {doctors.length > 0 && (
          <ul className="divide-y divide-rule border-b border-rule">
            {doctors.map((doctor) => (
              <li key={doctor.assignmentId} className="px-6 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                  <div>
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-[15px] font-medium">{doctor.fullName}</span>
                      {doctor.status !== "ACTIVE" && (
                        <Chip>{doctor.status.toLowerCase()}</Chip>
                      )}
                    </div>
                    <p className="mono mt-0.5 text-[12.5px] text-muted">
                      {[doctor.specialization, doctor.hospitalName].filter(Boolean).join(" · ")}
                    </p>
                    <p className="mono mt-0.5 text-[11.5px] text-muted">
                      {doctor.status === "REVOKED" && doctor.revokedAt
                        ? `access withdrawn ${formatDate(doctor.revokedAt)}`
                        : `since ${formatDate(doctor.assignedAt)}`}
                    </p>
                  </div>

                  {doctor.status === "ACTIVE" && (
                    <form action={revokeDoctorAction}>
                      <input type="hidden" name="assignmentId" value={doctor.assignmentId} />
                      <button
                        type="submit"
                        className="mono text-[12px] text-[var(--color-critical)] underline-offset-2 hover:underline"
                      >
                        Withdraw access
                      </button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <AddDoctor />
      </Card>

      <Card>
        <CardHeader
          eyebrow="Family and carers"
          title="People who are notified in an emergency"
          action={
            <span className="mono text-[12.5px] text-muted">
              {activeCaregivers.length} active
            </span>
          }
        />
        {caregivers.length > 0 && (
          <ul className="divide-y divide-rule border-b border-rule">
            {caregivers.map((caregiver) => (
              <li key={caregiver.assignmentId} className="px-6 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                  <div>
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-[15px] font-medium">
                        {caregiver.fullName ?? caregiver.email ?? "Caregiver"}
                      </span>
                      {caregiver.relationship && (
                        <span className="mono text-[12px] text-muted">
                          {caregiver.relationship}
                        </span>
                      )}
                      {caregiver.status !== "ACTIVE" && (
                        <Chip>{caregiver.status.toLowerCase()}</Chip>
                      )}
                    </div>
                    <p className="mono mt-0.5 text-[12.5px] text-muted">
                      {PERMISSION_DESCRIPTION[caregiver.permission]}
                    </p>
                    <p className="mono mt-0.5 text-[11.5px] text-muted">
                      {caregiver.status === "REVOKED" && caregiver.revokedAt
                        ? `access withdrawn ${formatDate(caregiver.revokedAt)}`
                        : `since ${formatDate(caregiver.assignedAt)}`}
                    </p>
                  </div>

                  {caregiver.status === "ACTIVE" && (
                    <form action={revokeCaregiverAction}>
                      <input type="hidden" name="assignmentId" value={caregiver.assignmentId} />
                      <button
                        type="submit"
                        className="mono text-[12px] text-[var(--color-critical)] underline-offset-2 hover:underline"
                      >
                        Withdraw access
                      </button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <AddCaregiver />
      </Card>

      <p className="pb-2 text-[13px] leading-relaxed text-muted">
        Withdrawing access takes effect immediately and is recorded. Entries you have withdrawn
        stay on this page so you can always see who had access and when — nobody on this list can
        read your uploaded documents or the questions you ask AVERIS.
      </p>
    </div>
  );
}

import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { ProfileForm, type ProfilePrefill } from "./ProfileForm";

export const metadata = { title: "My Profile" };
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const user = await getSession();
  const patient = await db.patient.findFirst({
    where: { userId: user!.id },
    include: {
      conditions: { where: { status: { not: "RESOLVED" } } },
      allergies: true,
      medications: { where: { status: "ACTIVE" } },
    },
  });

  const firstTime = !patient || !patient.profileCompleted;

  const prefill: ProfilePrefill = {
    fullName: patient ? `${patient.firstName} ${patient.lastName}`.trim() : (user!.name ?? ""),
    dateOfBirth: patient ? patient.dateOfBirth.toISOString().slice(0, 10) : "",
    gender: patient?.sex ?? "",
    phone: patient?.phone ?? "",
    bloodGroup: patient?.bloodType ?? "",
    emergencyContactName: patient?.emergencyContactName ?? "",
    emergencyContactPhone: patient?.emergencyContactPhone ?? "",
    surgeries: patient?.surgeries ?? "",
    diseases: patient?.conditions.map((c) => c.name) ?? [],
    allergies: patient?.allergies.map((a) => a.substance) ?? [],
    medications:
      patient?.medications.map((m) =>
        m.dose && m.dose !== "as directed" ? `${m.name} ${m.dose}` : m.name,
      ) ?? [],
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <div className="eyebrow">{firstTime ? "Welcome to Meridian" : "Personal health record"}</div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">
          {firstTime ? "Set up your medical profile" : "My profile"}
        </h1>
        <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted">
          {firstTime
            ? "This is the record your care team sees first, so accuracy matters. Fill in what you know — you can also upload medical documents afterwards and Meridian will read them for you."
            : "Update your details below. Information added by your care team is never removed by edits here."}
        </p>
      </header>

      <ProfileForm prefill={prefill} firstTime={firstTime} />
    </div>
  );
}

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, Chip, DataPoint, Callout, ButtonLink } from "@/components/ui";
import { HealthIdentityCard } from "@/components/health/HealthIdentityCard";
import { averisId, calculateAge, formatDate, firstNameOf } from "@/lib/utils/format";
import { bloodGroupLabel, genderLabel } from "@/lib/utils/constants";
import { documentTypeLabel, STATUS_PRESENTATION } from "@/lib/services/documents/labels";

export const metadata = { title: "Health dashboard" };

/** Modules with structure in place, deliberately not simulated. */
const FUTURE_MODULES = [
  {
    title: "Medical Records",
    body: "Upload prescriptions, lab reports and discharge summaries. AVERIS will read them and propose profile updates for your approval.",
  },
  {
    title: "Health Timeline",
    body: "Your conditions, treatments and results arranged over time, so changes in your health are visible at a glance.",
  },
  {
    title: "Health Insights",
    body: "Risk signals explained in plain language, always showing which parts of your record produced them.",
  },
];

export default async function DashboardPage() {
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const supabase = await createClient();

  const { data: profile } = await supabase
    .from("patient_profiles")
    .select("id, date_of_birth, gender, phone_number, blood_group, emergency_contact, created_at")
    .eq("id", account.patientProfileId)
    .single();

  const { data: health } = await supabase
    .from("patient_health_information")
    .select("allergies, existing_conditions, current_medications, medical_notes")
    .eq("patient_id", account.patientProfileId)
    .maybeSingle();

  const { data: documentRows } = await supabase
    .from("medical_documents")
    .select("id, file_name, document_type, upload_status")
    .eq("patient_id", account.patientProfileId)
    .order("uploaded_at", { ascending: false })
    .limit(5);
  const documents = documentRows ?? [];

  if (!profile) redirect("/onboarding");

  const allergies = health?.allergies ?? [];
  const conditions = health?.existing_conditions ?? [];
  const medications = health?.current_medications ?? [];
  const displayName = account.fullName ?? account.email;

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">Health dashboard</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">
          Welcome back, {firstNameOf(account.fullName)}
        </h1>
      </header>

      {/* Allergies are the single most consequential fact in the record. */}
      {allergies.length > 0 && (
        <Callout tone="critical" title="Allergies on your record">
          {allergies.join(" · ")} — mention these to any clinician or pharmacist treating you.
        </Callout>
      )}

      <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_420px]">
        {/* ------------------------------------------------ Health profile */}
        <Card className="order-2 lg:order-1">
          <CardHeader
            eyebrow="Section 1"
            title="Health profile"
            action={
              <Link
                href="/onboarding"
                className="text-[13.5px] font-medium text-brand hover:underline"
              >
                Update
              </Link>
            }
          />
          <dl className="grid grid-cols-2 gap-x-8 gap-y-6 px-6 py-6 sm:grid-cols-3">
            <DataPoint label="Full name" value={displayName} />
            <DataPoint label="Age" value={`${calculateAge(profile.date_of_birth)} years`} mono />
            <DataPoint label="Blood group" value={bloodGroupLabel(profile.blood_group)} mono />
            <DataPoint label="Date of birth" value={formatDate(profile.date_of_birth)} mono />
            <DataPoint label="Gender" value={genderLabel(profile.gender)} />
            <DataPoint label="Phone" value={profile.phone_number} mono />
            <DataPoint label="Email" value={account.email} />
            <DataPoint
              label="Emergency contact"
              value={profile.emergency_contact ?? "Not provided"}
            />
            <DataPoint label="AVERIS ID" value={averisId(profile.id)} mono />
          </dl>
        </Card>

        {/* ---------------------------------------------- Health identity */}
        <div className="order-1 flex justify-center lg:order-2 lg:justify-end">
          <HealthIdentityCard
            identity={{
              fullName: displayName,
              averisId: averisId(profile.id),
              bloodGroup: bloodGroupLabel(profile.blood_group),
              dateOfBirth: formatDate(profile.date_of_birth),
              age: calculateAge(profile.date_of_birth),
              issuedOn: new Date(profile.created_at).getFullYear().toString(),
              allergyCount: allergies.length,
            }}
          />
        </div>
      </div>

      {/* ---------------------------------------------------- Medical history */}
      <Card>
        <CardHeader eyebrow="Section 2" title="Medical history" />
        <div className="grid gap-8 px-6 py-6 md:grid-cols-3">
          <HistoryList
            label="Allergies"
            items={allergies}
            tone="critical"
            empty="None recorded"
          />
          <HistoryList
            label="Existing conditions"
            items={conditions}
            tone="brand"
            empty="None recorded"
          />
          <HistoryList
            label="Current medications"
            items={medications}
            tone="default"
            empty="None recorded"
          />
        </div>
        {health?.medical_notes && (
          <div className="border-t border-rule px-6 py-5">
            <p className="eyebrow mb-1.5">Additional notes</p>
            <p className="max-w-3xl whitespace-pre-line text-[14.5px] leading-relaxed text-ink-soft">
              {health.medical_notes}
            </p>
          </div>
        )}
      </Card>

      {/* --------------------------------------------------------- Documents */}
      <Card>
        <CardHeader
          eyebrow="Section 3"
          title="Documents"
          action={
            <Link href="/records" className="text-[13.5px] font-medium text-brand hover:underline">
              Medical Records Center
            </Link>
          }
        />
        {documents.length === 0 ? (
          <div className="px-6 py-8 text-center">
            <p className="text-[15px] font-medium">No documents yet</p>
            <p className="mx-auto mt-1.5 max-w-md text-[14px] leading-relaxed text-ink-soft">
              Upload a report or prescription and AVERIS will read it, then show you what it
              found before anything is added to your profile.
            </p>
            <div className="mt-5">
              <ButtonLink href="/records">Upload a document</ButtonLink>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-rule">
            {documents.map((doc) => {
              const status = STATUS_PRESENTATION[doc.upload_status];
              return (
                <li key={doc.id} className="flex items-center gap-4 px-6 py-3.5">
                  <Link
                    href={`/records/${doc.id}`}
                    className="min-w-0 flex-1 truncate text-[14px] font-medium hover:text-brand"
                  >
                    {doc.file_name}
                  </Link>
                  <span className="hidden text-[12.5px] text-muted sm:block">
                    {documentTypeLabel(doc.document_type)}
                  </span>
                  <Chip tone={status.tone}>{status.label}</Chip>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ---------------------------------------------------- Health summary */}
      <Card>
        <CardHeader eyebrow="Section 4" title="Health summary" />
        <div className="grid gap-px bg-rule md:grid-cols-3">
          {FUTURE_MODULES.map((m) => (
            <div key={m.title} className="bg-surface px-6 py-5">
              <Chip>Coming soon</Chip>
              <h3 className="mt-3 text-[15.5px] font-semibold">{m.title}</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-ink-soft">{m.body}</p>
            </div>
          ))}
        </div>
        <div className="border-t border-rule px-6 py-4">
          <p className="text-[13px] leading-relaxed text-muted">
            AVERIS shows only information you provided. These modules are in development — no
            analysis or prediction is being generated from your record yet.
          </p>
        </div>
      </Card>

      <div className="flex justify-center pb-4">
        <ButtonLink href="/onboarding" variant="secondary">
          Update my health profile
        </ButtonLink>
      </div>
    </div>
  );
}

function HistoryList({
  label,
  items,
  tone,
  empty,
}: {
  label: string;
  items: string[];
  tone: "default" | "brand" | "critical";
  empty: string;
}) {
  return (
    <div>
      <p className="eyebrow mb-2.5">{label}</p>
      {items.length === 0 ? (
        <p className="text-[14px] text-muted">{empty}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li key={item}>
              <Chip tone={tone}>{item}</Chip>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

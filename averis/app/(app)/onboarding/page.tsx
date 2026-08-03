import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { OnboardingWizard } from "./OnboardingWizard";

export const metadata = { title: "Complete your profile" };

export default async function OnboardingPage() {
  const account = await requireUser();

  // Already onboarded — the dashboard is the right destination.
  if (account.patientProfileId) redirect("/dashboard");

  return (
    <>
      <header className="mx-auto mb-8 max-w-2xl">
        <p className="eyebrow">Welcome to AVERIS</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">
          Let&rsquo;s build your health profile
        </h1>
        <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-ink-soft">
          Three short steps. This becomes the record your clinicians see first, so accuracy
          matters more than completeness.
        </p>
      </header>

      <OnboardingWizard defaultFullName={account.fullName ?? ""} />
    </>
  );
}

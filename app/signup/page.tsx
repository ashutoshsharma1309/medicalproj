import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { SignupForm } from "./SignupForm";

export const metadata = { title: "Create your account" };

export default async function SignupPage() {
  const user = await getSession();
  if (user) redirect("/");

  return (
    <div className="flex min-h-screen">
      <div className="hidden w-[42%] flex-col justify-between bg-rail p-12 lg:flex">
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 28 28" className="h-9 w-9" aria-hidden>
            <circle cx="14" cy="14" r="12.5" fill="none" stroke="var(--color-scrub-mid)" strokeWidth="1.4" />
            <path d="M14 1.5v25" stroke="var(--color-rail-bright)" strokeWidth="1.4" />
            <path d="M2 14c4-4.5 20-4.5 24 0" fill="none" stroke="var(--color-rail-bright)" strokeWidth="1.4" />
          </svg>
          <div>
            <div className="text-lg font-semibold text-rail-bright">Meridian</div>
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-rail-text">
              Patient Portal
            </div>
          </div>
        </div>

        <div>
          <h1
            className="text-[34px] leading-snug text-rail-bright"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Your health record,
            <br />
            finally in one place.
          </h1>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-rail-text">
            Create your account, build your medical profile, and upload reports or
            prescriptions — Meridian reads them and keeps your record organized, so every
            clinician who treats you starts fully informed.
          </p>
          <ul className="mt-6 space-y-2.5 text-sm text-rail-text">
            {[
              "Your documents stay private to you and your care team",
              "Anything extracted by AI is shown to you for approval first",
              "Your allergies travel with your record — visibly",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2.5">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-scrub-mid" />
                {t}
              </li>
            ))}
          </ul>
        </div>

        <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-rail-text">
          Encrypted in transit · Every access is audit-logged
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center bg-paper p-8">
        <div className="w-full max-w-sm">
          <h2 className="text-xl font-semibold">Create your patient account</h2>
          <p className="mt-1 text-[13px] text-muted">
            Already registered?{" "}
            <Link href="/login" className="font-medium text-scrub hover:underline">
              Sign in
            </Link>
          </p>
          <SignupForm />
        </div>
      </div>
    </div>
  );
}

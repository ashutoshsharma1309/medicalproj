import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  const user = await getSession();
  if (user) redirect("/");

  return (
    <div className="flex min-h-screen">
      {/* Left: identity panel */}
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
              Clinical Intelligence
            </div>
          </div>
        </div>

        <div>
          <h1
            className="text-[34px] leading-snug text-rail-bright"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Every patient&rsquo;s story,
            <br />
            assembled before you
            <br />
            open the door.
          </h1>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-rail-text">
            Meridian converts scattered records into structured patient intelligence —
            explainable risk analysis, medication safety and documentation support,
            reviewed and decided by clinicians.
          </p>
        </div>

        <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-rail-text">
          Decision support only · Not a diagnostic device · All AI output requires clinician review
        </div>
      </div>

      {/* Right: form */}
      <div className="flex flex-1 items-center justify-center bg-paper p-8">
        <LoginForm />
      </div>
    </div>
  );
}

import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { Wordmark } from "@/components/brand/Logo";
import { signOutAction } from "@/app/(auth)/actions";
import { initialsOf } from "@/lib/utils/format";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Authorization is re-checked here, not delegated to proxy.ts alone.
  const account = await requireUser();

  return (
    <div className="min-h-screen">
      <header className="border-b border-rule bg-surface">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
          <div className="flex items-center gap-8">
            <Wordmark href="/dashboard" />
            {/* Role-shaped, because AVERIS now has three kinds of user and
                the same eight links serve none of them. A clinician has no
                patient profile of their own, and gating the whole nav on one
                left the clinical dashboard reachable only by typing the URL.
                These are links, not permissions — RLS decides what each page
                returns. */}
            <nav className="hidden items-center gap-6 text-[14px] text-ink-soft sm:flex">
              {account.isClinician && (
                <Link href="/clinical" className="hover:text-brand">
                  Clinical
                </Link>
              )}
              {account.isCaregiver && (
                <Link href="/care" className="hover:text-brand">
                  People you care for
                </Link>
              )}
              {account.patientProfileId && (
                <>
                  <Link href="/dashboard" className="hover:text-brand">
                    Dashboard
                  </Link>
                  <Link href="/twin" className="hover:text-brand">
                    Health Twin
                  </Link>
                  <Link href="/twin/vitals" className="hover:text-brand">
                    My normal
                  </Link>
                  <Link href="/monitoring" className="hover:text-brand">
                    Monitoring
                  </Link>
                  <Link href="/devices" className="hover:text-brand">
                    Devices
                  </Link>
                  <Link href="/care-team" className="hover:text-brand">
                    Care team
                  </Link>
                  <Link href="/risk" className="hover:text-brand">
                    Risk Intelligence
                  </Link>
                  <Link href="/intelligence" className="hover:text-brand">
                    Ask AVERIS
                  </Link>
                  <Link href="/records" className="hover:text-brand">
                    Medical records
                  </Link>
                  {/* Only when explicitly enabled. A guided tour is a page
                      whose purpose is to make the system easy to drive, which
                      is not a property a deployment serving real patients
                      wants reachable. */}
                  {process.env.NEXT_PUBLIC_DEMO_MODE === "true" && (
                    <Link href="/demo" className="hover:text-brand">
                      Demo
                    </Link>
                  )}
                </>
              )}
            </nav>
          </div>

          <div className="flex items-center gap-4">
            <div className="hidden text-right sm:block">
              <p className="text-[13.5px] font-medium leading-tight">
                {account.fullName ?? account.email}
              </p>
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                {account.role.toLowerCase()}
              </p>
            </div>
            <span
              className="flex h-9 w-9 items-center justify-center rounded-full bg-wash text-[12.5px] font-semibold text-brand-deep"
              aria-hidden="true"
            >
              {initialsOf(account.fullName ?? account.email)}
            </span>
            <Link
              href="/activity"
              className="hidden text-[13.5px] text-ink-soft hover:text-brand sm:block"
            >
              Activity
            </Link>
            <form action={signOutAction}>
              <button type="submit" className="btn btn-ghost">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-5xl px-6 py-9">
        {children}
      </main>
    </div>
  );
}

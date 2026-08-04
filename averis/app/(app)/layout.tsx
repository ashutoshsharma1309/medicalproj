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
            {account.patientProfileId && (
              <nav className="hidden items-center gap-6 text-[14px] text-ink-soft sm:flex">
                <Link href="/dashboard" className="hover:text-brand">
                  Dashboard
                </Link>
                <Link href="/twin" className="hover:text-brand">
                  Health Twin
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
              </nav>
            )}
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

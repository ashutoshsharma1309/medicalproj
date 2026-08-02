import type { ReactNode } from "react";
import Link from "next/link";
import type { SessionUser } from "@/lib/auth";
import { NavLink } from "./NavLink";
import { LogoutButton } from "./LogoutButton";
import {
  IconGrid,
  IconUsers,
  IconPulse,
  IconNote,
  IconBook,
  IconDoc,
  IconGauge,
  IconAudit,
  IconHeart,
} from "./icons";

function Wordmark() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-3">
      {/* meridian mark: a vertical line crossing a horizon arc */}
      <svg viewBox="0 0 28 28" className="h-7 w-7" aria-hidden>
        <circle cx="14" cy="14" r="12.5" fill="none" stroke="var(--color-scrub-mid)" strokeWidth="1.4" />
        <path d="M14 1.5v25" stroke="var(--color-rail-bright)" strokeWidth="1.4" />
        <path d="M2 14c4-4.5 20-4.5 24 0" fill="none" stroke="var(--color-rail-bright)" strokeWidth="1.4" />
      </svg>
      <div className="leading-tight">
        <div className="text-[15px] font-semibold tracking-tight text-rail-bright">Meridian</div>
        <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-rail-text">
          Clinical Intelligence
        </div>
      </div>
    </Link>
  );
}

const NAV: Record<string, { href: string; label: string; icon: ReactNode; exact?: boolean }[]> = {
  DOCTOR: [
    { href: "/dashboard", label: "Today", icon: <IconGrid /> },
    { href: "/patients", label: "Patients", icon: <IconUsers /> },
    { href: "/triage", label: "Emergency Triage", icon: <IconPulse /> },
    { href: "/intelligence", label: "Document Intelligence", icon: <IconDoc /> },
    { href: "/documentation", label: "Documentation", icon: <IconNote /> },
    { href: "/knowledge", label: "Knowledge", icon: <IconBook /> },
  ],
  ADMIN: [
    { href: "/admin", label: "Overview", icon: <IconGauge />, exact: true },
    { href: "/admin/users", label: "Users", icon: <IconUsers /> },
    { href: "/admin/audit", label: "Audit Trail", icon: <IconAudit /> },
  ],
  PATIENT: [
    { href: "/portal", label: "My Health", icon: <IconHeart />, exact: true },
    { href: "/portal/documents", label: "My Documents", icon: <IconDoc /> },
    { href: "/portal/setup", label: "My Profile", icon: <IconUsers /> },
  ],
};

export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }) {
  const nav = NAV[user.role] ?? [];
  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-20 flex w-60 flex-col bg-rail">
        <div className="border-b border-rail-line py-4">
          <Wordmark />
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
          {nav.map((item) => (
            <NavLink key={item.href} href={item.href} exact={item.exact}>
              {item.icon}
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-rail-line px-5 py-4">
          <div className="text-[13px] font-medium text-rail-bright">{user.name}</div>
          <div className="mt-0.5 text-[11px] text-rail-text">{user.title ?? user.role}</div>
          <div className="mt-2.5">
            <LogoutButton />
          </div>
        </div>
      </aside>
      <div className="ml-60 min-w-0 flex-1">
        <main className="mx-auto max-w-6xl px-8 py-7">{children}</main>
      </div>
    </div>
  );
}

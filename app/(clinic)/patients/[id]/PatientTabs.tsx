"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { slug: "", label: "Intelligence Profile" },
  { slug: "/timeline", label: "Medical Timeline" },
  { slug: "/reports", label: "Lab Reports" },
  { slug: "/notes", label: "Notes & Documents" },
];

export function PatientTabs({ patientId }: { patientId: string }) {
  const pathname = usePathname();
  const base = `/patients/${patientId}`;
  return (
    <nav className="flex gap-1 border-t border-hairline px-4">
      {TABS.map((t) => {
        const href = base + t.slug;
        const active = pathname === href;
        return (
          <Link
            key={t.slug}
            href={href}
            className={`relative px-4 py-2.5 text-[13px] font-medium transition-colors ${
              active ? "text-scrub" : "text-muted hover:text-ink"
            }`}
          >
            {t.label}
            {active && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-scrub" />}
          </Link>
        );
      })}
    </nav>
  );
}

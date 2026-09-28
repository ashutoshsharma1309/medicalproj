"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { IconHeart } from "@/components/shell/icons";
import { IconUser } from "./icons";

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 focus:outline-none">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cb-primary text-white">
        <IconHeart className="h-4 w-4" />
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-cb-ink">CareBridge</span>
    </Link>
  );
}

/** Decorative, non-authenticated placeholder — Phase 2 has no auth changes. */
function ProfileMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Profile"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        className="flex h-10 w-10 items-center justify-center rounded-full border border-cb-border-strong text-cb-muted transition-colors hover:border-cb-primary hover:text-cb-primary"
      >
        <IconUser />
      </button>
      {open && (
        <div
          role="menu"
          className="cb-card absolute right-0 top-12 z-30 w-56 p-3 text-[13px] text-cb-muted"
        >
          Guest session — sign-in and profile management arrive in a later phase.
        </div>
      )}
    </div>
  );
}

export function TopNav() {
  const pathname = usePathname();
  const onAssessment = pathname?.startsWith("/assessment") ?? false;

  return (
    <header className="sticky top-0 z-20 border-b border-cb-border bg-cb-surface/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
        <Logo />
        <Link
          href="/assessment"
          className={`hidden text-[13.5px] font-semibold sm:block ${
            onAssessment ? "text-cb-primary" : "text-cb-muted hover:text-cb-ink"
          }`}
        >
          Health Assessment
        </Link>
        <ProfileMenu />
      </div>
    </header>
  );
}

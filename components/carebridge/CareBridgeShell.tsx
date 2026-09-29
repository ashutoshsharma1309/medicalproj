import type { ReactNode } from "react";
import { TopNav } from "./TopNav";

/** The persistent CareBridge page frame: skip link + top nav + content well. */
export function CareBridgeShell({
  children,
  wide = false,
}: {
  children: ReactNode;
  /** Wider content well for the two-column interview layout. */
  wide?: boolean;
}) {
  return (
    <div className="cb-app flex min-h-screen flex-col">
      <a href="#cb-main" className="cb-skip-link">
        Skip to content
      </a>
      <TopNav />
      <main id="cb-main" className={`mx-auto w-full flex-1 px-4 py-8 sm:px-6 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>
        {children}
      </main>
    </div>
  );
}

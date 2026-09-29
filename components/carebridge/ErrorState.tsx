import type { ReactNode } from "react";
import { IconAlertTriangle } from "./icons";

/**
 * Generic failure placeholder — covers both a transient API error ("Something
 * went wrong") and a session-expired case, distinguished by `title`/`hint`.
 * Not triggered anywhere live yet in Phase 2 (there is no real API or session
 * to fail); it's a ready-made building block for Phase 3 to use once real
 * requests exist.
 */
export function ErrorState({
  title = "Something went wrong",
  hint = "Please try again in a moment.",
  action,
}: {
  title?: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="cb-card flex flex-col items-center gap-3 border-cb-danger-line px-6 py-14 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-cb-danger-wash text-cb-danger">
        <IconAlertTriangle className="h-5 w-5" />
      </span>
      <p className="text-[14.5px] font-semibold text-cb-ink">{title}</p>
      <p className="max-w-sm text-[13px] text-cb-muted">{hint}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

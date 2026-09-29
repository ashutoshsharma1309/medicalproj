import type { ReactNode } from "react";
import { IconInfo } from "./icons";

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="cb-card flex flex-col items-center gap-3 px-6 py-14 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-cb-primary-wash text-cb-primary">
        <IconInfo className="h-5 w-5" />
      </span>
      <p className="text-[14.5px] font-semibold text-cb-ink">{title}</p>
      {hint && <p className="max-w-sm text-[13px] text-cb-muted">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

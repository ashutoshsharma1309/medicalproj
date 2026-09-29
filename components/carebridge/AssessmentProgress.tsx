import { PROGRESS_FIELDS, PROGRESS_FIELD_LABELS, type ProgressState } from "@/lib/carebridge/types";
import { IconCheckCircle, IconCircle } from "./icons";

function ChecklistRow({ label, done }: { label: string; done: boolean }) {
  return (
    <li className="flex items-center gap-2.5 py-1.5 text-[13.5px]">
      {done ? (
        <IconCheckCircle className="h-[18px] w-[18px] text-cb-success" />
      ) : (
        <IconCircle className="h-[18px] w-[18px] text-cb-faint" />
      )}
      <span className={done ? "text-cb-ink" : "text-cb-muted"}>{label}</span>
      <span className="sr-only">{done ? "— collected" : "— not yet collected"}</span>
    </li>
  );
}

export function AssessmentProgress({
  progress,
  percent,
  compact = false,
}: {
  progress: ProgressState;
  percent: number;
  /** Compact bar-only rendering for narrow / mobile layouts. */
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="cb-card px-4 py-3">
        <div className="flex items-center justify-between text-[12.5px] font-semibold text-cb-muted">
          <span>Assessment progress</span>
          <span className="text-cb-primary">{percent}%</span>
        </div>
        <div className="cb-progress-track mt-2" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Assessment progress">
          <div className="cb-progress-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  }

  return (
    <div className="cb-card p-5">
      <h2 className="text-[13.5px] font-semibold text-cb-ink">Assessment progress</h2>
      <div
        className="cb-progress-track mt-3"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Assessment progress"
      >
        <div className="cb-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-2 text-[12.5px] text-cb-muted">{percent}% complete</p>

      <ul className="mt-4 divide-y divide-cb-border border-t border-cb-border">
        {PROGRESS_FIELDS.map((field) => (
          <ChecklistRow key={field} label={PROGRESS_FIELD_LABELS[field]} done={progress[field]} />
        ))}
      </ul>

      <p className="mt-4 text-[12px] leading-relaxed text-cb-faint">
        CareBridge collects this information step by step so nothing important gets missed before
        your consultation.
      </p>
    </div>
  );
}

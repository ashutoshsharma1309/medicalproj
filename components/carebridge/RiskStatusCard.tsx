import type { ResultStatus } from "@/lib/carebridge/types";
import { RESULT_STATUS_CONTENT } from "@/lib/carebridge/mock/assessment";
import { IconAlertTriangle, IconCheckCircle, IconInfo } from "./icons";

const STATUS_STYLE: Record<
  ResultStatus,
  { wash: string; line: string; text: string; Icon: typeof IconCheckCircle }
> = {
  routine: { wash: "bg-cb-success-wash", line: "border-cb-success-line", text: "text-cb-success", Icon: IconCheckCircle },
  consult_soon: { wash: "bg-cb-warning-wash", line: "border-cb-warning-line", text: "text-cb-warning", Icon: IconInfo },
  urgent: { wash: "bg-cb-danger-wash", line: "border-cb-danger-line", text: "text-cb-danger", Icon: IconAlertTriangle },
};

export function RiskStatusCard({ status }: { status: ResultStatus }) {
  const content = RESULT_STATUS_CONTENT[status];
  const style = STATUS_STYLE[status];

  return (
    <section
      className={`cb-card border-2 p-5 ${style.wash} ${style.line}`}
      aria-label={`Care guidance status: ${content.label}`}
    >
      <div className="flex items-start gap-3">
        <style.Icon className={`mt-0.5 h-6 w-6 ${style.text}`} />
        <div>
          <h2 className={`text-[16px] font-semibold ${style.text}`}>{content.label}</h2>
          <p className="mt-0.5 text-[13.5px] text-cb-ink">{content.description}</p>
        </div>
      </div>
      <p className="mt-4 border-t border-cb-border pt-4 text-[13.5px] leading-relaxed text-cb-ink">
        {content.guidance}
      </p>
    </section>
  );
}

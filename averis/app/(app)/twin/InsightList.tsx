import Link from "next/link";
import { Chip } from "@/components/ui";
import { formatDate } from "@/lib/utils/format";
import type { HealthInsight, InsightType } from "@/lib/services/twin/types";

/**
 * Health insights.
 *
 * Each observation shows the evidence it was computed from, so a patient can
 * always answer "where did AVERIS get this?" without leaving the page. Nothing
 * here is a clinical judgement — these describe the record, not the person.
 */

const TYPE_LABEL: Record<InsightType, string> = {
  TREND: "Trend",
  PATTERN: "Pattern",
  COMPLETENESS: "Record gap",
  REMINDER: "Reminder",
};

export function InsightList({ insights }: { insights: HealthInsight[] }) {
  if (insights.length === 0) {
    return (
      <div className="px-6 py-10 text-center">
        <p className="text-[15px] font-medium">No observations yet</p>
        <p className="mx-auto mt-1.5 max-w-md text-[14px] leading-relaxed text-ink-soft">
          Once you have a few documents on file, AVERIS will point out things like a test value
          moving over time, or a gap worth filling.{" "}
          <Link href="/records" className="font-medium text-brand hover:underline">
            Add a document
          </Link>
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-rule">
      {insights.map((insight, index) => (
        <li key={index} className="px-6 py-5">
          <div className="flex flex-wrap items-center gap-2.5">
            <Chip tone={insight.importanceLevel === "HIGH" ? "notice" : "default"}>
              {TYPE_LABEL[insight.insightType]}
            </Chip>
            {insight.confidenceScore != null && (
              <span className="mono text-[11.5px] text-muted">
                {Math.round(insight.confidenceScore * 100)}% confidence
              </span>
            )}
          </div>

          <p className="mt-2 max-w-3xl text-[14.5px] leading-relaxed">{insight.insightText}</p>

          {insight.evidence.length > 0 && (
            <details className="mt-2.5 group">
              <summary className="cursor-pointer text-[12.5px] font-medium text-brand hover:underline">
                Where this comes from ({insight.evidence.length})
              </summary>
              <ul className="mt-2 space-y-1.5 border-l border-rule pl-4">
                {insight.evidence.map((item, i) => (
                  <li key={i} className="text-[13px] text-ink-soft">
                    <span className="font-medium">{item.label}</span>
                    {item.value && <span className="mono ml-2">{item.value}</span>}
                    {item.date && (
                      <span className="mono ml-2 text-muted">{formatDate(item.date)}</span>
                    )}
                    {item.documentId && (
                      <Link
                        href={`/records/${item.documentId}`}
                        className="ml-2 text-[12.5px] text-brand hover:underline"
                      >
                        source →
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

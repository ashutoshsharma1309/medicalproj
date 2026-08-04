import Link from "next/link";
import type { AnswerSource } from "@/lib/rag/types";

/**
 * Sources behind an answer.
 *
 * This is the component that makes the rest of the feature defensible. An
 * explanation with no visible provenance asks a patient to trust a paragraph;
 * one that names the report it came from and links to it lets them check.
 *
 * Patient documents and reference material are visually distinct on purpose.
 * The difference between "this is from your blood report" and "this is from a
 * guideline about blood reports" is the difference between a fact about the
 * reader and a fact about the world, and collapsing the two is how a
 * reference range starts reading like a personal result.
 */
export function SourceList({ sources }: { sources: AnswerSource[] }) {
  if (sources.length === 0) return null;

  const own = sources.filter((s) => s.kind === "PATIENT_DOCUMENT");
  const reference = sources.filter((s) => s.kind === "MEDICAL_KNOWLEDGE");

  return (
    <div className="mt-4 border-t border-rule pt-3.5">
      <p className="eyebrow mb-2.5">Based on</p>

      <ul className="space-y-2">
        {own.map((source, i) => (
          <li key={`own-${i}`} className="flex items-start gap-2.5 text-[13.5px]">
            <span className="mt-[3px] shrink-0 text-brand" aria-hidden="true">
              ✓
            </span>
            <span>
              {source.href ? (
                <Link href={source.href} className="font-medium text-brand hover:underline">
                  {source.label}
                </Link>
              ) : (
                <span className="font-medium">{source.label}</span>
              )}
              <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                your record
              </span>
            </span>
          </li>
        ))}

        {reference.map((source, i) => (
          <li key={`ref-${i}`} className="flex items-start gap-2.5 text-[13.5px]">
            <span className="mt-[3px] shrink-0 text-muted" aria-hidden="true">
              ✓
            </span>
            <span>
              <span className="font-medium">{source.label}</span>
              <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                reference
              </span>
              {source.citation && (
                <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">
                  {source.citation}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

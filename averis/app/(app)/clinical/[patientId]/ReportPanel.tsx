"use client";

import { useFormStatus } from "react-dom";
import { generateReportAction } from "./actions";
import type { StoredReport } from "@/lib/care/report-service";

/**
 * Patient summaries.
 *
 * Past summaries are listed rather than replaced. A report is what a clinician
 * read at a moment in time, and a panel that only ever shows the newest one
 * quietly rewrites what the last reader saw.
 *
 * Each carries the name of what phrased it. "deterministic" means the model
 * was unavailable or its output was rejected by the guardrail, and a clinician
 * is entitled to know which of those they are reading — a summary whose
 * provenance is hidden is one they have to trust rather than assess.
 */
export function ReportPanel({
  patientId,
  reports,
}: {
  patientId: string;
  reports: StoredReport[];
}) {
  return (
    <div>
      <form action={generateReportAction} className="flex flex-wrap items-end gap-3 px-6 py-5">
        <input type="hidden" name="patientId" value={patientId} />

        <div>
          <label
            htmlFor="windowHours"
            className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted"
          >
            Window
          </label>
          <select id="windowHours" name="windowHours" defaultValue="24" className="field-input">
            <option value="6">Last 6 hours</option>
            <option value="24">Last 24 hours</option>
            <option value="72">Last 3 days</option>
          </select>
        </div>

        <GenerateButton />

        <p className="w-full text-[12.5px] leading-relaxed text-muted sm:w-auto sm:flex-1">
          Assembled from stored readings. AVERIS computes the numbers; the language model only
          phrases them, and cannot add a value or a direction that is not in the data.
        </p>
      </form>

      {reports.length === 0 ? (
        <p className="border-t border-rule px-6 py-5 text-[14px] text-muted">
          No summaries generated yet.
        </p>
      ) : (
        <ul className="divide-y divide-rule border-t border-rule">
          {reports.map((report) => (
            <li key={report.id} className="px-6 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="mono text-[12px] text-muted">
                  {new Date(report.periodStart).toLocaleString()} →{" "}
                  {new Date(report.periodEnd).toLocaleString()}
                </span>
                <span className="mono text-[11px] text-muted">
                  {report.generatedWith === "deterministic"
                    ? "assembled directly from the data"
                    : `phrased by ${report.generatedWith}`}
                </span>
              </div>
              <p className="mt-2 max-w-3xl text-[14.5px] leading-relaxed">{report.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GenerateButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Generating…" : "Generate summary"}
    </button>
  );
}

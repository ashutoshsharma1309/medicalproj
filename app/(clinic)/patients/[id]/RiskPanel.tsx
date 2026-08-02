"use client";

import { useState } from "react";
import { FactorBars, SeverityChip } from "@/components/ui";
import type { RiskResult } from "@/lib/clinical/risk";

export function RiskPanel({
  patientId,
  initial,
}: {
  patientId: string;
  initial: RiskResult[];
}) {
  const [results, setResults] = useState<RiskResult[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/risk/assess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Assessment failed.");
      return;
    }
    setResults(data.results);
  }

  return (
    <section className="card">
      <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
        <div>
          <div className="eyebrow mb-0.5">Decision support</div>
          <h2 className="text-[15px] font-semibold">Risk analysis</h2>
        </div>
        <button className="btn btn-primary text-xs" onClick={run} disabled={busy}>
          {busy ? "Analyzing…" : results.length > 0 ? "Re-run analysis" : "Run risk analysis"}
        </button>
      </header>

      {error && (
        <p className="mx-5 mb-3 rounded-md border border-critical-line bg-critical-wash px-3 py-2 text-[13px] text-critical">
          {error}
        </p>
      )}

      {results.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-muted">
          No assessment on file. Run the analysis to score cardiovascular and metabolic risk from
          the structured record.
        </div>
      ) : (
        <div className="grid gap-px divide-hairline border-t border-hairline bg-hairline md:grid-cols-2">
          {results.map((r) => (
            <article key={r.domain} className="bg-surface p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-[13px] font-semibold capitalize">{r.domain} risk</h3>
                <SeverityChip level={r.band} />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="mono-data text-[34px] font-semibold leading-none">{r.score}</span>
                <span className="text-xs text-faint">/ 100</span>
              </div>

              <div className="eyebrow mt-5 mb-2">Why — contributing factors</div>
              <FactorBars factors={r.factors} />

              {r.narrative && (
                <>
                  <div className="eyebrow mt-5 mb-1.5">Interpretation</div>
                  <p className="text-[13px] leading-relaxed text-muted">{r.narrative}</p>
                </>
              )}

              {r.recommendations.length > 0 && (
                <>
                  <div className="eyebrow mt-5 mb-1.5">Recommended next steps</div>
                  <ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">
                    {r.recommendations.map((rec) => (
                      <li key={rec}>{rec}</li>
                    ))}
                  </ul>
                </>
              )}

              <div className="mt-4 border-t border-hairline pt-2 font-mono text-[10px] uppercase tracking-wider text-faint">
                Engine: {r.engine} · Decision support — clinician review required
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

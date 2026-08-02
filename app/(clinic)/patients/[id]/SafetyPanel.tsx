"use client";

import { useState } from "react";
import { SeverityChip } from "@/components/ui";
import type { SafetyAlert } from "@/lib/clinical/interactions";

export function SafetyPanel({
  patientId,
  initial,
}: {
  patientId: string;
  initial: SafetyAlert[];
}) {
  const [alerts, setAlerts] = useState<SafetyAlert[]>(initial);
  const [proposed, setProposed] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkedDrug, setCheckedDrug] = useState<string | null>(null);

  async function check(drug?: string) {
    setBusy(true);
    const res = await fetch("/api/medications/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId, proposedDrug: drug || undefined }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok) {
      setAlerts(data.alerts);
      setCheckedDrug(drug ?? null);
    }
  }

  const kindLabel = { interaction: "Drug interaction", allergy: "Allergy conflict", duplication: "Duplication" };

  return (
    <section className="card">
      <header className="px-5 pt-4 pb-3">
        <div className="eyebrow mb-0.5">Medication safety engine</div>
        <h2 className="text-[15px] font-semibold">Active safety alerts</h2>
      </header>

      {alerts.length === 0 ? (
        <div className="mx-5 mb-4 rounded-md border border-ok-line bg-ok-wash px-4 py-3 text-[13px] text-ok">
          No conflicts detected across the current regimen{checkedDrug ? ` including proposed ${checkedDrug}` : ""}.
        </div>
      ) : (
        <ul className="space-y-3 px-5 pb-4">
          {alerts.map((a, i) => (
            <li
              key={i}
              className={`rounded-md border px-4 py-3 ${
                a.level === "CRITICAL" || a.level === "HIGH"
                  ? "border-critical-line bg-critical-wash"
                  : "border-warn-line bg-warn-wash"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <SeverityChip level={a.level} />
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                  {kindLabel[a.kind]}
                </span>
              </div>
              <div className="mt-1.5 text-[13.5px] font-semibold">{a.title}</div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{a.detail}</p>
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-hairline px-5 py-4">
        <div className="eyebrow mb-2">Check a proposed medication against this regimen</div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (proposed.trim()) check(proposed.trim());
          }}
        >
          <input
            className="field"
            placeholder="e.g. ibuprofen, clarithromycin, spironolactone…"
            value={proposed}
            onChange={(e) => setProposed(e.target.value)}
            aria-label="Proposed medication"
          />
          <button className="btn btn-secondary" disabled={busy || !proposed.trim()}>
            {busy ? "Checking…" : "Check safety"}
          </button>
        </form>
        {checkedDrug && (
          <p className="mt-2 text-xs text-muted">
            Showing regimen alerts including proposed <strong>{checkedDrug}</strong>.{" "}
            <button className="underline hover:text-ink" onClick={() => check()}>
              Reset to current regimen
            </button>
          </p>
        )}
      </div>
    </section>
  );
}

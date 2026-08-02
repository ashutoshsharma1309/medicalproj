"use client";

import { useRef, useState } from "react";
import { Chip, SectionCard } from "@/components/ui";
import type { Extraction } from "@/lib/ai/extraction";

const SAMPLE = `LABORATORY REPORT — Riverside Community Hospital
Patient: Eleanor Vance    DOB: 03/14/1958    Collected: this week

Chemistry / Endocrine
HbA1c: 8.5 %          (ref 4.0 - 5.6)
Glucose: 182 mg/dL    (ref 70 - 99)
Creatinine: 1.0 mg/dL (ref 0.7 - 1.3)
eGFR: 88 mL/min

Lipids
LDL: 92 mg/dL
HDL: 48 mg/dL

History: type 2 diabetes, hypertension. Reports fatigue and polyuria.
Allergies: Penicillin

Current medications:
- Metformin 1000 mg twice daily
- Lisinopril 20 mg once daily
- Atorvastatin 40 mg at night`;

export function ExtractPanel({ patients }: { patients: { id: string; label: string }[] }) {
  const [text, setText] = useState("");
  const [filename, setFilename] = useState("pasted-document.txt");
  const [patientId, setPatientId] = useState<string>("");
  const [result, setResult] = useState<{ extraction: Extraction; engine: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(f: File) {
    setFilename(f.name);
    setText(await f.text());
  }

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    const res = await fetch("/api/documents/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, filename, patientId: patientId || undefined }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Extraction failed.");
      return;
    }
    setResult(data);
  }

  const ex = result?.extraction;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <SectionCard eyebrow="Input" title="Medical document">
        <div className="space-y-3 px-5 pb-5">
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary text-xs" onClick={() => fileRef.current?.click()}>
              Upload .txt file
            </button>
            <button
              type="button"
              className="btn btn-ghost text-xs"
              onClick={() => {
                setText(SAMPLE);
                setFilename("sample-lab-report.txt");
              }}
            >
              Use sample lab report
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.csv,text/plain"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            />
          </div>
          <textarea
            className="field min-h-80 font-mono text-xs leading-relaxed"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the document text here…"
            aria-label="Document text"
          />
          <div>
            <label className="label" htmlFor="ex-patient">File to patient record (optional)</label>
            <select
              id="ex-patient"
              className="field"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
            >
              <option value="">Analyze only — do not file</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <p className="rounded-md border border-critical-line bg-critical-wash px-3 py-2 text-[13px] text-critical">
              {error}
            </p>
          )}
          <button className="btn btn-primary w-full justify-center" onClick={run} disabled={busy || text.trim().length < 20}>
            {busy ? "Extracting intelligence…" : "Extract patient intelligence"}
          </button>
        </div>
      </SectionCard>

      <SectionCard eyebrow="Output" title="Structured intelligence profile">
        {!ex ? (
          <div className="px-5 py-16 text-center text-sm text-muted">
            The structured profile appears here: conditions, medications, allergies, abnormal
            values and risk factors.
          </div>
        ) : (
          <div className="space-y-4 px-5 pb-5">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="medium">{ex.documentType.replace(/_/g, " ")}</Chip>
              {ex.patientName && <Chip tone="neutral">Patient: {ex.patientName}</Chip>}
              <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-faint">
                {result!.engine}
              </span>
            </div>

            <p className="rounded-md border border-info-line bg-info-wash px-4 py-3 text-[13px] leading-relaxed">
              {ex.summary}
            </p>

            {ex.keyFindings.length > 0 && (
              <div className="rounded-md border border-warn-line bg-warn-wash px-4 py-3">
                <div className="eyebrow mb-1">Key findings</div>
                <ul className="list-disc space-y-0.5 pl-4 text-[13px]">
                  {ex.keyFindings.map((k) => (
                    <li key={k}>{k}</li>
                  ))}
                </ul>
              </div>
            )}

            {ex.labValues.length > 0 && (
              <div>
                <div className="eyebrow mb-1.5">Lab values</div>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Analyte</th>
                      <th>Result</th>
                      <th>Reference</th>
                      <th>Flag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ex.labValues.map((v) => (
                      <tr key={v.analyte}>
                        <td className="font-medium">{v.analyte}</td>
                        <td className="mono-data">
                          {v.value} <span className="text-xs text-faint">{v.unit}</span>
                        </td>
                        <td className="mono-data text-xs text-muted">
                          {v.refLow != null && v.refHigh != null ? `${v.refLow} – ${v.refHigh}` : "—"}
                        </td>
                        <td>
                          {v.flag ? (
                            <Chip tone={v.flag === "H" ? "critical" : "medium"}>
                              {v.flag === "H" ? "High" : "Low"}
                            </Chip>
                          ) : (
                            <span className="text-xs text-ok">Normal</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              {ex.conditions.length > 0 && (
                <div>
                  <div className="eyebrow mb-1.5">Conditions</div>
                  <div className="flex flex-wrap gap-1.5">
                    {ex.conditions.map((c) => (
                      <Chip key={c} tone="medium">{c}</Chip>
                    ))}
                  </div>
                </div>
              )}
              {ex.symptoms.length > 0 && (
                <div>
                  <div className="eyebrow mb-1.5">Symptoms</div>
                  <div className="flex flex-wrap gap-1.5">
                    {ex.symptoms.map((sym) => (
                      <Chip key={sym} tone="neutral">{sym}</Chip>
                    ))}
                  </div>
                </div>
              )}
              {ex.allergies.length > 0 && (
                <div>
                  <div className="eyebrow mb-1.5">Allergies</div>
                  <div className="flex flex-wrap gap-1.5">
                    {ex.allergies.map((a) => (
                      <Chip key={a} tone="critical">{a}</Chip>
                    ))}
                  </div>
                </div>
              )}
              {ex.riskFactors.length > 0 && (
                <div>
                  <div className="eyebrow mb-1.5">Risk factors</div>
                  <div className="flex flex-wrap gap-1.5">
                    {ex.riskFactors.map((r) => (
                      <Chip key={r} tone="high">{r}</Chip>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {ex.medications.length > 0 && (
              <div>
                <div className="eyebrow mb-1.5">Medications</div>
                <ul className="space-y-1 text-[13px]">
                  {ex.medications.map((m) => (
                    <li key={m.name} className="flex gap-2">
                      <span className="font-medium">{m.name}</span>
                      <span className="text-muted">
                        {m.dose ?? ""} {m.frequency ?? ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result!.engine.startsWith("deterministic") && (
              <p className="border-t border-hairline pt-3 text-xs text-faint">
                Extracted by the rule-based parser. Configure an Anthropic API key to enable
                LLM extraction for free-form narrative documents.
              </p>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

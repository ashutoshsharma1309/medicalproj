"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SectionCard } from "@/components/ui";

const SYMPTOM_OPTIONS = [
  "chest pain",
  "shortness of breath",
  "altered mental status",
  "syncope",
  "severe bleeding",
  "stroke symptoms",
  "severe abdominal pain",
  "seizure",
  "high fever",
  "vomiting blood",
  "dizziness",
  "cough",
  "edema",
];

const DEFAULT_VITALS = { hr: 80, sbp: 120, dbp: 80, rr: 16, spo2: 98, tempC: 36.8 };

export function TriageForm({ patients }: { patients: { id: string; label: string }[] }) {
  const router = useRouter();
  const [patientId, setPatientId] = useState(patients[0]?.id ?? "");
  const [complaint, setComplaint] = useState("");
  const [symptoms, setSymptoms] = useState<string[]>([]);
  const [vitals, setVitals] = useState<Record<string, number>>(DEFAULT_VITALS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(s: string) {
    setSymptoms((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId, chiefComplaint: complaint, symptoms, vitals }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not register arrival.");
      return;
    }
    setComplaint("");
    setSymptoms([]);
    setVitals(DEFAULT_VITALS);
    router.refresh();
  }

  return (
    <SectionCard eyebrow="New arrival" title="Register &amp; score a patient">
      <form onSubmit={submit} className="space-y-4 px-5 pb-5">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="label" htmlFor="t-patient">Patient</label>
            <select
              id="t-patient"
              className="field"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
            >
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="t-complaint">Chief complaint</label>
            <input
              id="t-complaint"
              className="field"
              value={complaint}
              onChange={(e) => setComplaint(e.target.value)}
              placeholder="In the patient's words…"
              required
            />
          </div>
        </div>

        <div>
          <span className="label">Presenting symptoms</span>
          <div className="flex flex-wrap gap-1.5">
            {SYMPTOM_OPTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => toggle(s)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  symptoms.includes(s)
                    ? "border-scrub bg-scrub text-white"
                    : "border-hairline-strong bg-surface text-muted hover:border-scrub hover:text-scrub"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="label">Vital signs</span>
          <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
            {(
              [
                ["hr", "HR (bpm)"],
                ["sbp", "SBP (mmHg)"],
                ["dbp", "DBP (mmHg)"],
                ["rr", "RR (/min)"],
                ["spo2", "SpO₂ (%)"],
                ["tempC", "Temp (°C)"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <label className="eyebrow mb-1 block" htmlFor={`v-${key}`}>{label}</label>
                <input
                  id={`v-${key}`}
                  type="number"
                  step="0.1"
                  className="field mono-data"
                  value={vitals[key]}
                  onChange={(e) => setVitals({ ...vitals, [key]: parseFloat(e.target.value) || 0 })}
                />
              </div>
            ))}
          </div>
        </div>

        {error && (
          <p className="rounded-md border border-critical-line bg-critical-wash px-3 py-2 text-[13px] text-critical">
            {error}
          </p>
        )}

        <button className="btn btn-primary" disabled={busy || !complaint.trim()}>
          {busy ? "Scoring…" : "Score & add to queue"}
        </button>
      </form>
    </SectionCard>
  );
}

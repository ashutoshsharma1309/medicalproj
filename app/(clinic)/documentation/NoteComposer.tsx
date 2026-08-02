"use client";

import { useState } from "react";
import Link from "next/link";
import { SectionCard, Chip } from "@/components/ui";

const SAMPLE =
  "F/u visit htn + t2dm. Feels well, occasional evening headaches. Home BP avg 138/86 over 2 wks. Today BP 142/88, HR 74, weight stable 84kg. Heart regular, lungs clear, no edema. A1c last week 8.5 up from 7.4 — control slipping. Plan: start empagliflozin 10mg daily, continue metformin + lisinopril, dietitian referral, repeat A1c and renal panel in 3 months, home BP log continue.";

type SavedNote = {
  id: string;
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  summary: string;
  followUp: string;
  status: string;
};

export function NoteComposer({
  patients,
  preselected,
}: {
  patients: { id: string; label: string }[];
  preselected?: string;
}) {
  const [patientId, setPatientId] = useState(
    preselected && patients.some((p) => p.id === preselected) ? preselected : (patients[0]?.id ?? ""),
  );
  const [kind, setKind] = useState("soap");
  const [raw, setRaw] = useState("");
  const [note, setNote] = useState<SavedNote | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/notes/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId, kind, rawInput: raw }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Generation failed.");
      return;
    }
    setNote(data.note);
    setEngine(data.engine);
  }

  async function finalize() {
    if (!note) return;
    setFinalizing(true);
    const res = await fetch(`/api/notes/${note.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...editable(note), status: "FINALIZED" }),
    });
    const data = await res.json();
    setFinalizing(false);
    if (res.ok) setNote(data.note);
  }

  function editable(n: SavedNote) {
    return {
      subjective: n.subjective,
      objective: n.objective,
      assessment: n.assessment,
      plan: n.plan,
      summary: n.summary,
      followUp: n.followUp,
    };
  }

  const patch = (field: keyof SavedNote) => (e: React.ChangeEvent<HTMLTextAreaElement>) =>
    setNote((n) => (n ? { ...n, [field]: e.target.value } : n));

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <SectionCard className="lg:col-span-2" eyebrow="Input" title="Encounter shorthand">
        <div className="space-y-3 px-5 pb-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="n-patient">Patient</label>
              <select id="n-patient" className="field" value={patientId} onChange={(e) => setPatientId(e.target.value)}>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="n-kind">Note type</label>
              <select id="n-kind" className="field" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="soap">SOAP note</option>
                <option value="consult">Consultation report</option>
                <option value="discharge">Discharge summary</option>
                <option value="followup">Follow-up note</option>
              </select>
            </div>
          </div>
          <textarea
            className="field min-h-64 leading-relaxed"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="Type or dictate encounter notes in shorthand…"
            aria-label="Encounter shorthand"
          />
          <button type="button" className="btn btn-ghost text-xs" onClick={() => setRaw(SAMPLE)}>
            Insert sample dictation
          </button>
          {error && (
            <p className="rounded-md border border-critical-line bg-critical-wash px-3 py-2 text-[13px] text-critical">
              {error}
            </p>
          )}
          <button className="btn btn-primary w-full justify-center" onClick={generate} disabled={busy || raw.trim().length < 10}>
            {busy ? "Structuring note…" : "Generate structured note"}
          </button>
        </div>
      </SectionCard>

      <SectionCard
        className="lg:col-span-3"
        eyebrow="Draft for review"
        title="Structured note"
        action={
          note ? (
            note.status === "FINALIZED" ? (
              <Chip tone="low">Finalized</Chip>
            ) : (
              <button className="btn btn-primary text-xs" onClick={finalize} disabled={finalizing}>
                {finalizing ? "Signing…" : "Approve & finalize"}
              </button>
            )
          ) : undefined
        }
      >
        {!note ? (
          <div className="px-5 py-16 text-center text-sm text-muted">
            The structured SOAP note, patient summary and follow-up plan appear here for your
            review before sign-off.
          </div>
        ) : (
          <div className="space-y-4 px-5 pb-5">
            {(
              [
                ["Subjective", "subjective"],
                ["Objective", "objective"],
                ["Assessment", "assessment"],
                ["Plan", "plan"],
              ] as const
            ).map(([label, field]) => (
              <div key={field}>
                <label className="eyebrow mb-1 block" htmlFor={`f-${field}`}>{label}</label>
                <textarea
                  id={`f-${field}`}
                  className="field min-h-20 text-[13px] leading-relaxed"
                  value={note[field]}
                  onChange={patch(field)}
                  disabled={note.status === "FINALIZED"}
                />
              </div>
            ))}
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="eyebrow mb-1 block" htmlFor="f-summary">Patient-friendly summary</label>
                <textarea
                  id="f-summary"
                  className="field min-h-24 text-[13px] leading-relaxed"
                  value={note.summary}
                  onChange={patch("summary")}
                  disabled={note.status === "FINALIZED"}
                />
              </div>
              <div>
                <label className="eyebrow mb-1 block" htmlFor="f-followup">Follow-up plan</label>
                <textarea
                  id="f-followup"
                  className="field min-h-24 text-[13px] leading-relaxed"
                  value={note.followUp}
                  onChange={patch("followUp")}
                  disabled={note.status === "FINALIZED"}
                />
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-hairline pt-3">
              <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
                Drafted by {engine} · physician review required before sign-off
              </span>
              {note.status === "FINALIZED" && (
                <Link href={`/patients/${patientId}/notes`} className="text-xs font-medium text-scrub hover:underline">
                  View in patient record →
                </Link>
              )}
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SeverityChip } from "@/components/ui";

type BoardCase = {
  id: string;
  patientId: string;
  patientName: string;
  age: number;
  arrivedAt: string;
  chiefComplaint: string;
  symptoms: string[];
  vitals: Record<string, number>;
  acuity: number;
  priority: string;
  score: number;
  rationale: { factor: string; points: number; why: string }[];
  status: string;
  assignedTo: string | null;
};

function waitingMins(iso: string) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

const VITAL_LABEL: Record<string, string> = {
  hr: "HR",
  sbp: "SBP",
  dbp: "DBP",
  rr: "RR",
  spo2: "SpO₂",
  tempC: "Temp",
  gcs: "GCS",
};

export function TriageBoard({ initial }: { initial: BoardCase[] }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(initial[0]?.id ?? null);
  const [busy, setBusy] = useState<string | null>(null);

  async function setStatus(id: string, status: string) {
    setBusy(id);
    await fetch(`/api/triage/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBusy(null);
    router.refresh();
  }

  if (initial.length === 0) {
    return (
      <div className="card px-5 py-10 text-center text-sm text-muted">
        The queue is clear. New arrivals appear here ordered by acuity.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {initial.map((c) => {
        const isOpen = open === c.id;
        const border =
          c.priority === "CRITICAL"
            ? "border-l-critical"
            : c.priority === "HIGH"
              ? "border-l-warn"
              : c.priority === "MEDIUM"
                ? "border-l-info"
                : "border-l-ok";
        return (
          <article key={c.id} className={`card overflow-hidden border-l-[3px] ${border}`}>
            <button
              className="flex w-full items-center gap-4 px-5 py-3.5 text-left"
              onClick={() => setOpen(isOpen ? null : c.id)}
              aria-expanded={isOpen}
            >
              <div className="flex w-24 flex-col items-start gap-1">
                <SeverityChip level={c.priority} label={`ESI ${c.acuity}`} />
                <span className="mono-data text-[11px] text-faint">score {c.score}</span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold">
                  {c.patientName} <span className="ml-1 text-xs font-normal text-faint">{c.age}y</span>
                </div>
                <div className="truncate text-[13px] text-muted">{c.chiefComplaint}</div>
              </div>
              <div className="hidden gap-4 md:flex">
                {Object.entries(c.vitals)
                  .filter(([k]) => ["hr", "sbp", "spo2"].includes(k))
                  .map(([k, v]) => (
                    <div key={k} className="text-center">
                      <div className="eyebrow">{VITAL_LABEL[k]}</div>
                      <div className="mono-data text-[13px] font-semibold">{v}</div>
                    </div>
                  ))}
              </div>
              <div className="w-20 text-right">
                <div className="eyebrow">Waiting</div>
                <div className="mono-data text-[13px] font-semibold">{waitingMins(c.arrivedAt)} min</div>
              </div>
            </button>

            {isOpen && (
              <div className="border-t border-hairline bg-paper/50 px-5 py-4">
                <div className="grid gap-5 md:grid-cols-2">
                  <div>
                    <div className="eyebrow mb-2">Why this priority — score breakdown</div>
                    <ul className="space-y-1.5">
                      {c.rationale.map((f) => (
                        <li key={f.factor} className="flex items-start gap-3 text-[13px]">
                          <span className="mono-data w-9 shrink-0 text-right font-semibold text-scrub">
                            +{f.points}
                          </span>
                          <span>
                            <span className="font-medium">{f.factor}.</span>{" "}
                            <span className="text-muted">{f.why}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="eyebrow mb-2">Full vitals</div>
                    <div className="flex flex-wrap gap-x-6 gap-y-2">
                      {Object.entries(c.vitals).map(([k, v]) => (
                        <div key={k}>
                          <div className="eyebrow">{VITAL_LABEL[k] ?? k}</div>
                          <div className="mono-data text-[14px] font-semibold">{v}</div>
                        </div>
                      ))}
                    </div>
                    {c.symptoms.length > 0 && (
                      <>
                        <div className="eyebrow mt-4 mb-1.5">Reported symptoms</div>
                        <div className="text-[13px] text-muted">{c.symptoms.join(" · ")}</div>
                      </>
                    )}
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Link href={`/patients/${c.patientId}`} className="btn btn-secondary text-xs">
                        Open chart
                      </Link>
                      {c.status === "WAITING" ? (
                        <button
                          className="btn btn-primary text-xs"
                          disabled={busy === c.id}
                          onClick={() => setStatus(c.id, "IN_TREATMENT")}
                        >
                          Begin treatment
                        </button>
                      ) : (
                        <>
                          <span className="chip chip-medium self-center">
                            In treatment{c.assignedTo ? ` · ${c.assignedTo}` : ""}
                          </span>
                          <button
                            className="btn btn-secondary text-xs"
                            disabled={busy === c.id}
                            onClick={() => setStatus(c.id, "DISCHARGED")}
                          >
                            Discharge
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

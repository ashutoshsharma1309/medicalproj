import { db } from "@/lib/db";
import { aiAvailable, MODEL } from "@/lib/ai/client";
import { ExtractPanel } from "./ExtractPanel";

export const metadata = { title: "Document Intelligence" };
export const dynamic = "force-dynamic";

export default async function IntelligencePage() {
  const patients = await db.patient.findMany({ orderBy: { lastName: "asc" } });
  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">Patient intelligence system</div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">Document Intelligence</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-muted">
          Paste or upload the text of a lab report, prescription or discharge summary. Meridian
          extracts conditions, medications, allergies, lab values and risk factors into a
          structured profile — and files it to the patient record.
        </p>
        <p className="mt-2 font-mono text-[10.5px] uppercase tracking-wider text-faint">
          Extraction engine: {aiAvailable() ? MODEL : "deterministic parser (configure ANTHROPIC_API_KEY for LLM extraction)"}
        </p>
      </header>
      <ExtractPanel
        patients={patients.map((p) => ({ id: p.id, label: `${p.lastName}, ${p.firstName} · ${p.mrn}` }))}
      />
    </div>
  );
}

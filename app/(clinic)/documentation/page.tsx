import { db } from "@/lib/db";
import { aiAvailable, MODEL } from "@/lib/ai/client";
import { NoteComposer } from "./NoteComposer";

export const metadata = { title: "Documentation" };
export const dynamic = "force-dynamic";

export default async function DocumentationPage(props: {
  searchParams: Promise<{ patient?: string }>;
}) {
  const { patient: preselected } = await props.searchParams;
  const patients = await db.patient.findMany({ orderBy: { lastName: "asc" } });

  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">Documentation assistant</div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">Clinical notes</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-muted">
          Dictate or type encounter shorthand. Meridian structures it into a SOAP note with a
          patient-friendly summary and a follow-up plan — you review, edit and sign.
        </p>
        <p className="mt-2 font-mono text-[10.5px] uppercase tracking-wider text-faint">
          Drafting engine: {aiAvailable() ? MODEL : "structured template (configure ANTHROPIC_API_KEY for LLM drafting)"}
        </p>
      </header>
      <NoteComposer
        patients={patients.map((p) => ({ id: p.id, label: `${p.lastName}, ${p.firstName} · ${p.mrn}` }))}
        preselected={preselected}
      />
    </div>
  );
}

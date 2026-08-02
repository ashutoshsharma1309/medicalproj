import { db } from "@/lib/db";
import { aiAvailable, MODEL } from "@/lib/ai/client";
import { KnowledgePanel } from "./KnowledgePanel";

export const metadata = { title: "Knowledge" };
export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const sources = await db.guidelineChunk.groupBy({
    by: ["source"],
    _count: { _all: true },
  });

  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">Clinical research assistant</div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">Knowledge</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-muted">
          Evidence-grounded answers from the institution&rsquo;s loaded guideline corpus. Every
          answer cites the exact passages it draws from — nothing is answered from model memory
          alone.
        </p>
        <p className="mt-2 font-mono text-[10.5px] uppercase tracking-wider text-faint">
          Retrieval: lexical BM25 · Synthesis: {aiAvailable() ? MODEL : "extractive mode (configure ANTHROPIC_API_KEY for synthesis)"}
        </p>
      </header>

      <KnowledgePanel
        sources={sources.map((s) => ({ source: s.source, count: s._count._all }))}
      />
    </div>
  );
}

"use client";

import { useState } from "react";
import { SectionCard } from "@/components/ui";
import type { RagAnswer } from "@/lib/rag";

const SUGGESTED = [
  "When should therapy be intensified in type 2 diabetes?",
  "Can a patient with penicillin allergy receive amoxicillin?",
  "Should aspirin be continued alongside warfarin in atrial fibrillation?",
  "What is the blood pressure target for a diabetic patient?",
  "When should a CKD patient be referred to nephrology?",
];

export function KnowledgePanel({ sources }: { sources: { source: string; count: number }[] }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<RagAnswer | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(q: string) {
    setBusy(true);
    setError(null);
    setAsked(q);
    const res = await fetch("/api/knowledge/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Query failed.");
      return;
    }
    setResult(data);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <SectionCard eyebrow="Ask" title="Clinical question">
          <div className="space-y-3 px-5 pb-5">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (query.trim().length >= 5) ask(query.trim());
              }}
            >
              <input
                className="field"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. When should diabetes therapy be intensified?"
                aria-label="Clinical question"
              />
              <button className="btn btn-primary" disabled={busy || query.trim().length < 5}>
                {busy ? "Searching…" : "Ask"}
              </button>
            </form>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTED.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setQuery(s);
                    ask(s);
                  }}
                  className="rounded-full border border-hairline-strong bg-surface px-3 py-1 text-xs text-muted transition-colors hover:border-scrub hover:text-scrub"
                >
                  {s}
                </button>
              ))}
            </div>
            {error && (
              <p className="rounded-md border border-critical-line bg-critical-wash px-3 py-2 text-[13px] text-critical">
                {error}
              </p>
            )}
          </div>
        </SectionCard>

        {result && (
          <SectionCard eyebrow={`Answer · ${result.engine}`} title={asked ?? ""}>
            <div className="space-y-4 px-5 pb-5">
              <div className="whitespace-pre-line text-[13.5px] leading-relaxed">{result.answer}</div>
              {result.citations.length > 0 && (
                <div>
                  <div className="eyebrow mb-2">Evidence</div>
                  <ol className="space-y-2.5">
                    {result.citations.map((c, i) => (
                      <li key={c.id} className="rounded-md border border-hairline bg-paper px-4 py-3">
                        <div className="flex items-baseline gap-2">
                          <span className="mono-data text-xs font-semibold text-scrub">[{i + 1}]</span>
                          <span className="text-[12.5px] font-semibold">{c.source}</span>
                          <span className="text-xs text-faint">· {c.section}</span>
                        </div>
                        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{c.excerpt}</p>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          </SectionCard>
        )}
      </div>

      <SectionCard eyebrow="Corpus" title="Loaded guidelines">
        <ul className="divide-y divide-hairline">
          {sources.map((s) => (
            <li key={s.source} className="px-5 py-3">
              <div className="text-[13px] font-medium leading-snug">{s.source}</div>
              <div className="mono-data mt-0.5 text-xs text-faint">{s.count} indexed sections</div>
            </li>
          ))}
        </ul>
        <p className="border-t border-hairline px-5 py-3 text-xs leading-relaxed text-faint">
          Institution-curated corpus. Answers are grounded exclusively in these passages and always
          cite their sources.
        </p>
      </SectionCard>
    </div>
  );
}

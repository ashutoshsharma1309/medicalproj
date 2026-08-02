import { db } from "./db";
import { aiAvailable, complete, CLINICAL_SYSTEM, MODEL } from "./ai/client";

/**
 * Module 8 — Clinical knowledge assistant (retrieval-augmented).
 *
 * Retrieval: BM25-style lexical scoring over the curated guideline corpus
 * (deterministic, auditable — every answer cites the exact passages used).
 * Synthesis: the LLM composes an evidence-grounded answer from the retrieved
 * passages only; without an API key the top passages are returned verbatim.
 */

export type Citation = { id: string; source: string; section: string; excerpt: string };
export type RagAnswer = {
  answer: string;
  citations: Citation[];
  engine: string;
};

const STOP = new Set(
  "a an and are as at be by for from has have how in is it of on or that the to was what when which with should does can patient patients".split(" "),
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9. ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export async function retrieve(query: string, k = 4): Promise<Citation[]> {
  const chunks = await db.guidelineChunk.findMany();
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];

  const N = chunks.length || 1;
  // document frequency per query token
  const dfs = new Map<string, number>();
  for (const t of qTokens) {
    dfs.set(t, chunks.filter((c) => c.keywords.includes(t) || c.content.toLowerCase().includes(t)).length);
  }
  const avgLen = chunks.reduce((s, c) => s + c.content.length, 0) / N;

  const scored = chunks.map((c) => {
    const body = (c.content + " " + c.keywords + " " + c.section).toLowerCase();
    let score = 0;
    for (const t of qTokens) {
      const tf = body.split(t).length - 1;
      if (tf === 0) continue;
      const df = dfs.get(t) || 1;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (c.content.length / avgLen))));
    }
    return { c, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ c }) => ({
      id: c.id,
      source: c.source,
      section: c.section,
      excerpt: c.content,
    }));
}

export async function answerClinicalQuestion(query: string): Promise<RagAnswer> {
  const citations = await retrieve(query);

  if (citations.length === 0) {
    return {
      answer:
        "No relevant passages were found in the loaded guideline corpus for this question. Rephrase the question or consult the source guidelines directly.",
      citations: [],
      engine: "retrieval-only",
    };
  }

  if (aiAvailable()) {
    const answer = await complete({
      system: CLINICAL_SYSTEM,
      prompt: `Answer the clinician's question using ONLY the evidence passages below. Cite passages inline as [1], [2] … matching their order. If the passages do not fully answer the question, state what is missing. Keep the answer under 250 words, structured for fast reading.

Question: ${query}

Evidence passages:
${citations.map((c, i) => `[${i + 1}] ${c.source} — ${c.section}\n${c.excerpt}`).join("\n\n")}`,
      maxTokens: 1200,
    });
    return { answer, citations, engine: `bm25 + ${MODEL}` };
  }

  // Extractive fallback — verbatim top passages, clearly labelled.
  return {
    answer:
      "Most relevant guideline passages (extractive mode — configure ANTHROPIC_API_KEY for synthesized answers):\n\n" +
      citations.map((c, i) => `[${i + 1}] ${c.source} — ${c.section}\n${c.excerpt}`).join("\n\n"),
    citations,
    engine: "bm25-extractive",
  };
}

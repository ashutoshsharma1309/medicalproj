import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chunkText, normalize } from "../chunking";
import { buildContext, isKnowledgeOnly, RELEVANCE_FLOOR } from "../context-builder";
import {
  assertUsableVector,
  embedChunks,
  toVectorLiteral,
  EMBEDDING_DIMENSIONS,
} from "../embedding-service";
import {
  buildUserPrompt,
  deterministicAnswer,
  generateAnswer,
} from "../answer-service";
import { KNOWLEDGE_BASE } from "../knowledge-base";
import { DISCLAIMER, type RetrievedChunk } from "../types";
import { enforceNoDiagnosis } from "../../services/documents/review";

/* ------------------------------------------------------------- fixtures */

const LAB_REPORT = `CITY DIAGNOSTICS — BIOCHEMISTRY REPORT
Patient: A Menon        Collected: 12 March 2026

TEST                 RESULT      REFERENCE
HbA1c                8.2 %       4.0 - 5.6
Fasting glucose      148 mg/dL   70 - 100
Total cholesterol    212 mg/dL   < 200
LDL cholesterol      141 mg/dL   < 100
HDL cholesterol      38 mg/dL    > 40`;

function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    id: "c1",
    sourceType: "PATIENT_DOCUMENT",
    documentId: "doc-1",
    knowledgeDocumentId: null,
    chunkIndex: 0,
    content: "HbA1c 8.2 %",
    metadata: {},
    similarity: 0.8,
    ...overrides,
  };
}

const label = (c: RetrievedChunk) =>
  c.sourceType === "PATIENT_DOCUMENT"
    ? { label: "Blood report — 12 March 2026", href: `/records/${c.documentId}` }
    : { label: "HbA1c reference", citation: "ADA Standards of Care" };

/* ------------------------------------------------------------- chunking */

describe("chunking", () => {
  it("never splits a lab result line in half", () => {
    // The failure this guards against: a chunk ending "HbA1c 8.2 %  4.0 -"
    // and one beginning "5.6" — both embed, neither means anything.
    const chunks = chunkText(LAB_REPORT, 200);

    for (const c of chunks) {
      for (const line of c.content.split("\n")) {
        if (!/HbA1c|glucose|cholesterol/i.test(line)) continue;
        assert.doesNotMatch(line, /-\s*$/, `line ends mid-range: "${line}"`);
      }
    }
  });

  it("keeps every result line intact somewhere in the output", () => {
    const chunks = chunkText(LAB_REPORT, 200);
    const all = chunks.map((c) => c.content).join("\n");

    for (const line of ["HbA1c 8.2 % 4.0 - 5.6", "LDL cholesterol 141 mg/dL < 100"]) {
      assert.ok(all.includes(line), `lost the line: ${line}`);
    }
  });

  it("overlaps whole lines so a result keeps its header", () => {
    const chunks = chunkText(LAB_REPORT, 200);
    assert.ok(chunks.length > 1, "fixture did not split");

    // The last lines of chunk n reappear at the start of chunk n+1.
    const tail = chunks[0].content.split("\n").slice(-2);
    assert.ok(
      tail.some((line) => chunks[1].content.startsWith(line)),
      "no line overlap between consecutive chunks",
    );
  });

  it("indexes chunks contiguously from zero", () => {
    const chunks = chunkText(LAB_REPORT, 150);
    assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
  });

  it("returns nothing for empty or whitespace input", () => {
    assert.deepEqual(chunkText(""), []);
    assert.deepEqual(chunkText("   \n\n  \t "), []);
  });

  it("does not emit a runt final chunk", () => {
    // A twelve-character trailing chunk retrieves badly and pollutes results.
    const text = `${"line of clinical text here\n".repeat(40)}tail`;
    const chunks = chunkText(text, 400);
    assert.ok(chunks[chunks.length - 1].length >= 60);
  });

  it("splits a single over-long line rather than emitting it whole", () => {
    const long = `${"This sentence describes a finding. ".repeat(120)}`;
    const chunks = chunkText(long, 800);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 2000));
  });

  it("collapses ragged OCR spacing but keeps line structure", () => {
    const lines = normalize("HbA1c    8.2  %\r\n\r\n   LDL   141\n\n");
    assert.deepEqual(lines, ["HbA1c 8.2 %", "LDL 141"]);
  });

  it("keeps chunks inside the embedding window", () => {
    // MiniLM truncates at 256 tokens; a chunk far past that loses its tail
    // silently, and the lost tail is usually the numbers.
    for (const c of chunkText(LAB_REPORT)) {
      assert.ok(c.length <= 1600, `chunk ${c.index} is ${c.length} chars`);
    }
  });
});

/* ------------------------------------------------------------ embedding */

describe("embedding guards", () => {
  it("rejects a wrong-dimension vector", () => {
    assert.throws(() => assertUsableVector([1, 2, 3], 0), /384 dimensions/);
  });

  it("rejects NaN, which pgvector would accept and then rank arbitrarily", () => {
    const bad = Array(EMBEDDING_DIMENSIONS).fill(0);
    bad[7] = Number.NaN;
    assert.throws(() => assertUsableVector(bad, 3), /non-finite/);
  });

  it("accepts a well-formed vector", () => {
    assert.doesNotThrow(() => assertUsableVector(Array(EMBEDDING_DIMENSIONS).fill(0.1), 0));
  });

  it("formats a pgvector literal", () => {
    assert.equal(toVectorLiteral([0.1, -0.2, 0.3]), "[0.1,-0.2,0.3]");
  });

  it("fails loudly when the embedder returns the wrong count", () => {
    const chunks = chunkText(LAB_REPORT, 200);
    const short = async () => [Array(EMBEDDING_DIMENSIONS).fill(0.1)];
    return assert.rejects(() => embedChunks(chunks, short), /count mismatch/);
  });

  it("pairs each chunk with its own vector", async () => {
    const chunks = chunkText(LAB_REPORT, 200);
    const fake = async (texts: string[]) =>
      texts.map((_, i) => Array(EMBEDDING_DIMENSIONS).fill(i / 100));

    const embedded = await embedChunks(chunks, fake);
    assert.equal(embedded.length, chunks.length);
    embedded.forEach((pair, i) => {
      assert.equal(pair.chunk.index, i);
      assert.equal(pair.embedding[0], i / 100);
    });
  });

  it("returns nothing for no chunks", async () => {
    assert.deepEqual(await embedChunks([], async () => []), []);
  });
});

/* ------------------------------------------------------ context builder */

describe("context building", () => {
  it("abstains when everything is below the floor", () => {
    const context = buildContext([chunk({ similarity: 0.05, sourceType: "MEDICAL_KNOWLEDGE" })], label);
    assert.equal(context.empty, true);
    assert.equal(context.context, "");
    assert.deepEqual(context.sources, []);
  });

  it("drops weak knowledge matches but keeps the patient's own record", () => {
    // Their own record is the subject of the question, so it is admitted at a
    // lower bar than a textbook that merely mentions the word.
    const context = buildContext(
      [
        chunk({ id: "p", similarity: 0.2 }),
        chunk({ id: "k", sourceType: "MEDICAL_KNOWLEDGE", knowledgeDocumentId: "k1", documentId: null, similarity: 0.2 }),
      ],
      label,
    );

    assert.equal(context.chunks.length, 1);
    assert.equal(context.chunks[0].sourceType, "PATIENT_DOCUMENT");
  });

  it("orders the patient's record above reference material", () => {
    // Even when the textbook scores higher — a question about "my HbA1c" is
    // about them, and a context full of textbook answers it with nothing
    // about them in it.
    const context = buildContext(
      [
        chunk({ id: "k", sourceType: "MEDICAL_KNOWLEDGE", knowledgeDocumentId: "k1", documentId: null, similarity: 0.95 }),
        chunk({ id: "p", similarity: 0.4 }),
      ],
      label,
    );

    assert.equal(context.chunks[0].sourceType, "PATIENT_DOCUMENT");
    assert.equal(context.sources[0].kind, "PATIENT_DOCUMENT");
  });

  it("labels each block with its origin so the model cannot conflate them", () => {
    const context = buildContext(
      [
        chunk({ id: "p" }),
        chunk({ id: "k", sourceType: "MEDICAL_KNOWLEDGE", knowledgeDocumentId: "k1", documentId: null, similarity: 0.7 }),
      ],
      label,
    );

    assert.match(context.context, /\[PATIENT RECORD — /);
    assert.match(context.context, /\[MEDICAL REFERENCE — /);
  });

  it("lists one source per document, not one per chunk", () => {
    // Four chunks from one report is one source to a patient; listing it four
    // times reads as four pieces of corroborating evidence.
    const context = buildContext(
      [
        chunk({ id: "a", chunkIndex: 0, similarity: 0.9 }),
        chunk({ id: "b", chunkIndex: 1, similarity: 0.8 }),
        chunk({ id: "c", chunkIndex: 2, similarity: 0.7 }),
      ],
      label,
    );

    assert.equal(context.chunks.length, 3);
    assert.equal(context.sources.length, 1);
    assert.equal(context.sources[0].similarity, 0.9);
  });

  it("carries the href for a patient document and the citation for a reference", () => {
    const context = buildContext(
      [
        chunk({ id: "p" }),
        chunk({ id: "k", sourceType: "MEDICAL_KNOWLEDGE", knowledgeDocumentId: "k1", documentId: null, similarity: 0.7 }),
      ],
      label,
    );

    const own = context.sources.find((s) => s.kind === "PATIENT_DOCUMENT")!;
    const ref = context.sources.find((s) => s.kind === "MEDICAL_KNOWLEDGE")!;

    assert.equal(own.href, "/records/doc-1");
    assert.equal(ref.citation, "ADA Standards of Care");
  });

  it("bounds the context regardless of how much came back", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      chunk({ id: `c${i}`, chunkIndex: i, content: "x".repeat(400), similarity: 0.9 }),
    );
    assert.ok(buildContext(many, label).context.length <= 6000);
  });

  it("detects a knowledge-only context", () => {
    const knowledgeOnly = buildContext(
      [chunk({ sourceType: "MEDICAL_KNOWLEDGE", knowledgeDocumentId: "k1", documentId: null, similarity: 0.8 })],
      label,
    );
    assert.equal(isKnowledgeOnly(knowledgeOnly), true);
    assert.equal(isKnowledgeOnly(buildContext([chunk()], label)), false);
  });

  it("uses a floor high enough to exclude unrelated matches", () => {
    assert.ok(RELEVANCE_FLOOR > 0.2, "floor is low enough to admit noise");
  });
});

/* --------------------------------------------------------- answering */

describe("grounded answering", () => {
  const context = buildContext(
    [
      chunk({ content: "HbA1c 8.2 % (reference 4.0 - 5.6)" }),
      chunk({
        id: "k",
        sourceType: "MEDICAL_KNOWLEDGE",
        knowledgeDocumentId: "k1",
        documentId: null,
        content: "HbA1c reflects average blood glucose over about three months.",
        similarity: 0.7,
      }),
    ],
    label,
  );

  it("abstains rather than inventing when nothing was retrieved", async () => {
    const empty = buildContext([], label);
    const answer = await generateAnswer("What is my creatinine?", empty, {
      complete: async () => "You have chronic kidney disease.",
    });

    assert.equal(answer.abstained, true);
    assert.match(answer.answer, /could not find/i);
    assert.deepEqual(answer.sources, []);
    // The injected model was never consulted — abstention short-circuits.
  });

  it("passes the retrieved context to the model and forbids anything else", async () => {
    let seen = "";
    await generateAnswer("What does my HbA1c mean?", context, {
      complete: async ({ messages }) => {
        seen = messages.map((m) => m.content).join("\n");
        return "Your record shows HbA1c 8.2%.";
      },
    });

    assert.match(seen, /Answer ONLY from the CONTEXT/);
    assert.match(seen, /HbA1c 8\.2 %/);
    assert.match(seen, /NEVER diagnose/);
  });

  it("replaces a diagnostic answer with the deterministic one", async () => {
    const answer = await generateAnswer("What does my HbA1c mean?", context, {
      complete: async () => "You have diabetes and your levels require treatment.",
      model: "test-model",
    });

    assert.equal(answer.guardrailTriggered, true);
    assert.equal(answer.generatedBy, "deterministic");
    assert.doesNotMatch(answer.answer, /you have diabetes/i);
  });

  it("falls back deterministically when the model throws", async () => {
    const answer = await generateAnswer("What does my HbA1c mean?", context, {
      complete: async () => {
        throw new Error("provider down");
      },
    });

    assert.equal(answer.generatedBy, "deterministic");
    assert.ok(answer.answer.length > 0);
    assert.equal(answer.abstained, false);
  });

  it("keeps the sources on a generated answer", async () => {
    const answer = await generateAnswer("What does my HbA1c mean?", context, {
      complete: async () => "Your record shows HbA1c 8.2%.",
      model: "test-model",
    });

    assert.equal(answer.sources.length, 2);
    assert.equal(answer.generatedBy, "test-model");
  });

  it("carries the disclaimer on every path", async () => {
    const paths = [
      await generateAnswer("q", buildContext([], label), {}),
      await generateAnswer("q", context, { complete: async () => "fine answer" }),
      await generateAnswer("q", context, {
        complete: async () => {
          throw new Error("down");
        },
      }),
    ];

    for (const answer of paths) assert.equal(answer.disclaimer, DISCLAIMER);
    assert.match(DISCLAIMER, /should not replace professional medical advice/);
  });

  it("the deterministic answer quotes rather than interprets", () => {
    const answer = deterministicAnswer("What does my HbA1c mean?", context);
    assert.match(answer.answer, /HbA1c 8\.2/);
    assert.match(answer.answer, /healthcare provider/);
    assert.equal(enforceNoDiagnosis(answer.answer).rewritten, false);
  });

  it("the prompt puts the context before the question", () => {
    const prompt = buildUserPrompt("What does my HbA1c mean?", context);
    assert.ok(prompt.indexOf("CONTEXT:") < prompt.indexOf("QUESTION:"));
  });
});

/* --------------------------------------------------------- knowledge base */

describe("knowledge base", () => {
  it("every entry cites a source", () => {
    for (const entry of KNOWLEDGE_BASE) {
      assert.ok(entry.citation.trim().length > 0, `${entry.title} has no citation`);
      assert.doesNotMatch(entry.citation, /AVERIS/i, "cited itself as a source");
    }
  });

  it("no entry addresses the reader's own results", () => {
    // Reference material describes populations. The moment an article says
    // "your", it stops being reference and starts being a claim about a person.
    for (const entry of KNOWLEDGE_BASE) {
      assert.doesNotMatch(
        entry.body,
        /\byour (?:result|level|value|reading)s?\b/i,
        `${entry.title} addresses the reader's own results`,
      );
    }
  });

  it("no entry gives an instruction or a diagnosis", () => {
    for (const entry of KNOWLEDGE_BASE) {
      assert.equal(
        enforceNoDiagnosis(entry.body).rewritten,
        false,
        `${entry.title} tripped the anti-diagnosis guard`,
      );
    }
  });

  it("covers the measurements the risk models consume", () => {
    // A patient told their glucose drove a risk estimate should be able to
    // ask what glucose is and get an answer.
    const titles = KNOWLEDGE_BASE.map((e) => e.title.toLowerCase()).join(" | ");
    for (const term of ["hba1c", "glucose", "ldl", "hdl", "blood pressure", "body mass index"]) {
      assert.ok(titles.includes(term), `no knowledge entry covers ${term}`);
    }
  });

  it("chunks cleanly and stays inside the embedding window", () => {
    for (const entry of KNOWLEDGE_BASE) {
      const chunks = chunkText(`${entry.title}\n\n${entry.body}`);
      assert.ok(chunks.length > 0, `${entry.title} produced no chunks`);
      for (const c of chunks) {
        assert.ok(c.length <= 1600, `${entry.title} chunk ${c.index} is ${c.length} chars`);
      }
    }
  });

  it("has unique titles, which the seed upserts on", () => {
    const titles = KNOWLEDGE_BASE.map((e) => e.title);
    assert.equal(new Set(titles).size, titles.length, "duplicate title would collide on seed");
  });
});

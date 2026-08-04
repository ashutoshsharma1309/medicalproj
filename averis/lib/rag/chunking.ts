/**
 * Chunking medical text.
 *
 * The default recipe — slide a fixed character window with an overlap — is
 * wrong for this corpus, and wrong in a way that is invisible until a patient
 * gets a confidently incorrect answer.
 *
 * Lab reports are line-oriented tables:
 *
 *     HbA1c            8.2 %      4.0 - 5.6
 *     Fasting glucose  148 mg/dL  70 - 100
 *
 * A window that cuts mid-line produces a chunk ending "HbA1c 8.2 %  4.0 -"
 * and one beginning "5.6". Both embed as something, neither means anything,
 * and the second can retrieve well for a question about reference ranges
 * while carrying no test name at all.
 *
 * So chunks are packed from whole lines. A line is the atomic unit; only a
 * single line longer than the budget is ever split, and then on sentence
 * boundaries. Overlap is carried as whole trailing lines, which keeps a
 * result row attached to the header that names its units.
 */

export type Chunk = {
  index: number;
  content: string;
  /** Characters, for cost accounting and for the tests. */
  length: number;
};

/** Roughly 200 tokens — comfortably inside MiniLM's 256-token window. */
const TARGET_CHARS = 800;

/** Below this a chunk carries too little context to retrieve usefully. */
const MIN_CHARS = 60;

/** Trailing lines repeated into the next chunk, to preserve table headers. */
const OVERLAP_LINES = 2;

/**
 * Hard ceiling on an emitted chunk.
 *
 * MiniLM truncates at 256 tokens, so anything much past this loses its tail
 * silently — and in a lab report the tail is where the numbers are. Nothing
 * leaves this module larger than this.
 */
const MAX_CHUNK_CHARS = 1500;

export function chunkText(raw: string, targetChars = TARGET_CHARS): Chunk[] {
  const lines = normalize(raw);
  if (lines.length === 0) return [];

  const units = lines.flatMap((line) =>
    line.length > targetChars ? splitLongLine(line, targetChars) : [line],
  );

  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;

  for (const unit of units) {
    // +1 for the newline that will rejoin them.
    if (size > 0 && size + unit.length + 1 > targetChars) {
      chunks.push(current.join("\n"));

      // Overlap is capped by characters, not just by line count. Two whole
      // trailing lines is cheap for a lab table and ruinous for prose: with
      // long lines it compounds chunk over chunk, and the result grows past
      // the embedding window where the tail is dropped without any error.
      current = boundedOverlap(current, Math.floor(targetChars / 3));
      size = current.reduce((total, line) => total + line.length + 1, 0);
    }
    current.push(unit);
    size += unit.length + 1;
  }

  if (current.length > 0) chunks.push(current.join("\n"));

  // A single unit can still exceed the target on its own, so the ceiling is
  // enforced on the way out rather than assumed.
  return mergeRunts(chunks)
    .flatMap((content) =>
      content.length > MAX_CHUNK_CHARS ? hardSplit(content, MAX_CHUNK_CHARS) : [content],
    )
    .map((content, index) => ({ index, content, length: content.length }));
}

/** Carries trailing lines forward, but never more than `budget` characters. */
function boundedOverlap(lines: string[], budget: number): string[] {
  const carried: string[] = [];
  let used = 0;

  for (let i = lines.length - 1; i >= 0 && carried.length < OVERLAP_LINES; i -= 1) {
    const size = lines[i].length + 1;
    if (used + size > budget) break;
    carried.unshift(lines[i]);
    used += size;
  }

  return carried;
}

/**
 * Collapses whitespace without destroying line structure.
 *
 * OCR output is full of ragged spacing and blank lines; the line breaks
 * themselves carry the table layout and have to survive.
 */
export function normalize(raw: string): string[] {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line) => line.length > 0);
}

/**
 * A final chunk of a dozen characters retrieves badly and pollutes results,
 * so a runt is folded back into its predecessor even if that overshoots the
 * target slightly. A slightly long chunk is harmless; a meaningless one is not.
 */
function mergeRunts(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks;

  const merged = [...chunks];
  const last = merged[merged.length - 1];

  if (last.length < MIN_CHARS) {
    merged.pop();
    merged[merged.length - 1] = `${merged[merged.length - 1]}\n${last}`;
  }

  return merged;
}

/** Splits an over-long line on sentence boundaries, falling back to words. */
function splitLongLine(line: string, budget: number): string[] {
  const sentences = line.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [line];

  const pieces: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length + sentence.length > budget && current.length > 0) {
      pieces.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim().length > 0) pieces.push(current.trim());

  // A single sentence longer than the cap still has to be broken somewhere.
  return pieces.flatMap((piece) =>
    piece.length > budget ? hardSplit(piece, budget) : [piece],
  );
}

function hardSplit(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

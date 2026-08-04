import type { Chunk } from "./chunking";

/**
 * Embeddings — all-MiniLM-L6-v2 via transformers.js.
 *
 * Runs in the Node server process rather than a Python sidecar, for the same
 * reason inference does in Phase 4: the model is 23 MB and the alternative is
 * a second runtime, a network hop carrying patient text, and an auth boundary
 * to secure.
 *
 * Two things matter operationally.
 *
 * **The pipeline is a singleton.** Loading the model takes tens of seconds on
 * a cold cache and about a second warm. Constructing it per request would make
 * every question feel broken, so it is built once and the in-flight promise is
 * shared — concurrent callers during startup wait on one load rather than
 * racing to start several.
 *
 * **Vectors are L2-normalised.** pgvector's `<=>` is cosine distance, which
 * is only equal to `1 - dot` for unit vectors. Storing un-normalised vectors
 * would still return plausible-looking rankings, just subtly wrong ones.
 */

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSIONS = 384;

/** MiniLM truncates at 256 tokens; past this the tail is silently dropped. */
const MAX_INPUT_CHARS = 1600;

type Extractor = (
  input: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
  // The promise itself is cached, not just the result: two requests arriving
  // during a cold start must share one model load.
  extractorPromise ??= (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    return (await pipeline("feature-extraction", EMBEDDING_MODEL)) as unknown as Extractor;
  })();

  try {
    return await extractorPromise;
  } catch (error) {
    // A failed load must not poison every later request.
    extractorPromise = null;
    throw error;
  }
}

/** Loads the model ahead of first use, so a patient never pays for it. */
export async function warmUp(): Promise<void> {
  await getExtractor();
}

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/**
 * Embeds a batch.
 *
 * `embed` is injectable so the retrieval and indexing logic can be tested
 * without loading a 23 MB model or touching the network.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const extractor = await getExtractor();
  const prepared = texts.map((text) => text.slice(0, MAX_INPUT_CHARS));
  const output = await extractor(prepared, { pooling: "mean", normalize: true });

  return output.tolist();
}

export async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embed([text]);
  return vector;
}

export async function embedChunks(
  chunks: Chunk[],
  embedFn: EmbedFn = embed,
): Promise<{ chunk: Chunk; embedding: number[] }[]> {
  if (chunks.length === 0) return [];

  const vectors = await embedFn(chunks.map((chunk) => chunk.content));

  if (vectors.length !== chunks.length) {
    throw new Error(
      `Embedding count mismatch: ${chunks.length} chunks produced ${vectors.length} vectors.`,
    );
  }

  return chunks.map((chunk, i) => {
    assertUsableVector(vectors[i], chunk.index);
    return { chunk, embedding: vectors[i] };
  });
}

/**
 * A malformed vector must fail here rather than at insert time.
 *
 * pgvector would reject a wrong dimension, but a vector full of NaN inserts
 * happily and then makes every distance NaN — which does not error, it just
 * silently ranks that chunk arbitrarily forever.
 */
export function assertUsableVector(vector: number[], chunkIndex: number): void {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Chunk ${chunkIndex}: expected ${EMBEDDING_DIMENSIONS} dimensions, got ${vector.length}.`,
    );
  }
  if (!vector.every(Number.isFinite)) {
    throw new Error(`Chunk ${chunkIndex}: embedding contains a non-finite value.`);
  }
}

/** pgvector's text input format. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

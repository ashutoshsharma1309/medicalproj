/**
 * Pre-fetches the embedding model into the image's HuggingFace cache.
 *
 * Run during the Docker build so the runtime never downloads. See the note in
 * the Dockerfile: without this, the first request after every cold start pays
 * ~100 seconds and serving depends on huggingface.co being reachable.
 *
 * Deliberately fails the build if the download fails. An image that silently
 * ships without its model looks healthy right up until a patient asks a
 * question, and then fails in the slowest possible way.
 */

import { pipeline } from "@huggingface/transformers";

const MODEL = "Xenova/all-MiniLM-L6-v2";

const started = Date.now();
console.log(`Fetching ${MODEL} into ${process.env.HF_HOME ?? "the default cache"}…`);

const extractor = await pipeline("feature-extraction", MODEL);

// Run it once. A cached-but-corrupt download only reveals itself on use, and
// discovering that at build time costs a rebuild rather than an outage.
const probe = await extractor(["warmup"], { pooling: "mean", normalize: true });
const [dimensions] = probe.dims.slice(-1);

if (dimensions !== 384) {
  throw new Error(`Expected 384 dimensions from ${MODEL}, got ${dimensions}.`);
}

console.log(`Model cached and verified in ${((Date.now() - started) / 1000).toFixed(1)}s.`);

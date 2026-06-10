// LOCKED — verified March 3 2026 — Xenova all-MiniLM-L6-v2 local CPU embeddings + disk cache
// DO NOT RE-AUDIT — stable since v1.0, no API keys, no data leaves machine
//
// 🔒 LOCKED [OPTIONAL-HF] — 2026-06-10
// ⛔ NEVER convert `await import("@huggingface/transformers")` to a static
//    import. HF is in optionalDependencies — a static import breaks installs
//    that ran with --omit=optional (locked-down npm proxies, air-gapped CI).
// ⛔ NEVER remove the try/catch around the dynamic import or the
//    isMissingDep detection branch — both keep the MCP server alive on
//    fresh installs where HF didn't download.
// WHY: The package was failing to install on enterprise environments because
//    HF transitively pulls 427 MB of onnxruntime native binaries. Making
//    HF optional dropped cold install from 547 MB to 120 MB and unblocked
//    a whole class of buyers. A static import would silently re-break this.
// FIX: If you need to take a dependency on a transformer feature, add it
//    behind the same dynamic-import + isEmbeddingsReady() check pattern.

import type { Chunk } from "./ingest.js";

// We dynamically import @huggingface/transformers to keep startup fast
// and handle the case where it fails gracefully.
let embedPipeline: any = null;

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

/**
 * Initialize the embedding pipeline (downloads model on first run, ~22MB).
 * Subsequent calls use cached model.
 *
 * @huggingface/transformers is an optional dependency (~250MB transitive,
 * native onnxruntime binaries). If it's absent (npm install --no-optional,
 * air-gapped network at install time, or locked-down corp proxy), we silently
 * fall back to BM25 keyword search — `search_context` still works.
 */
export async function initEmbeddings(): Promise<boolean> {
  try {
    console.error(`[ContextEngine] 🧠 Loading embedding model: ${MODEL_NAME}...`);
    const { pipeline } = await import("@huggingface/transformers");
    embedPipeline = await pipeline("feature-extraction", MODEL_NAME, {
      dtype: "fp32",
    });
    console.error(`[ContextEngine] ✅ Embedding model loaded`);
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    const isMissingDep =
      msg.includes("Cannot find package") ||
      msg.includes("ERR_MODULE_NOT_FOUND") ||
      msg.includes("@huggingface/transformers");
    if (isMissingDep) {
      console.error(
        `[ContextEngine] ⚠ Semantic search disabled — @huggingface/transformers not installed.\n` +
        `   BM25 keyword search still works. To enable semantic search:\n` +
        `     npm install @huggingface/transformers\n` +
        `   (~250MB download; CPU-only embeddings via Xenova/all-MiniLM-L6-v2, no data leaves the machine).`,
      );
    } else {
      console.error(
        `[ContextEngine] ⚠ Embeddings unavailable (keyword search only):`,
        msg,
      );
    }
    return false;
  }
}

/**
 * Embed a single text string → float32 vector (384 dimensions).
 */
async function embedText(text: string): Promise<Float32Array> {
  const output = await embedPipeline(text, {
    pooling: "mean",
    normalize: true,
  });
  // output.data is a flat typed array
  return new Float32Array(output.data);
}

/**
 * Cosine similarity between two vectors.
 * Both must be normalized (which MiniLM + normalize:true guarantees),
 * so dot product = cosine similarity.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * An embedded chunk with its vector.
 */
export interface EmbeddedChunk {
  chunk: Chunk;
  vector: Float32Array;
}

/**
 * Embed all chunks. Returns the chunks with their vectors.
 * Shows progress on stderr.
 */
export async function embedChunks(chunks: Chunk[]): Promise<EmbeddedChunk[]> {
  const results: EmbeddedChunk[] = [];
  const total = chunks.length;
  const batchSize = 10;

  for (let i = 0; i < total; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (chunk) => {
        // Embed section + content together for context
        const text = `${chunk.section}\n${chunk.content}`.slice(0, 512);
        const vector = await embedText(text);
        return { chunk, vector };
      })
    );
    results.push(...batchResults);

    const done = Math.min(i + batchSize, total);
    if (done % 50 === 0 || done === total) {
      console.error(`[ContextEngine] 📊 Embedded ${done}/${total} chunks`);
    }
  }

  return results;
}

export interface VectorSearchResult {
  chunk: Chunk;
  score: number;
}

/**
 * Semantic search: embed the query, then find most similar chunks.
 */
export async function vectorSearch(
  query: string,
  embeddedChunks: EmbeddedChunk[],
  topK: number = 10
): Promise<VectorSearchResult[]> {
  if (!embedPipeline || embeddedChunks.length === 0) return [];

  const queryVector = await embedText(query);

  const scored: VectorSearchResult[] = embeddedChunks.map((ec) => ({
    chunk: ec.chunk,
    score: cosineSimilarity(queryVector, ec.vector),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Check if embeddings are available.
 */
export function isEmbeddingsReady(): boolean {
  return embedPipeline !== null;
}

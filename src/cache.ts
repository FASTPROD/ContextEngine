import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import type { Chunk } from "./ingest.js";
import type { EmbeddedChunk } from "./embeddings.js";

/**
 * Embedding cache — persists vectors to disk so restart is instant.
 *
 * Cache key: SHA-256 hash of all chunk contents (sorted).
 * If chunks haven't changed, we skip the entire embedding step.
 *
 * File: ~/.contextengine/embedding-cache.json
 * Format: { hash, vectors: [[...float32 values]], chunks: [{source,section,lineStart,lineEnd}] }
 *
 * On a typical 555-chunk dataset:
 * - First run: ~15s (model load + embed)
 * - Cached restart: ~200ms (read JSON + reconstruct Float32Arrays)
 */

const CACHE_DIR = resolve(homedir(), ".contextengine");
const CACHE_FILE = join(CACHE_DIR, "embedding-cache.json");

interface CacheEntry {
  hash: string;
  version: number; // cache format version
  chunkCount: number;
  timestamp: string;
  /** Chunk metadata (source, section, lineStart, lineEnd) — content reconstructed from live chunks */
  chunkKeys: Array<{ source: string; section: string; lineStart: number; lineEnd: number }>;
  /** Vectors as nested number arrays (JSON can't represent Float32Array) */
  vectors: number[][];
}

const CACHE_VERSION = 2;

/**
 * Compute a hash of all chunk contents to detect changes.
 * Uses source+section+content concatenated.
 */
function computeChunkHash(chunks: Chunk[]): string {
  const hasher = createHash("sha256");
  for (const c of chunks) {
    hasher.update(`${c.source}\0${c.section}\0${c.content}\0`);
  }
  return hasher.digest("hex");
}

/**
 * Try to load cached embeddings. Returns null if cache is stale or missing.
 */
export function loadCache(chunks: Chunk[]): EmbeddedChunk[] | null {
  if (!existsSync(CACHE_FILE)) return null;

  try {
    const raw = readFileSync(CACHE_FILE, "utf-8");
    const cache: CacheEntry = JSON.parse(raw);

    // Version check
    if (cache.version !== CACHE_VERSION) {
      console.error("[ContextEngine] 💾 Cache version mismatch — will re-embed");
      return null;
    }

    // Hash check — have chunks changed?
    const currentHash = computeChunkHash(chunks);
    if (cache.hash !== currentHash) {
      console.error("[ContextEngine] 💾 Cache stale (chunks changed) — will re-embed");
      return null;
    }

    // Count check
    if (cache.vectors.length !== chunks.length) {
      console.error("[ContextEngine] 💾 Cache count mismatch — will re-embed");
      return null;
    }

    // Reconstruct EmbeddedChunk[] from cache
    const result: EmbeddedChunk[] = [];
    for (let i = 0; i < chunks.length; i++) {
      result.push({
        chunk: chunks[i],
        vector: new Float32Array(cache.vectors[i]),
      });
    }

    console.error(
      `[ContextEngine] 💾 Loaded ${result.length} cached embeddings (instant!)`
    );
    return result;
  } catch (err) {
    console.error("[ContextEngine] ⚠ Cache read failed:", (err as Error).message);
    return null;
  }
}

/**
 * Save embeddings to disk cache.
 */
export function saveCache(chunks: Chunk[], embedded: EmbeddedChunk[]): void {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }

    const cache: CacheEntry = {
      hash: computeChunkHash(chunks),
      version: CACHE_VERSION,
      chunkCount: chunks.length,
      timestamp: new Date().toISOString(),
      chunkKeys: chunks.map((c) => ({
        source: c.source,
        section: c.section,
        lineStart: c.lineStart,
        lineEnd: c.lineEnd,
      })),
      vectors: embedded.map((ec) => Array.from(ec.vector)),
    };

    writeFileSync(CACHE_FILE, JSON.stringify(cache));

    const sizeKB = Math.round(statSync(CACHE_FILE).size / 1024);
    console.error(
      `[ContextEngine] 💾 Saved ${embedded.length} embeddings to cache (${sizeKB} KB)`
    );
  } catch (err) {
    console.error("[ContextEngine] ⚠ Cache write failed:", (err as Error).message);
  }
}

/**
 * Clear the embedding cache.
 */
export function clearCache(): boolean {
  try {
    if (existsSync(CACHE_FILE)) {
      unlinkSync(CACHE_FILE);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

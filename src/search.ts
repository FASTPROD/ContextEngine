import { Chunk } from "./ingest.js";

/**
 * BM25-style keyword search over chunks.
 *
 * v1.10: Upgraded from naive term-overlap to proper BM25 scoring with:
 * - IDF (inverse document frequency) — rare terms score higher
 * - Document length normalization — short focused chunks aren't penalized
 * - Configurable k1 (term frequency saturation) and b (length penalty)
 *
 * Inspired by OpenClaw's FTS5/BM25 approach but pure JS (no SQLite dep).
 */

// BM25 parameters
const K1 = 1.5; // Term frequency saturation (1.2-2.0 typical)
const B = 0.75; // Length normalization factor (0 = no normalization, 1 = full)

/** Normalize and tokenize a string */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_\-./]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Count term occurrences in text */
function termFrequency(tokens: string[], term: string): number {
  return tokens.filter((t) => t === term || t.includes(term)).length;
}

/**
 * Pre-compute IDF values for query terms across the corpus.
 * IDF = log((N - n + 0.5) / (n + 0.5) + 1) where N = total docs, n = docs containing term
 */
function computeIDF(
  chunks: Chunk[],
  queryTokens: string[]
): Map<string, number> {
  const N = chunks.length;
  const idf = new Map<string, number>();

  for (const term of queryTokens) {
    let docCount = 0;
    for (const chunk of chunks) {
      const text = (chunk.content + " " + chunk.section).toLowerCase();
      if (text.includes(term)) {
        docCount++;
      }
    }
    // BM25 IDF formula
    const val = Math.log((N - docCount + 0.5) / (docCount + 0.5) + 1);
    idf.set(term, val);
  }

  return idf;
}

/**
 * Score a chunk against query tokens using BM25.
 */
function bm25Score(
  chunk: Chunk,
  queryTokens: string[],
  idf: Map<string, number>,
  avgDl: number
): number {
  const text = (chunk.content + " " + chunk.section).toLowerCase();
  const docTokens = tokenize(text);
  const dl = docTokens.length;
  let score = 0;

  for (const term of queryTokens) {
    const tf = termFrequency(docTokens, term);
    if (tf === 0) continue;

    const termIdf = idf.get(term) || 0;
    // BM25 TF component: tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgDl))
    const tfNorm =
      (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (dl / avgDl)));
    score += termIdf * tfNorm;
  }

  // Bonus for matching multiple distinct query terms (proximity signal)
  const distinctMatches = queryTokens.filter((t) => text.includes(t)).length;
  if (distinctMatches > 1) {
    score *= 1 + distinctMatches * 0.15;
  }

  return score;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SearchResult {
  chunk: Chunk;
  score: number;
}

/**
 * Search chunks by BM25 keyword relevance.
 * Returns top-k results sorted by score descending.
 */
export function searchChunks(
  chunks: Chunk[],
  query: string,
  topK: number = 10
): SearchResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Pre-compute IDF and average document length
  const idf = computeIDF(chunks, queryTokens);
  const avgDl =
    chunks.reduce((sum, c) => {
      return sum + tokenize((c.content + " " + c.section).toLowerCase()).length;
    }, 0) / Math.max(chunks.length, 1);

  const scored: SearchResult[] = [];

  for (const chunk of chunks) {
    const score = bm25Score(chunk, queryTokens, idf, avgDl);
    if (score > 0) {
      scored.push({ chunk, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

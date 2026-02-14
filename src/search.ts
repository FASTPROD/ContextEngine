import { Chunk } from "./ingest.js";

/**
 * Simple TF-IDF-ish keyword search over chunks.
 * Fast, zero-dependency — good enough for v1.
 * Will be replaced by vector embeddings in step 3.
 */

/** Normalize and tokenize a string */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_\-./]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Score a chunk against a query using term overlap */
function scoreChunk(chunk: Chunk, queryTokens: string[]): number {
  const contentLower = (chunk.content + " " + chunk.section).toLowerCase();
  let score = 0;

  for (const token of queryTokens) {
    // Exact word boundary match scores higher
    const regex = new RegExp(`\\b${escapeRegex(token)}\\b`, "gi");
    const matches = contentLower.match(regex);
    if (matches) {
      score += matches.length * 2;
    }
    // Partial/substring match
    else if (contentLower.includes(token)) {
      score += 1;
    }
  }

  // Bonus for matching multiple distinct query terms
  const distinctMatches = queryTokens.filter((t) =>
    contentLower.includes(t)
  ).length;
  if (distinctMatches > 1) {
    score += distinctMatches * 3;
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
 * Search chunks by keyword relevance.
 * Returns top-k results sorted by score descending.
 */
export function searchChunks(
  chunks: Chunk[],
  query: string,
  topK: number = 10
): SearchResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scored: SearchResult[] = [];

  for (const chunk of chunks) {
    const score = scoreChunk(chunk, queryTokens);
    if (score > 0) {
      scored.push({ chunk, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

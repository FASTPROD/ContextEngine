import { describe, it, expect } from "vitest";
import { searchChunks, type SearchResult } from "../src/search.js";
import type { Chunk } from "../src/ingest.js";

function makeChunk(content: string, section: string = ""): Chunk {
  return {
    source: "test.md",
    section,
    content,
    lineStart: 1,
    lineEnd: 1,
  };
}

describe("searchChunks", () => {
  const chunks: Chunk[] = [
    makeChunk("Express rate limiting with express-rate-limit middleware", "## Security"),
    makeChunk("React components use JSX syntax for rendering UI elements", "## Frontend"),
    makeChunk("PostgreSQL database with connection pooling via pgBouncer", "## Database"),
    makeChunk("Docker containers orchestrated with docker-compose for local dev", "## DevOps"),
    makeChunk("ESLint configuration with TypeScript parser for code quality", "## Tooling"),
  ];

  it("returns empty array for empty query", () => {
    expect(searchChunks(chunks, "")).toEqual([]);
  });

  it("returns empty array for whitespace-only query", () => {
    expect(searchChunks(chunks, "   ")).toEqual([]);
  });

  it("finds relevant chunks by keyword", () => {
    const results = searchChunks(chunks, "docker");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.content).toContain("Docker");
  });

  it("ranks exact matches higher", () => {
    const results = searchChunks(chunks, "rate limiting express");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.content).toContain("rate limiting");
  });

  it("respects topK parameter", () => {
    const results = searchChunks(chunks, "docker express react", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns results with positive scores", () => {
    const results = searchChunks(chunks, "database");
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("returns results sorted by score descending", () => {
    const results = searchChunks(chunks, "docker compose local");
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("handles no-match query gracefully", () => {
    const results = searchChunks(chunks, "xyzzyplugh");
    expect(results).toEqual([]);
  });

  it("handles empty chunks array", () => {
    const results = searchChunks([], "test query");
    expect(results).toEqual([]);
  });

  it("matches section headings too", () => {
    const results = searchChunks(chunks, "security");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.section).toContain("Security");
  });

  it("boosts multi-term matches", () => {
    // "docker compose" should score higher than just "docker" in a different chunk
    const twoTermChunks: Chunk[] = [
      makeChunk("Docker is great for containers", "## A"),
      makeChunk("Docker compose with local environment", "## B"),
    ];
    const results = searchChunks(twoTermChunks, "docker compose local");
    expect(results[0].chunk.content).toContain("compose");
  });
});

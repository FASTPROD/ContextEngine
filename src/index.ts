#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadSources, loadProjectDirs, loadConfig, KnowledgeSource } from "./config.js";
import { ingestSources, Chunk } from "./ingest.js";
import { searchChunks, SearchResult } from "./search.js";
import {
  initEmbeddings,
  embedChunks,
  vectorSearch,
  isEmbeddingsReady,
  EmbeddedChunk,
  VectorSearchResult,
} from "./embeddings.js";
import { collectProjectOps, collectSystemOps } from "./collectors.js";
import { readFileSync, existsSync, watch } from "fs";
import { basename } from "path";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let sources: KnowledgeSource[] = [];
let chunks: Chunk[] = [];
let embeddedChunks: EmbeddedChunk[] = [];

/**
 * (Re-)ingest all sources. Called at startup and on file changes.
 */
async function reindex(): Promise<void> {
  sources = loadSources();
  chunks = ingestSources(sources);

  // Collect operational data from project directories
  const config = loadConfig();
  if (config.collectOps !== false) {
    const projectDirs = loadProjectDirs();
    let opsChunks = 0;
    for (const dir of projectDirs) {
      const ops = collectProjectOps(dir.path, dir.name);
      chunks.push(...ops);
      opsChunks += ops.length;
    }
    if (opsChunks > 0) {
      console.error(
        `[ContextEngine] ⚙ Collected ${opsChunks} operational chunks from ${projectDirs.length} projects`
      );
    }
  }

  // Collect system-wide operational data
  if (config.collectSystemOps !== false) {
    const sysOps = collectSystemOps();
    if (sysOps.length > 0) {
      chunks.push(...sysOps);
      console.error(
        `[ContextEngine] 🖥 Collected ${sysOps.length} system operational chunks`
      );
    }
  }

  if (isEmbeddingsReady()) {
    console.error(`[ContextEngine] 🧠 Re-embedding ${chunks.length} chunks...`);
    embeddedChunks = await embedChunks(chunks);
  }
}

// ---------------------------------------------------------------------------
// Hybrid Search: combine keyword + vector scores
// ---------------------------------------------------------------------------
interface HybridResult {
  chunk: Chunk;
  keywordScore: number;
  vectorScore: number;
  combinedScore: number;
}

function hybridSearch(
  query: string,
  keywordResults: SearchResult[],
  vectorResults: VectorSearchResult[],
  topK: number
): HybridResult[] {
  const map = new Map<Chunk, HybridResult>();

  // Normalize keyword scores (max = 1.0)
  const maxKw = keywordResults.length > 0 ? keywordResults[0].score : 1;
  for (const r of keywordResults) {
    map.set(r.chunk, {
      chunk: r.chunk,
      keywordScore: r.score / maxKw,
      vectorScore: 0,
      combinedScore: 0,
    });
  }

  // Merge vector scores
  for (const r of vectorResults) {
    const existing = map.get(r.chunk);
    if (existing) {
      existing.vectorScore = r.score;
    } else {
      map.set(r.chunk, {
        chunk: r.chunk,
        keywordScore: 0,
        vectorScore: r.score,
        combinedScore: 0,
      });
    }
  }

  // Combined: 40% keyword + 60% semantic (semantic is better for natural language)
  for (const r of map.values()) {
    r.combinedScore = r.keywordScore * 0.4 + r.vectorScore * 0.6;
  }

  const results = Array.from(map.values());
  results.sort((a, b) => b.combinedScore - a.combinedScore);
  return results.slice(0, topK);
}

// ---------------------------------------------------------------------------
// File Watching
// ---------------------------------------------------------------------------
const watchers: ReturnType<typeof watch>[] = [];

function startWatching(): void {
  // Clean up old watchers
  for (const w of watchers) {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  }
  watchers.length = 0;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  for (const source of sources) {
    if (!existsSync(source.path)) continue;

    try {
      const w = watch(source.path, () => {
        // Debounce: wait 500ms after last change before re-indexing
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          console.error(
            `[ContextEngine] 📝 File changed: ${basename(source.path)} — re-indexing...`
          );
          await reindex();
          console.error(
            `[ContextEngine] ✅ Re-indexed: ${chunks.length} chunks from ${sources.length} sources`
          );
        }, 500);
      });
      watchers.push(w);
    } catch {
      // Can't watch this file (permission, network drive, etc.)
    }
  }

  console.error(
    `[ContextEngine] 👁 Watching ${watchers.length} source files for changes`
  );
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "ContextEngine",
  version: "1.9.40",
});

// ---------------------------------------------------------------------------
// Tool: search_context (hybrid: keyword + vector)
// ---------------------------------------------------------------------------
server.tool(
  "search_context",
  "Search across all indexed project knowledge (copilot-instructions, skills docs, runbooks, session docs). Uses hybrid keyword + semantic search. Returns the most relevant chunks with source file, section, and line numbers.",
  {
    query: z.string().describe("Natural language search query"),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(5)
      .describe("Number of results to return (default 5)"),
    mode: z
      .enum(["hybrid", "keyword", "semantic"])
      .default("hybrid")
      .describe("Search mode: hybrid (default), keyword-only, or semantic-only"),
  },
  async ({ query, top_k, mode }) => {
    let results: Array<{
      chunk: Chunk;
      score: number;
      label: string;
    }> = [];

    if (mode === "keyword" || mode === "hybrid") {
      const kwResults = searchChunks(chunks, query, top_k * 2);

      if (mode === "keyword" || !isEmbeddingsReady()) {
        results = kwResults.map((r) => ({
          chunk: r.chunk,
          score: r.score,
          label: "keyword",
        }));
      } else {
        // Hybrid
        const vecResults = await vectorSearch(query, embeddedChunks, top_k * 2);
        const hybrid = hybridSearch(query, kwResults, vecResults, top_k);
        results = hybrid.map((r) => ({
          chunk: r.chunk,
          score: r.combinedScore,
          label: `kw:${r.keywordScore.toFixed(2)} sem:${r.vectorScore.toFixed(2)}`,
        }));
      }
    } else if (mode === "semantic") {
      if (!isEmbeddingsReady()) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Semantic search unavailable — embeddings model not loaded. Use mode='keyword' or 'hybrid'.",
            },
          ],
          isError: true,
        };
      }
      const vecResults = await vectorSearch(query, embeddedChunks, top_k);
      results = vecResults.map((r) => ({
        chunk: r.chunk,
        score: r.score,
        label: "semantic",
      }));
    }

    results = results.slice(0, top_k);

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No results found for: "${query}"`,
          },
        ],
      };
    }

    const searchMode = isEmbeddingsReady() ? mode : "keyword (embeddings loading)";
    const text = [
      `Search: "${query}" | Mode: ${searchMode} | ${results.length} results`,
      "",
      ...results.map((r, i) =>
        [
          `--- Result ${i + 1} (${r.label}: ${r.score.toFixed(3)}) ---`,
          `Source: ${r.chunk.source}`,
          `Section: ${r.chunk.section}`,
          `Lines: ${r.chunk.lineStart}-${r.chunk.lineEnd}`,
          "",
          r.chunk.content,
        ].join("\n")
      ),
    ].join("\n\n");

    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: list_sources
// ---------------------------------------------------------------------------
server.tool(
  "list_sources",
  "List all knowledge sources indexed by ContextEngine, with their status (found/missing) and chunk counts.",
  {},
  async () => {
    const lines = sources.map((s) => {
      const exists = existsSync(s.path);
      const count = chunks.filter((c) => c.source === s.name).length;
      const embeddedCount = embeddedChunks.filter(
        (ec) => ec.chunk.source === s.name
      ).length;
      const status = exists
        ? `✅ ${count} chunks${embeddedCount > 0 ? ` (${embeddedCount} embedded)` : ""}`
        : "⚠ file not found";
      return `${s.name}: ${status}\n  ${s.path}`;
    });

    const embStatus = isEmbeddingsReady()
      ? `✅ ${embeddedChunks.length} vectors`
      : "⏳ loading...";

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `ContextEngine v1.9.40`,
            `Sources: ${sources.length} | Chunks: ${chunks.length} | Embeddings: ${embStatus}`,
            "",
            ...lines,
          ].join("\n"),
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: read_source
// ---------------------------------------------------------------------------
server.tool(
  "read_source",
  "Read the full content of a specific knowledge source by name.",
  {
    source_name: z
      .string()
      .describe("Name of the source (from list_sources output)"),
  },
  async ({ source_name }) => {
    const source = sources.find(
      (s) => s.name.toLowerCase() === source_name.toLowerCase()
    );
    if (!source) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Unknown source: "${source_name}". Use list_sources to see available sources.`,
          },
        ],
        isError: true,
      };
    }

    if (!existsSync(source.path)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Source file not found: ${source.path}`,
          },
        ],
        isError: true,
      };
    }

    const content = readFileSync(source.path, "utf-8");
    return {
      content: [
        {
          type: "text" as const,
          text: `# ${source.name}\n\n${content}`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: reindex
// ---------------------------------------------------------------------------
server.tool(
  "reindex",
  "Force a full re-index of all knowledge sources. Use after adding new files or changing contextengine.json.",
  {},
  async () => {
    await reindex();
    return {
      content: [
        {
          type: "text" as const,
          text: `Re-indexed: ${chunks.length} chunks from ${sources.length} sources. Embeddings: ${embeddedChunks.length} vectors.`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// MCP Resources: expose each source as a browsable resource
// ---------------------------------------------------------------------------
function registerResources(): void {
  // Static resources for each discovered source
  for (const source of sources) {
    if (!existsSync(source.path)) continue;

    const uri = `context://${encodeURIComponent(source.name)}`;

    server.resource(
      source.name,
      uri,
      {
        description: `Knowledge source: ${source.name}`,
        mimeType: "text/markdown",
      },
      async () => {
        const content = existsSync(source.path)
          ? readFileSync(source.path, "utf-8")
          : `Source file not found: ${source.path}`;

        return {
          contents: [
            {
              uri,
              mimeType: "text/markdown",
              text: content,
            },
          ],
        };
      }
    );
  }

  console.error(
    `[ContextEngine] 📚 Registered ${sources.length} MCP resources`
  );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  // 1. Ingest all sources (fast — keyword search available immediately)
  sources = loadSources();
  chunks = ingestSources(sources);

  // 1b. Collect operational data (git, deps, env, docker, pm2, etc.)
  const config = loadConfig();
  if (config.collectOps !== false) {
    const projectDirs = loadProjectDirs();
    let opsChunks = 0;
    for (const dir of projectDirs) {
      const ops = collectProjectOps(dir.path, dir.name);
      chunks.push(...ops);
      opsChunks += ops.length;
    }
    if (opsChunks > 0) {
      console.error(
        `[ContextEngine] ⚙ Collected ${opsChunks} operational chunks from ${projectDirs.length} projects`
      );
    }
  }
  if (config.collectSystemOps !== false) {
    const sysOps = collectSystemOps();
    if (sysOps.length > 0) {
      chunks.push(...sysOps);
      console.error(
        `[ContextEngine] 🖥 Collected ${sysOps.length} system operational chunks`
      );
    }
  }

  // 2. Register MCP resources
  registerResources();

  // 3. Connect MCP transport (server is usable with keyword search now)
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ContextEngine] 🚀 MCP server running on stdio (keyword search ready)");

  // 4. Load embeddings in background (non-blocking — semantic search becomes available when done)
  initEmbeddings().then(async (ready) => {
    if (ready) {
      console.error(
        `[ContextEngine] 🧠 Embedding ${chunks.length} chunks...`
      );
      embeddedChunks = await embedChunks(chunks);
      console.error(
        `[ContextEngine] ✅ Semantic search ready (${embeddedChunks.length} vectors)`
      );
    }
  });

  // 5. Start file watchers
  startWatching();
}

main().catch((err) => {
  console.error("[ContextEngine] Fatal:", err);
  process.exit(1);
});

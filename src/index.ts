#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadSources } from "./config.js";
import { ingestSources, Chunk } from "./ingest.js";
import { searchChunks } from "./search.js";
import { readFileSync, existsSync } from "fs";

// ---------------------------------------------------------------------------
// Boot: ingest all knowledge sources
// ---------------------------------------------------------------------------
const sources = loadSources();
const chunks: Chunk[] = ingestSources(sources);

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "ContextEngine",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Tool: search_context
// ---------------------------------------------------------------------------
server.tool(
  "search_context",
  "Search across all FASTPROD project knowledge (copilot-instructions, SKILLS, session docs). Returns the most relevant chunks with source file, section, and line numbers.",
  {
    query: z.string().describe("Natural language search query"),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(5)
      .describe("Number of results to return (default 5)"),
  },
  async ({ query, top_k }) => {
    const results = searchChunks(chunks, query, top_k);

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

    const text = results
      .map((r, i) => {
        return [
          `--- Result ${i + 1} (score: ${r.score}) ---`,
          `Source: ${r.chunk.source}`,
          `Section: ${r.chunk.section}`,
          `Lines: ${r.chunk.lineStart}-${r.chunk.lineEnd}`,
          "",
          r.chunk.content,
        ].join("\n");
      })
      .join("\n\n");

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
      const status = exists ? `✅ ${count} chunks` : "⚠ file not found";
      return `${s.name}: ${status}\n  ${s.path}`;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `ContextEngine — ${chunks.length} total chunks from ${sources.length} sources`,
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
// Start
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ContextEngine] 🚀 MCP server running on stdio");
}

main().catch((err) => {
  console.error("[ContextEngine] Fatal:", err);
  process.exit(1);
});

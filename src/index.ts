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
import { loadCache, saveCache, clearCache } from "./cache.js";
import {
  listProjects,
  checkPorts,
  runComplianceAudit,
  formatProjectList,
  formatPortMap,
  formatPlan,
  scoreProject,
  formatScoreReport,
} from "./agents.js";
import {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  formatSession,
  formatSessionList,
} from "./sessions.js";
import { readFileSync, existsSync, watch } from "fs";
import { basename, join } from "path";
import { scanCodeDir } from "./code-chunker.js";

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

  // Scan code files if configured
  if (config.codeDirs && config.codeDirs.length > 0) {
    const projectDirs = loadProjectDirs();
    let codeChunks = 0;
    for (const dir of projectDirs) {
      for (const codeDir of config.codeDirs) {
        const codePath = join(dir.path, codeDir);
        if (existsSync(codePath)) {
          const codeResults = scanCodeDir(codePath, dir.name);
          chunks.push(...codeResults);
          codeChunks += codeResults.length;
        }
      }
    }
    if (codeChunks > 0) {
      console.error(
        `[ContextEngine] 💻 Parsed ${codeChunks} code chunks from source files`
      );
    }
  }

  if (isEmbeddingsReady()) {
    console.error(`[ContextEngine] 🧠 Re-embedding ${chunks.length} chunks...`);
    embeddedChunks = await embedChunks(chunks);
    saveCache(chunks, embeddedChunks);
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
  version: "1.9.44",
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
            `ContextEngine v1.9.43`,
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
// Tool: list_projects (Multi-Agent Phase 1)
// ---------------------------------------------------------------------------
server.tool(
  "list_projects",
  "Discover and analyze all projects in the workspace. Shows tech stack (framework, runtime, key dependencies), infrastructure (git, docker, pm2), and git remote status for each project.",
  {},
  async () => {
    const projectDirs = loadProjectDirs();
    const projects = listProjects(projectDirs);
    const text = formatProjectList(projects);
    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: check_ports (Multi-Agent Phase 1)
// ---------------------------------------------------------------------------
server.tool(
  "check_ports",
  "Scan all projects for port declarations (ecosystem.config.js, docker-compose.yml, .env, package.json) and detect port conflicts. Returns a port allocation map with conflict warnings.",
  {},
  async () => {
    const projectDirs = loadProjectDirs();
    const { ports, conflicts } = checkPorts(projectDirs);
    const text = formatPortMap(ports, conflicts);
    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: run_audit (Multi-Agent Phase 1 — Compliance Agent)
// ---------------------------------------------------------------------------
server.tool(
  "run_audit",
  "Run the Compliance Agent audit across all projects. Checks: port conflicts, git remotes (origin + gdrive), git hooks (post-commit auto-push), .env files (existence + gitignore), Docker config (restart policy, workdir), PM2 config (treekill, kill_timeout, no bash wrappers), version issues (EOL runtimes, outdated deps, MUI v4/v5 coexistence). Returns a structured plan with findings and remediation steps.",
  {
    scope: z
      .enum(["all", "compliance", "versions", "ports"])
      .default("all")
      .describe("Audit scope: all checks, compliance only, version checks only, or port conflicts only"),
  },
  async ({ scope }) => {
    const projectDirs = loadProjectDirs();
    const plan = runComplianceAudit(projectDirs);
    const text = formatPlan(plan);
    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: score_project (AI-Readiness Scoring)
// ---------------------------------------------------------------------------
server.tool(
  "score_project",
  "Score one or all projects on AI-readiness (0-100%). Checks documentation (copilot-instructions, README, CLAUDE.md, .cursorrules, SKILLS.md, .env.example), infrastructure (git, hooks, Docker, CI, deploy scripts, PM2), code quality (tests, TypeScript, linting, npm scripts), and security (.env gitignored, secrets exposure, lockfiles). Returns letter grade (A+ to F) with detailed breakdown.",
  {
    project: z
      .string()
      .optional()
      .describe("Project name to score. Omit to score all projects."),
  },
  async ({ project }) => {
    const projectDirs = loadProjectDirs();

    let scores;
    if (project) {
      const dir = projectDirs.find(
        (d) => d.name.toLowerCase() === project.toLowerCase()
      );
      if (!dir) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Project "${project}" not found. Available: ${projectDirs.map((d) => d.name).join(", ")}`,
            },
          ],
        };
      }
      scores = [scoreProject(dir)];
    } else {
      scores = projectDirs.map(scoreProject);
    }

    const text = formatScoreReport(scores);
    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: save_session (Session Persistence)
// ---------------------------------------------------------------------------
server.tool(
  "save_session",
  "Save a key-value entry to a named session. Use to persist decisions, context, plans, and findings between coding sessions. Each session can hold multiple keys (e.g., 'summary', 'active_tasks', 'decisions'). Keys are updated in place if they already exist.",
  {
    session: z
      .string()
      .describe("Session name (e.g., 'admin-crowlr-upgrade', 'compr-app-v2'). Will be created if it doesn't exist."),
    key: z
      .string()
      .describe("Entry key within the session (e.g., 'summary', 'active_tasks', 'decisions', 'blockers')"),
    value: z
      .string()
      .describe("Content to save — can be a summary, list of tasks, decisions, notes, code snippets, etc."),
  },
  async ({ session, key, value }) => {
    const result = saveSession(session, key, value);
    return {
      content: [
        {
          type: "text" as const,
          text: `✅ Saved key "${key}" to session "${session}" (${result.entries.length} entries total)`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: load_session (Session Persistence)
// ---------------------------------------------------------------------------
server.tool(
  "load_session",
  "Load a previously saved session by name. Returns all stored key-value entries with timestamps. Use at the start of a session to restore context from a previous conversation.",
  {
    session: z
      .string()
      .describe("Session name to load"),
  },
  async ({ session }) => {
    const result = loadSession(session);
    if (!result) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No session found with name "${session}". Use \`list_sessions\` to see available sessions.`,
          },
        ],
      };
    }
    const text = formatSession(result);
    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: list_sessions (Session Persistence)
// ---------------------------------------------------------------------------
server.tool(
  "list_sessions",
  "List all saved sessions. Shows session names, entry counts, and timestamps. Use to discover what context is available from previous conversations.",
  {},
  async () => {
    const sessions = listSessions();
    const text = formatSessionList(sessions);
    return {
      content: [{ type: "text" as const, text }],
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

  // 1c. Scan code files (TS/JS/Python) if configured
  if (config.codeDirs && config.codeDirs.length > 0) {
    const projectDirs = loadProjectDirs();
    let codeChunks = 0;
    for (const dir of projectDirs) {
      for (const codeDir of config.codeDirs) {
        const codePath = join(dir.path, codeDir);
        if (existsSync(codePath)) {
          const codeResults = scanCodeDir(codePath, dir.name);
          chunks.push(...codeResults);
          codeChunks += codeResults.length;
        }
      }
    }
    if (codeChunks > 0) {
      console.error(
        `[ContextEngine] 💻 Parsed ${codeChunks} code chunks from source files`
      );
    }
  }

  // 2. Register MCP resources
  registerResources();

  // 3. Connect MCP transport (server is usable with keyword search now)
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ContextEngine] 🚀 MCP server running on stdio (keyword search ready)");

  // 4. Load embeddings — try cache first, then model (non-blocking)
  const cached = loadCache(chunks);
  if (cached) {
    embeddedChunks = cached;
    console.error(
      `[ContextEngine] ✅ Semantic search ready from cache (${embeddedChunks.length} vectors)`
    );
  } else {
    initEmbeddings().then(async (ready) => {
      if (ready) {
        console.error(
          `[ContextEngine] 🧠 Embedding ${chunks.length} chunks...`
        );
        embeddedChunks = await embedChunks(chunks);
        saveCache(chunks, embeddedChunks);
        console.error(
          `[ContextEngine] ✅ Semantic search ready (${embeddedChunks.length} vectors)`
        );
      }
    });
  }

  // 5. Start file watchers
  startWatching();
}

main().catch((err) => {
  console.error("[ContextEngine] Fatal:", err);
  process.exit(1);
});

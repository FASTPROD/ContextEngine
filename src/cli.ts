#!/usr/bin/env node

/**
 * ContextEngine CLI — standalone tool access + MCP server.
 *
 * Usage:
 *   contextengine                     Start MCP server (stdio transport)
 *   contextengine init                Scaffold contextengine.json + copilot-instructions.md
 *   contextengine search <query>      Search across all indexed knowledge
 *   contextengine list-sources        Show all indexed sources with chunk counts
 *   contextengine list-projects       Discover and analyze all projects
 *   contextengine list-learnings      List all permanent learnings
 *   contextengine score [project]     AI-readiness score (one or all projects)
 *   contextengine audit               Run compliance audit across all projects
 *   contextengine help                Show this message
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { createInterface } from "readline";

// ---------------------------------------------------------------------------
// Detect project characteristics
// ---------------------------------------------------------------------------
interface ProjectDetection {
  language: string;
  framework: string | null;
  hasGit: boolean;
  hasGitHub: boolean;
  hasSrc: boolean;
  hasTests: boolean;
  projectName: string;
  suggestedCodeDirs: string[];
  suggestedPatterns: string[];
}

function detectProject(dir: string): ProjectDetection {
  const name = basename(dir);
  const result: ProjectDetection = {
    language: "unknown",
    framework: null,
    hasGit: existsSync(join(dir, ".git")),
    hasGitHub: existsSync(join(dir, ".github")),
    hasSrc: existsSync(join(dir, "src")),
    hasTests: false,
    projectName: name,
    suggestedCodeDirs: [],
    suggestedPatterns: [],
  };

  // Detect language + framework
  if (existsSync(join(dir, "package.json"))) {
    result.language = "javascript/typescript";
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf-8")
      );
      if (pkg.dependencies?.next || pkg.devDependencies?.next) result.framework = "Next.js";
      else if (pkg.dependencies?.react || pkg.devDependencies?.react) result.framework = "React";
      else if (pkg.dependencies?.vue || pkg.devDependencies?.vue) result.framework = "Vue";
      else if (pkg.dependencies?.express || pkg.devDependencies?.express) result.framework = "Express";
      else if (pkg.dependencies?.["@modelcontextprotocol/sdk"]) result.framework = "MCP";
    } catch { /* ignore */ }
  }
  if (existsSync(join(dir, "composer.json"))) result.language = "php";
  if (existsSync(join(dir, "Cargo.toml"))) result.language = "rust";
  if (existsSync(join(dir, "go.mod"))) result.language = "go";
  if (existsSync(join(dir, "requirements.txt")) || existsSync(join(dir, "pyproject.toml")))
    result.language = "python";

  // Detect framework specifics
  if (existsSync(join(dir, "artisan"))) result.framework = "Laravel";
  if (existsSync(join(dir, "manage.py"))) result.framework = "Django";
  if (existsSync(join(dir, "Gemfile"))) { result.language = "ruby"; result.framework = "Rails"; }
  if (existsSync(join(dir, "pubspec.yaml"))) { result.language = "dart"; result.framework = "Flutter"; }

  // Detect tests
  result.hasTests =
    existsSync(join(dir, "tests")) ||
    existsSync(join(dir, "test")) ||
    existsSync(join(dir, "__tests__")) ||
    existsSync(join(dir, "spec"));

  // Suggest code dirs
  for (const d of ["src", "app", "lib", "scripts"]) {
    if (existsSync(join(dir, d))) result.suggestedCodeDirs.push(d);
  }

  // Suggest patterns (always include these defaults)
  result.suggestedPatterns = [
    ".github/copilot-instructions.md",
    "CLAUDE.md",
    ".cursorrules",
    "AGENTS.md",
  ];

  return result;
}

// ---------------------------------------------------------------------------
// Template for copilot-instructions.md
// ---------------------------------------------------------------------------
function generateCopilotInstructions(det: ProjectDetection): string {
  const lines: string[] = [];
  lines.push(`# Copilot Instructions — ${det.projectName}\n`);
  lines.push("## Project Context");
  lines.push(`- **Language**: ${det.language}`);
  if (det.framework) lines.push(`- **Framework**: ${det.framework}`);
  lines.push(`- **Branch**: \`main\``);
  lines.push("");
  lines.push("## Architecture");
  lines.push("<!-- Describe your project architecture, key files, and data flow -->");
  lines.push("");
  lines.push("## Critical Rules");
  lines.push("1. <!-- Rule 1: e.g., ES Modules only, all imports use .js extension -->");
  lines.push("2. <!-- Rule 2: e.g., PHP 8.2 compatibility required -->");
  lines.push("3. <!-- Rule 3: e.g., Never modify production .env without permission -->");
  lines.push("");
  lines.push("## Key Files");
  lines.push("| File | Purpose |");
  lines.push("|------|---------|");
  lines.push("| <!-- path --> | <!-- description --> |");
  lines.push("");
  lines.push("## Related");
  lines.push("- <!-- Links to related projects, docs, or resources -->");
  lines.push("");
  lines.push("## End-of-Session Protocol");
  lines.push("Before ending ANY coding session, the AI agent MUST:");
  lines.push("1. Update this file (`copilot-instructions.md`) with any new rules, architecture changes, or version bumps");
  lines.push("2. Git commit + push all changed repositories");
  lines.push("3. <!-- Optional: Update SKILLS.md, session logs, or other tracking docs -->");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Template for contextengine.json
// ---------------------------------------------------------------------------
function generateConfig(det: ProjectDetection, cwd: string): object {
  const config: Record<string, unknown> = {
    sources: [],
    workspaces: [],
    patterns: det.suggestedPatterns,
  };

  // Add existing instruction files as explicit sources
  const existingFiles = [
    { path: ".github/copilot-instructions.md", name: `${det.projectName} — Copilot Instructions` },
    { path: "CLAUDE.md", name: `${det.projectName} — CLAUDE` },
    { path: ".cursorrules", name: `${det.projectName} — Cursor Rules` },
    { path: "AGENTS.md", name: `${det.projectName} — AGENTS` },
    { path: "README.md", name: `${det.projectName} — README` },
  ];

  const sources: Array<{ name: string; path: string }> = [];
  for (const f of existingFiles) {
    if (existsSync(join(cwd, f.path))) {
      sources.push({ name: f.name, path: f.path });
    }
  }
  config.sources = sources;

  if (det.suggestedCodeDirs.length > 0) {
    config.codeDirs = det.suggestedCodeDirs;
  }

  return config;
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------
function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function runInit(): Promise<void> {
  const cwd = process.cwd();
  console.log("\n🚀 ContextEngine Init\n");
  console.log(`Initializing in: ${cwd}\n`);

  // Detect project
  const det = detectProject(cwd);
  console.log(`  Detected: ${det.language}${det.framework ? ` (${det.framework})` : ""}`);
  console.log(`  Git: ${det.hasGit ? "✅" : "❌"}  GitHub: ${det.hasGitHub ? "✅" : "❌"}  Tests: ${det.hasTests ? "✅" : "❌"}`);
  if (det.suggestedCodeDirs.length > 0) {
    console.log(`  Code dirs: ${det.suggestedCodeDirs.join(", ")}`);
  }
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    // 1. contextengine.json
    const configPath = join(cwd, "contextengine.json");
    if (existsSync(configPath)) {
      console.log("  ⏭  contextengine.json already exists — skipping");
    } else {
      const createConfig = await ask(rl, "  Create contextengine.json? [Y/n] ");
      if (createConfig.toLowerCase() !== "n") {
        const config = generateConfig(det, cwd);
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        console.log("  ✅ Created contextengine.json");
      }
    }

    // 2. .github/copilot-instructions.md
    const copilotPath = join(cwd, ".github", "copilot-instructions.md");
    if (existsSync(copilotPath)) {
      console.log("  ⏭  .github/copilot-instructions.md already exists — skipping");
    } else {
      const createCopilot = await ask(rl, "  Create .github/copilot-instructions.md? [Y/n] ");
      if (createCopilot.toLowerCase() !== "n") {
        mkdirSync(join(cwd, ".github"), { recursive: true });
        writeFileSync(copilotPath, generateCopilotInstructions(det));
        console.log("  ✅ Created .github/copilot-instructions.md");
      }
    }

    // 3. Summary
    console.log("\n✨ Done! Next steps:");
    console.log("  1. Edit .github/copilot-instructions.md with your project details");
    console.log("  2. Edit contextengine.json to add explicit sources if needed");
    console.log("  3. Add ContextEngine to your MCP client config:");
    console.log(`     { "command": "npx", "args": ["contextengine"] }`);
    console.log("");
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// CLI Engine — shared initialization for all CLI subcommands
// ---------------------------------------------------------------------------

import { loadSources, loadProjectDirs, loadConfig, type KnowledgeSource } from "./config.js";
import { ingestSources, type Chunk } from "./ingest.js";
import { searchChunks } from "./search.js";
import { collectProjectOps, collectSystemOps } from "./collectors.js";
import { scanCodeDir } from "./code-chunker.js";
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
  listLearnings,
  learningsToChunks,
  formatLearnings,
} from "./learnings.js";

interface EngineState {
  sources: KnowledgeSource[];
  chunks: Chunk[];
}

/**
 * Initialize the engine (load sources, ingest, collect ops, learnings).
 * This is the same logic as index.ts main() but WITHOUT MCP server or embeddings.
 * Keyword search is instant and sufficient for CLI usage.
 */
async function initEngine(): Promise<EngineState> {
  const sources = loadSources();
  const chunks = ingestSources(sources);

  const config = loadConfig();

  // Collect operational data
  if (config.collectOps !== false) {
    const projectDirs = loadProjectDirs();
    for (const dir of projectDirs) {
      const ops = collectProjectOps(dir.path, dir.name);
      chunks.push(...ops);
    }
  }
  if (config.collectSystemOps !== false) {
    const sysOps = collectSystemOps();
    chunks.push(...sysOps);
  }

  // Scan code files
  if (config.codeDirs && config.codeDirs.length > 0) {
    const projectDirs = loadProjectDirs();
    for (const dir of projectDirs) {
      for (const codeDir of config.codeDirs) {
        const codePath = join(dir.path, codeDir);
        if (existsSync(codePath)) {
          const codeResults = scanCodeDir(codePath, dir.name);
          chunks.push(...codeResults);
        }
      }
    }
  }

  // Inject learnings
  const learningChunks = learningsToChunks();
  chunks.push(...learningChunks);

  return { sources, chunks };
}

// ---------------------------------------------------------------------------
// CLI Subcommands
// ---------------------------------------------------------------------------

async function cliSearch(query: string, topK: number): Promise<void> {
  const { chunks } = await initEngine();
  const results = searchChunks(chunks, query, topK);

  if (results.length === 0) {
    console.log(`No results found for: "${query}"`);
    return;
  }

  console.log(`\n🔍 Search: "${query}" | ${results.length} results (keyword/BM25)\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(`--- Result ${i + 1} (score: ${r.score.toFixed(3)}) ---`);
    console.log(`Source: ${r.chunk.source}`);
    console.log(`Section: ${r.chunk.section}`);
    console.log(`Lines: ${r.chunk.lineStart}-${r.chunk.lineEnd}`);
    console.log("");
    console.log(r.chunk.content);
    console.log("");
  }
}

async function cliListSources(): Promise<void> {
  const { sources, chunks } = await initEngine();

  console.log(`\n📚 ContextEngine — ${sources.length} sources | ${chunks.length} chunks\n`);

  for (const s of sources) {
    const exists = existsSync(s.path);
    const count = chunks.filter((c) => c.source === s.name).length;
    const status = exists ? `✅ ${count} chunks` : "⚠ file not found";
    console.log(`  ${s.name}: ${status}`);
    console.log(`    ${s.path}`);
  }
  console.log("");
}

async function cliListProjects(): Promise<void> {
  const projectDirs = loadProjectDirs();
  const projects = listProjects(projectDirs);
  const text = formatProjectList(projects);
  console.log(`\n${text}`);
}

async function cliListLearnings(category?: string): Promise<void> {
  const learnings = listLearnings(category);
  const text = formatLearnings(learnings);
  console.log(`\n${text}`);
}

async function cliScore(project?: string): Promise<void> {
  const projectDirs = loadProjectDirs();

  if (project) {
    const dir = projectDirs.find(
      (d) => d.name.toLowerCase() === project.toLowerCase()
    );
    if (!dir) {
      console.error(`❌ Project not found: "${project}"`);
      console.error(`Available: ${projectDirs.map((d) => d.name).join(", ")}`);
      process.exit(1);
    }
    const score = scoreProject(dir);
    const text = formatScoreReport([score]);
    console.log(`\n${text}`);
  } else {
    const scores = projectDirs.map((d) => scoreProject(d));
    const text = formatScoreReport(scores);
    console.log(`\n${text}`);
  }
}

async function cliAudit(): Promise<void> {
  const projectDirs = loadProjectDirs();
  const plan = runComplianceAudit(projectDirs);
  const text = formatPlan(plan);
  console.log(`\n${text}`);
}

// ---------------------------------------------------------------------------
// Main — route to init, CLI subcommand, or MCP server
// ---------------------------------------------------------------------------
const command = process.argv[2];

if (command === "init") {
  runInit().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "help" || command === "--help" || command === "-h") {
  console.log(`
ContextEngine — queryable knowledge base for AI coding agents

Usage:
  contextengine                        Start MCP server (stdio transport)
  contextengine init                   Scaffold contextengine.json + copilot-instructions.md
  contextengine search <query> [-n N]  Search indexed knowledge (default: top 5)
  contextengine list-sources           Show all indexed sources with chunk counts
  contextengine list-projects          Discover and analyze all projects
  contextengine list-learnings [cat]   List all learnings (optional: filter by category)
  contextengine score [project]        AI-readiness score (one or all projects)
  contextengine audit                  Run compliance audit across all projects
  contextengine help                   Show this message

Examples:
  npx @compr/contextengine-mcp search "docker nginx"
  npx @compr/contextengine-mcp score ContextEngine
  npx @compr/contextengine-mcp list-projects
  npx @compr/contextengine-mcp list-learnings security

Docs: https://github.com/FASTPROD/ContextEngine
npm:  https://www.npmjs.com/package/@compr/contextengine-mcp
`);
} else if (command === "search") {
  const queryParts: string[] = [];
  let topK = 5;
  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-n" || args[i] === "--top") && args[i + 1]) {
      topK = parseInt(args[i + 1], 10) || 5;
      i++; // skip next
    } else {
      queryParts.push(args[i]);
    }
  }
  const query = queryParts.join(" ");
  if (!query) {
    console.error("Usage: contextengine search <query> [-n N]");
    process.exit(1);
  }
  cliSearch(query, topK).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "list-sources") {
  cliListSources().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "list-projects") {
  cliListProjects().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "list-learnings") {
  const category = process.argv[3];
  cliListLearnings(category).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "score") {
  const project = process.argv[3];
  cliScore(project).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "audit") {
  cliAudit().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else {
  // Default: start MCP server
  import("./index.js");
}

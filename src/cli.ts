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
 *   contextengine save-learning        Save a learning (terminal fallback for MCP)
 *   contextengine score [project]     AI-readiness score (one or all projects)
 *   contextengine audit               Run compliance audit across all projects
 *   contextengine help                Show this message
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { createInterface } from "readline";
import { tmpdir } from "os";
import { execSync } from "child_process";

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
  generateScoreHTML,
  type ProjectScore,
} from "./agents.js";
import {
  listLearnings,
  learningsToChunks,
  formatLearnings,
  saveLearning,
  deleteLearning,
  LEARNING_CATEGORIES,
} from "./learnings.js";
import {
  activate,
  deactivate,
  getActivationStatus,
  gateCheck,
} from "./activation.js";

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
  const gate = gateCheck("list_projects");
  if (gate) { console.error(gate); process.exit(1); }
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

async function cliSaveLearning(args: string[]): Promise<void> {
  // Parse: save-learning "rule text" -c category [-p project] [--context "..."]
  let rule = "";
  let category = "";
  let project: string | undefined;
  let context = "";

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-c" || args[i] === "--category") && args[i + 1]) {
      category = args[++i];
    } else if ((args[i] === "-p" || args[i] === "--project") && args[i + 1]) {
      project = args[++i];
    } else if (args[i] === "--context" && args[i + 1]) {
      context = args[++i];
    } else if (!rule) {
      rule = args[i];
    } else {
      // Additional words become part of the rule if not quoted
      rule += " " + args[i];
    }
  }

  if (!rule || !category) {
    console.error("Usage: contextengine save-learning \"<rule text>\" -c <category> [-p project] [--context \"...\"]");
    console.error(`\nCategories: ${(LEARNING_CATEGORIES as readonly string[]).join(", ")}`);
    process.exit(1);
  }

  if (!(LEARNING_CATEGORIES as readonly string[]).includes(category)) {
    console.error(`❌ Invalid category: "${category}"`);
    console.error(`Valid: ${(LEARNING_CATEGORIES as readonly string[]).join(", ")}`);
    process.exit(1);
  }

  const learning = saveLearning(category, rule, context, project);
  console.log(`✅ Learning saved: ${learning.id}`);
  console.log(`   Category: ${learning.category}`);
  console.log(`   Rule:     ${learning.rule}`);
  if (learning.project) console.log(`   Project:  ${learning.project}`);
  if (learning.context) console.log(`   Context:  ${learning.context}`);
  console.log(`   Tags:     ${learning.tags.join(", ")}`);
}

async function cliDeleteLearning(id: string): Promise<void> {
  if (!id) {
    console.error("Usage: contextengine delete-learning <id>");
    process.exit(1);
  }
  const deleted = deleteLearning(id);
  if (deleted) {
    console.log(`✅ Learning ${id} deleted.`);
  } else {
    console.error(`❌ Learning not found: ${id}`);
    process.exit(1);
  }
}

async function cliScore(project?: string, html = false): Promise<void> {
  const gate = gateCheck("score_project");
  if (gate) { console.error(gate); process.exit(1); }
  const projectDirs = loadProjectDirs();

  let scores: ProjectScore[];
  if (project) {
    const dir = projectDirs.find(
      (d) => d.name.toLowerCase() === project.toLowerCase()
    );
    if (!dir) {
      console.error(`❌ Project not found: "${project}"`);
      console.error(`Available: ${projectDirs.map((d) => d.name).join(", ")}`);
      process.exit(1);
    }
    scores = [scoreProject(dir)];
  } else {
    scores = projectDirs.map((d) => scoreProject(d));
  }

  if (html) {
    const htmlContent = generateScoreHTML(scores);
    const tmpPath = join(tmpdir(), "contextengine-score.html");
    writeFileSync(tmpPath, htmlContent, "utf-8");
    console.log(`\n📊 HTML report written to: ${tmpPath}`);
    // Open in default browser
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try {
      execSync(`${openCmd} "${tmpPath}"`);
      console.log("🌐 Opened in browser\n");
    } catch {
      console.log(`Open manually: file://${tmpPath}\n`);
    }
  } else {
    const text = formatScoreReport(scores);
    console.log(`\n${text}`);
  }
}

async function cliAudit(): Promise<void> {
  const gate = gateCheck("run_audit");
  if (gate) { console.error(gate); process.exit(1); }
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
  contextengine list-projects          Discover and analyze all projects (Pro)
  contextengine list-learnings [cat]   List all learnings (optional: filter by category)
  contextengine save-learning <text> -c <category>  Save a learning (terminal fallback for MCP)
  contextengine delete-learning <id>   Delete a learning by ID
  contextengine score [project] [--html] AI-readiness score (Pro)
  contextengine audit                  Run compliance audit (Pro)
  contextengine activate <key> <email> Activate a Pro license
  contextengine deactivate             Remove license and premium modules
  contextengine status                 Show license status
  contextengine help                   Show this message

Examples:
  npx @compr/contextengine-mcp search "docker nginx"
  npx @compr/contextengine-mcp score ContextEngine
  npx @compr/contextengine-mcp score --html
  npx @compr/contextengine-mcp list-projects
  npx @compr/contextengine-mcp list-learnings security
  npx @compr/contextengine-mcp save-learning "Always pin better-sqlite3 on Debian Buster" -c deployment
  npx @compr/contextengine-mcp delete-learning abc123

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
} else if (command === "save-learning") {
  cliSaveLearning(process.argv.slice(3)).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "delete-learning") {
  const id = process.argv[3];
  cliDeleteLearning(id).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "score") {
  const args = process.argv.slice(3);
  const htmlFlag = args.includes("--html");
  const project = args.filter(a => !a.startsWith("--"))[0];
  cliScore(project, htmlFlag).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "audit") {
  cliAudit().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "activate") {
  const key = process.argv[3];
  const email = process.argv[4];
  if (!key || !email) {
    console.error("Usage: contextengine activate <license-key> <email>");
    console.error("Get a license: https://compr.ch/contextengine/pricing");
    process.exit(1);
  }
  activate(key, email).then((result) => {
    console.log(result.message);
    process.exit(result.success ? 0 : 1);
  }).catch((err) => {
    console.error("Activation error:", err);
    process.exit(1);
  });
} else if (command === "deactivate") {
  deactivate();
  console.log("✅ License removed. Premium features disabled.");
} else if (command === "status") {
  const status = getActivationStatus();
  console.log(`\n🔑 ContextEngine License Status\n`);
  console.log(`  Activated:     ${status.activated ? "✅ Yes" : "❌ No"}`);
  console.log(`  Plan:          ${status.plan}`);
  console.log(`  Expires:       ${status.expiresAt}`);
  console.log(`  Delta version: ${status.deltaVersion}`);
  console.log(`  Machine ID:    ${status.machineId}`);
  if (status.premiumTools.length > 0) {
    console.log(`\n  🔓 Premium tools: ${status.premiumTools.join(", ")}`);
  } else {
    console.log(`\n  🔒 Premium tools locked. Activate: contextengine activate <key> <email>`);
  }
  console.log("");
} else {
  // Default: start MCP server
  import("./index.js");
}

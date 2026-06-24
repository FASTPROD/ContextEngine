#!/usr/bin/env node

/**
 * ContextEngine CLI — standalone tool access + MCP server.
 *
 * Usage:
 *   contextengine                     Start MCP server (stdio transport)
 *   contextengine init                Scaffold project for ContextEngine (mcp.json, docs, hooks)
 *   contextengine search <query>      Search across all indexed knowledge
 *   contextengine list-sources        Show all indexed sources with chunk counts
 *   contextengine list-projects       Discover and analyze all projects
 *   contextengine list-learnings      List all permanent learnings
 *   contextengine save-learning        Save a learning (terminal fallback for MCP)
 *   contextengine score [project]     AI-readiness score (writes SCORE.md to each project)
 *   contextengine audit               Run compliance audit across all projects
 *   contextengine help                Show this message
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, basename, resolve } from "path";
import { createInterface } from "readline";
import { tmpdir, homedir } from "os";
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
// Template for SKILLS.md
// ---------------------------------------------------------------------------
function generateSkillsMd(det: ProjectDetection): string {
  const lines: string[] = [];
  lines.push(`# SKILLS.md — ${det.projectName}\n`);
  lines.push("## What This Agent Can Do");
  lines.push("<!-- List the key capabilities this project's AI agent should have -->");
  lines.push("");
  lines.push("## Key Patterns");
  lines.push("<!-- Document reusable patterns agents should follow -->");
  lines.push("");
  lines.push("## What NOT to Do");
  lines.push("<!-- Document anti-patterns and known pitfalls -->");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Template for SCORE.md
// ---------------------------------------------------------------------------
function generateScoreMd(det: ProjectDetection): string {
  const lines: string[] = [];
  lines.push(`# SCORE.md — ${det.projectName}\n`);
  lines.push("## AI-Readiness Score");
  lines.push("<!-- Run `contextengine score` to generate this section -->");
  lines.push("");
  lines.push("## History");
  lines.push(`| Date | Score | Notes |`);
  lines.push(`|------|-------|-------|`);
  lines.push(`| ${new Date().toISOString().split("T")[0]} | -- | Initial scaffold |`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Template for CLAUDE.md
// ---------------------------------------------------------------------------
function generateClaudeMd(det: ProjectDetection): string {
  const lines: string[] = [];
  lines.push(`# CLAUDE.md — ${det.projectName}\n`);
  lines.push("## What This Is");
  lines.push(`<!-- Brief description of ${det.projectName} -->`);
  lines.push("");
  lines.push("## Critical Rules");
  lines.push("");
  lines.push("1. <!-- Rule 1 -->");
  lines.push("2. <!-- Rule 2 -->");
  lines.push("");
  lines.push("## Key Commands");
  lines.push("```bash");
  if (det.language === "javascript/typescript") {
    lines.push("npm run build          # Compile");
    lines.push("npm test               # Run tests");
    lines.push("npm start              # Start");
  } else if (det.language === "python") {
    lines.push("python -m pytest       # Run tests");
    lines.push("python main.py         # Start");
  } else if (det.language === "php") {
    lines.push("composer install        # Install deps");
    lines.push("php artisan serve       # Start (Laravel)");
  } else {
    lines.push("# Add your key commands here");
  }
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Template for .vscode/mcp.json
// ---------------------------------------------------------------------------
function generateMcpJson(): object {
  // Detect absolute node path for nvm compatibility
  let nodePath = "node";
  try {
    nodePath = execSync("which node", { encoding: "utf-8" }).trim();
  } catch { /* fallback to bare node */ }

  // Detect npx path for the args
  let npxPath = "npx";
  try {
    npxPath = execSync("which npx", { encoding: "utf-8" }).trim();
  } catch { /* fallback to bare npx */ }

  return {
    servers: {
      contextengine: {
        type: "stdio",
        command: npxPath,
        args: ["-y", "@compr/contextengine-mcp"],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Template for pre-commit hook (CE doc freshness + secret scanner)
// ---------------------------------------------------------------------------
function generatePreCommitHook(): string {
  const lines: string[] = [];
  lines.push("#!/bin/zsh");
  lines.push("# ContextEngine — Pre-commit CE Compliance Check");
  lines.push("# Blocks commits when CE docs are stale (>4h) or missing.");
  lines.push("# Override: git commit --no-verify");
  lines.push("#");
  lines.push("# Checks: copilot-instructions.md, SKILLS.md, SCORE.md freshness");
  lines.push("# Also scans for accidentally committed secrets.");
  lines.push("");
  lines.push("violations=0");
  lines.push("");
  lines.push("# Check CE doc freshness (4 hours = 14400 seconds)");
  lines.push("now=$(date +%s)");
  lines.push("max_age=14400");
  lines.push("");
  lines.push('for candidate_path in ".github/copilot-instructions.md" "SKILLS.md" "SCORE.md"; do');
  lines.push('  if [[ -f "$candidate_path" ]]; then');
  lines.push('    mod=$(stat -f %m "$candidate_path" 2>/dev/null || stat -c %Y "$candidate_path" 2>/dev/null)');
  lines.push('    age=$((now - mod))');
  lines.push('    if (( age > max_age )); then');
  lines.push('      hours=$((age / 3600))');
  lines.push('      echo "⚠️  CE: $candidate_path — last updated ${hours}h ago (not in this commit)"');
  lines.push("      violations=$((violations + 1))");
  lines.push("    fi");
  lines.push("  fi");
  lines.push("done");
  lines.push("");
  lines.push("# Secret scanning — block known secret patterns in staged files");
  lines.push('secret_patterns=(');
  lines.push('  "sk_live_" "sk_test_" "pk_live_" "pk_test_"');
  lines.push('  "ghp_[A-Za-z0-9]" "glpat-[A-Za-z0-9]"');
  lines.push('  "gsk_[A-Za-z0-9]" "xoxb-" "xoxp-"');
  lines.push('  "AKIA[A-Z0-9]{16}" "SG\\.[A-Za-z0-9]"');
  lines.push('  "sshpass.*-p"');
  lines.push(")");
  lines.push("");
  lines.push("staged_files=$(git diff --cached --name-only --diff-filter=ACM)");
  lines.push('for file in $staged_files; do');
  lines.push('  # Skip known safe files');
  lines.push('  case "$file" in');
  lines.push('    .env|.env.*|.copilot-credentials.md|*/pre-commit*) continue ;;');
  lines.push("  esac");
  lines.push('  for pattern in "${secret_patterns[@]}"; do');
  lines.push('    if grep -qE "$pattern" "$file" 2>/dev/null; then');
  lines.push('      echo "🔴 SECRET DETECTED in $file (pattern: $pattern)"');
  lines.push("      violations=$((violations + 1))");
  lines.push("    fi");
  lines.push("  done");
  lines.push("done");
  lines.push("");
  lines.push("if (( violations > 0 )); then");
  lines.push('  echo ""');
  lines.push('  echo "╔═══════════════════════════════════════════════════════╗"');
  lines.push('  echo "║  ContextEngine: ${violations} CE compliance violation(s)          ║"');
  lines.push('  echo "║  Code changed but CE docs are stale or missing.      ║"');
  lines.push('  echo "║  Update: copilot-instructions, SKILLS, SCORE         ║"');
  lines.push('  echo "║                                                       ║"');
  lines.push('  echo "║  ❌ COMMIT BLOCKED — update docs first                ║"');
  lines.push('  echo "║  Override: git commit --no-verify                     ║"');
  lines.push('  echo "╚═══════════════════════════════════════════════════════╝"');
  lines.push('  echo ""');
  lines.push("  exit 1");
  lines.push("fi");
  lines.push("");
  lines.push("exit 0");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Template for post-commit hook (auto-push)
// ---------------------------------------------------------------------------
function generatePostCommitHook(): string {
  const lines: string[] = [];
  lines.push("#!/bin/zsh");
  lines.push("# ContextEngine — Post-commit auto-push");
  lines.push("# Pushes to origin (and gdrive if configured) in background.");
  lines.push("# Runs async so commits return instantly.");
  lines.push("");
  lines.push("(");
  lines.push('  git push origin "$(git branch --show-current)" 2>/dev/null &');
  lines.push('  git push gdrive "$(git branch --show-current)" 2>/dev/null &');
  lines.push("  wait");
  lines.push(") &");
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

  let created = 0;
  let skipped = 0;

  try {
    // -----------------------------------------------------------------------
    // Tier 1: Required — .vscode/mcp.json
    // -----------------------------------------------------------------------
    console.log("  📦 Tier 1: Required");

    const mcpPath = join(cwd, ".vscode", "mcp.json");
    if (existsSync(mcpPath)) {
      console.log("  ⏭  .vscode/mcp.json already exists — skipping");
      skipped++;
    } else {
      const answer = isNonInteractive ? "y" : await ask(rl, "  Create .vscode/mcp.json (MCP connectivity)? [Y/n] ");
      if (answer.toLowerCase() !== "n") {
        mkdirSync(join(cwd, ".vscode"), { recursive: true });
        writeFileSync(mcpPath, JSON.stringify(generateMcpJson(), null, 2) + "\n");
        console.log("  ✅ Created .vscode/mcp.json");
        created++;
      }
    }

    console.log("");

    // -----------------------------------------------------------------------
    // Tier 2: Strongly Recommended
    // -----------------------------------------------------------------------
    console.log("  📋 Tier 2: Strongly Recommended");

    // contextengine.json
    const configPath = join(cwd, "contextengine.json");
    if (existsSync(configPath)) {
      console.log("  ⏭  contextengine.json already exists — skipping");
      skipped++;
    } else {
      const createConfig = isNonInteractive ? "y" : await ask(rl, "  Create contextengine.json? [Y/n] ");
      if (createConfig.toLowerCase() !== "n") {
        const config = generateConfig(det, cwd);
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        console.log("  ✅ Created contextengine.json");
        created++;
      }
    }

    // .github/copilot-instructions.md
    const copilotPath = join(cwd, ".github", "copilot-instructions.md");
    if (existsSync(copilotPath)) {
      console.log("  ⏭  .github/copilot-instructions.md already exists — skipping");
      skipped++;
    } else {
      const createCopilot = isNonInteractive ? "y" : await ask(rl, "  Create .github/copilot-instructions.md? [Y/n] ");
      if (createCopilot.toLowerCase() !== "n") {
        mkdirSync(join(cwd, ".github"), { recursive: true });
        writeFileSync(copilotPath, generateCopilotInstructions(det));
        console.log("  ✅ Created .github/copilot-instructions.md");
        created++;
      }
    }

    // SKILLS.md
    const skillsPath = join(cwd, "SKILLS.md");
    if (existsSync(skillsPath)) {
      console.log("  ⏭  SKILLS.md already exists — skipping");
      skipped++;
    } else {
      const answer = isNonInteractive ? "y" : await ask(rl, "  Create SKILLS.md (agent skill tracking)? [Y/n] ");
      if (answer.toLowerCase() !== "n") {
        writeFileSync(skillsPath, generateSkillsMd(det));
        console.log("  ✅ Created SKILLS.md");
        created++;
      }
    }

    // SCORE.md
    const scorePath = join(cwd, "SCORE.md");
    if (existsSync(scorePath)) {
      console.log("  ⏭  SCORE.md already exists — skipping");
      skipped++;
    } else {
      const answer = isNonInteractive ? "y" : await ask(rl, "  Create SCORE.md (AI-readiness tracking)? [Y/n] ");
      if (answer.toLowerCase() !== "n") {
        writeFileSync(scorePath, generateScoreMd(det));
        console.log("  ✅ Created SCORE.md");
        created++;
      }
    }

    // Git hooks (only if .git exists)
    if (det.hasGit) {
      const hooksDir = join(cwd, ".git", "hooks");
      const preCommitDest = join(hooksDir, "pre-commit");
      const postCommitDest = join(hooksDir, "post-commit");

      if (existsSync(preCommitDest)) {
        console.log("  ⏭  .git/hooks/pre-commit already exists — skipping");
        skipped++;
      } else {
        const answer = isNonInteractive ? "y" : await ask(rl, "  Install pre-commit hook (doc freshness + secret scan)? [Y/n] ");
        if (answer.toLowerCase() !== "n") {
          mkdirSync(hooksDir, { recursive: true });
          writeFileSync(preCommitDest, generatePreCommitHook(), { mode: 0o755 });
          console.log("  ✅ Installed .git/hooks/pre-commit");
          created++;
        }
      }

      if (existsSync(postCommitDest)) {
        console.log("  ⏭  .git/hooks/post-commit already exists — skipping");
        skipped++;
      } else {
        const answer = isNonInteractive ? "y" : await ask(rl, "  Install post-commit hook (auto-push)? [Y/n] ");
        if (answer.toLowerCase() !== "n") {
          mkdirSync(hooksDir, { recursive: true });
          writeFileSync(postCommitDest, generatePostCommitHook(), { mode: 0o755 });
          console.log("  ✅ Installed .git/hooks/post-commit");
          created++;
        }
      }
    }

    console.log("");

    // -----------------------------------------------------------------------
    // Tier 3: Optional
    // -----------------------------------------------------------------------
    console.log("  💡 Tier 3: Optional");

    // CLAUDE.md
    const claudePath = join(cwd, "CLAUDE.md");
    if (existsSync(claudePath)) {
      console.log("  ⏭  CLAUDE.md already exists — skipping");
      skipped++;
    } else {
      const answer = isNonInteractive ? "y" : await ask(rl, "  Create CLAUDE.md (Claude-specific instructions)? [Y/n] ");
      if (answer.toLowerCase() !== "n") {
        writeFileSync(claudePath, generateClaudeMd(det));
        console.log("  ✅ Created CLAUDE.md");
        created++;
      }
    }

    // Summary
    console.log(`\n✨ Done! Created ${created} files, skipped ${skipped} (already exist).`);
    console.log("");
    console.log("  Next steps:");
    console.log("  1. Edit .github/copilot-instructions.md with your project details");
    console.log("  2. Start a Copilot chat — ContextEngine tools are now available");
    console.log("  3. Run `contextengine score` to get your AI-readiness baseline");
    console.log("");

    // Browser-capture nudge — fires once, never blocks init
    const extensionSecretPath = join(homedir(), ".contextengine", "extension-secret");
    if (!existsSync(extensionSecretPath)) {
      console.log("  💡 Next: run `opscontext init-extension-secret` to enable browser capture from Claude.ai and ChatGPT.");
      console.log("");
    }
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
  generateProjectScoreMD,
  type ProjectScore,
} from "./agents.js";
import {
  listLearnings,
  learningsToChunks,
  learningsStats,
  formatLearnings,
  saveLearning,
  deleteLearning,
  importLearningsFromFile,
  autoImportFromSources,
  LEARNING_CATEGORIES,
} from "./learnings.js";
import {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  formatSession,
  formatSessionList,
} from "./sessions.js";
import {
  activate,
  deactivate,
  getActivationStatus,
  gateCheck,
} from "./activation.js";
import {
  readAuditLog,
  verifyChain,
  filterByRange,
  toCsv,
} from "./audit.js";
import {
  loadRepoPolicy,
  parsePolicy,
  formatPolicySummary,
  formatValidationErrors,
  repoPolicyPath,
} from "./policy.js";
import {
  getStagedFiles,
  runSecretScan,
  runDocCoverage,
  formatSecretViolations,
  formatDocCoverageViolations,
  formatSecretViolationsJson,
  formatDocCoverageViolationsJson,
} from "./hooks.js";
import { safeAppend } from "./audit.js";
import {
  installSkill,
  locateBundledSkill,
  buildManagedBlock,
  syncClaudeMd,
  type SkillInstallScope,
} from "./claude-integration.js";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Non-interactive mode: skip prompts when piped or --yes flag
// ---------------------------------------------------------------------------
const isNonInteractive = !process.stdin.isTTY || process.argv.includes("--yes") || process.argv.includes("-y");

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
  const projectDirs = loadProjectDirs();

  // Collect operational data
  if (config.collectOps !== false) {
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

  // Inject learnings (project-scoped to prevent cross-project IP leakage)
  const projectNames = projectDirs.map((d) => d.name);
  const learningChunks = learningsToChunks(projectNames);
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
  // Project-scoped: only show learnings for workspace projects + universal
  const projectDirs = loadProjectDirs();
  const projectNames = projectDirs.map((d) => d.name);
  const learnings = listLearnings(category, projectNames);
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

async function cliScore(project?: string, html = false, save = true): Promise<void> {
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

  // Auto-write SCORE.md to each project root
  if (save) {
    for (const s of scores) {
      const scorePath = join(s.path, "SCORE.md");
      const md = generateProjectScoreMD(s);
      writeFileSync(scorePath, md, "utf-8");
      console.log(`📝 SCORE.md written to ${scorePath}`);
    }
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
// CLI: Session management
// ---------------------------------------------------------------------------

async function cliSaveSession(args: string[]): Promise<void> {
  // save-session <name> <key> <value>
  // or: save-session <name> <key> --stdin (reads value from stdin)
  let name = "";
  let key = "";
  let value = "";
  let fromStdin = false;

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stdin") {
      fromStdin = true;
    } else {
      positional.push(args[i]);
    }
  }

  name = positional[0] || "";
  key = positional[1] || "";
  value = positional.slice(2).join(" ");

  if (!name || !key) {
    console.error("Usage: contextengine save-session <name> <key> <value>");
    console.error("       contextengine save-session <name> <key> --stdin");
    console.error("\nExamples:");
    console.error('  contextengine save-session my-project summary "Fixed auth bug, deployed to staging"');
    console.error('  contextengine save-session my-project active_tasks "1. Deploy 2. Test 3. Monitor"');
    console.error('  cat notes.md | contextengine save-session my-project notes --stdin');
    process.exit(1);
  }

  if (fromStdin && !value) {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    value = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!value) {
    console.error("Error: No value provided. Pass as argument or use --stdin.");
    process.exit(1);
  }

  const session = saveSession(name, key, value);
  console.log(`✅ Session "${name}" updated — key "${key}" saved (${session.entries.length} total entries)`);
}

async function cliLoadSession(name: string): Promise<void> {
  if (!name) {
    console.error("Usage: contextengine load-session <name>");
    process.exit(1);
  }

  const session = loadSession(name);
  if (!session) {
    console.error(`❌ Session not found: "${name}"`);
    const sessions = listSessions();
    if (sessions.length > 0) {
      console.error(`\nAvailable sessions: ${sessions.map(s => s.name).join(", ")}`);
    }
    process.exit(1);
  }

  console.log(formatSession(session));
}

async function cliListSessions(): Promise<void> {
  const sessions = listSessions();
  console.log(`\n${formatSessionList(sessions)}`);
}

async function cliDeleteSession(name: string): Promise<void> {
  if (!name) {
    console.error("Usage: contextengine delete-session <name>");
    process.exit(1);
  }

  const ok = deleteSession(name);
  if (ok) {
    console.log(`✅ Deleted session "${name}".`);
    return;
  }

  console.error(`❌ Session not found: "${name}"`);
  const available = listSessions();
  if (available.length > 0) {
    console.error(`\nAvailable sessions: ${available.map((s) => s.name).join(", ")}`);
  }
  process.exit(1);
}

async function cliExportLearnings(args: string[]): Promise<void> {
  let project: string | undefined;
  let category: string | undefined;
  let format: "json" | "markdown" = "json";
  let universalToo = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--project" || a === "-p") && args[i + 1]) { project = args[++i]; continue; }
    if ((a === "--category" || a === "-c") && args[i + 1]) { category = args[++i]; continue; }
    if (a === "--format" && args[i + 1]) {
      const f = args[++i];
      if (f !== "json" && f !== "markdown") {
        console.error(`Unknown format: ${f}. Supported: json, markdown.`);
        process.exit(1);
      }
      format = f;
      continue;
    }
    if (a === "--include-universal") { universalToo = true; continue; }
    if (a === "-h" || a === "--help") {
      console.log(`Usage: contextengine export-learnings [--project NAME] [--category CAT] [--format json|markdown] [--include-universal]

Exports learnings as JSON or Markdown. Use --project to scope to a single
project's learnings (essential for consultants who share artifacts with
clients — the universal store mixes all projects together by default).

  --project NAME         Only learnings tagged with this project (case-insensitive)
  --category CAT         Only this category (deployment, security, etc.)
  --format json|markdown Output format (default: json)
  --include-universal    Also include unscoped learnings (project=undefined)
                         alongside the project-filtered ones

Cross-client confidentiality: without --project, this exports the FULL store.
Always use --project NAME when sharing exported learnings with anyone outside
the owning project's team.`);
      return;
    }
  }

  let all = listLearnings(category);

  if (project) {
    const lower = project.toLowerCase();
    all = all.filter((l) => {
      const matchProject = l.project && l.project.toLowerCase() === lower;
      const matchUniversal = universalToo && !l.project;
      return matchProject || matchUniversal;
    });
  }

  if (format === "markdown") {
    if (all.length === 0) {
      process.stdout.write(`# Learnings export\n\n_No learnings matched the filter._\n`);
      return;
    }
    const grouped: Record<string, typeof all> = {};
    for (const l of all) {
      (grouped[l.category] ||= []).push(l);
    }
    const scope = project
      ? `project ${project}${universalToo ? " + universal" : ""}`
      : "ALL projects (warning: cross-project IP)";
    process.stdout.write(`# Learnings export — ${scope}\n\n`);
    process.stdout.write(`_Exported ${all.length} learning(s) on ${new Date().toISOString()}_\n\n`);
    for (const cat of Object.keys(grouped).sort()) {
      process.stdout.write(`## ${cat}\n\n`);
      for (const l of grouped[cat]) {
        process.stdout.write(`### ${l.rule}\n\n`);
        if (l.context) process.stdout.write(`${l.context}\n\n`);
        if (l.project) process.stdout.write(`_Project: ${l.project} · Updated: ${l.updated}_\n\n`);
      }
    }
    return;
  }

  // JSON format
  const payload = {
    version: 1,
    exported_at: new Date().toISOString(),
    scope: project
      ? { project, include_universal: universalToo }
      : { project: null, include_universal: true },
    count: all.length,
    learnings: all,
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

async function cliAuditExport(args: string[]): Promise<void> {
  let since: string | undefined;
  let until: string | undefined;
  let format: "jsonl" | "csv" = "jsonl";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--since" && args[i + 1]) { since = args[++i]; continue; }
    if (a === "--until" && args[i + 1]) { until = args[++i]; continue; }
    if (a === "--format" && args[i + 1]) {
      const f = args[++i];
      if (f !== "jsonl" && f !== "csv") {
        console.error(`Unknown format: ${f}. Supported: jsonl, csv.`);
        process.exit(1);
      }
      format = f;
      continue;
    }
    if (a === "-h" || a === "--help") {
      console.log(`Usage: contextengine audit-export [--since ISO_DATE] [--until ISO_DATE] [--format jsonl|csv]\n\nExports the hash-chained audit log from ~/.contextengine/audit.log.\nCompliance use: produces evidence aligned with SOC 2 CC7.2 + ISO 27001 A.12.4.1\n(evidence artifacts — OpsContext is not itself certified; see docs/compliance/).`);
      return;
    }
  }

  let records;
  try {
    records = readAuditLog();
  } catch (e) {
    console.error(`Audit log unreadable: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const filtered = filterByRange(records, since, until);

  if (format === "csv") {
    process.stdout.write(toCsv(filtered) + "\n");
  } else {
    for (const r of filtered) process.stdout.write(JSON.stringify(r) + "\n");
  }
}

async function cliInstallSkill(args: string[]): Promise<void> {
  let scope: SkillInstallScope | undefined;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--global") { scope = "global"; continue; }
    if (a === "--project") { scope = "project"; continue; }
    if (a === "--force" || a === "-f") { force = true; continue; }
    if (a === "-h" || a === "--help") {
      console.log(`Usage: contextengine install-skill [--global | --project] [--force]

Copies the bundled OpsContext skill into Claude Code's skills directory so
Claude Code's native skills system discovers it.

  --global    Install at ~/.claude/skills/opscontext/   (recommended for personal use)
  --project   Install at <cwd>/.claude/skills/opscontext/   (per-repo opt-in)
  --force     Overwrite an existing installation

Default scope: --project if <cwd>/.claude/ exists, otherwise --global.

After installation, Claude Code surfaces the skill via its native skills
loading. MCP tools are discovered the normal way through .vscode/mcp.json
(or your client's MCP config).`);
      return;
    }
  }
  const distDir = fileURLToPath(new URL(".", import.meta.url));
  const bundled = locateBundledSkill(distDir);
  const result = installSkill(bundled, { scope, force });
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
  if (result.alreadyInstalled) {
    console.log("(Pass --force to overwrite.)");
  }
}

async function cliSyncClaudeMd(args: string[]): Promise<void> {
  let targetPath: string | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--path" && args[i + 1]) { targetPath = args[++i]; continue; }
    if (a === "--dry-run") { dryRun = true; continue; }
    if (a === "-h" || a === "--help") {
      console.log(`Usage: contextengine sync-claude-md [--path CLAUDE.md] [--dry-run]

Maintains a managed block inside CLAUDE.md with the OpsContext snapshot for
this project: top operational rules + active policy gates + recent hook
blocks from the audit log.

The block is delimited by:
  <!-- BEGIN: managed by OpsContext (...) -->
  ...
  <!-- END: managed by OpsContext -->

Run on every commit (or in a pre-commit hook) to keep the snapshot current.
Since Claude Code loads CLAUDE.md natively at every session start, the
snapshot reaches the agent's context without any MCP call.

  --path FILE   Target CLAUDE.md path (default: <cwd>/CLAUDE.md)
  --dry-run     Print the block to stdout, don't touch the file`);
      return;
    }
  }
  const cwd = process.cwd();
  const filePath = targetPath ? resolve(targetPath) : join(cwd, "CLAUDE.md");
  const projectName = basename(cwd);

  // Top learnings — scope to this project + universal
  const allLearnings = listLearnings(undefined, [projectName]);
  // Sort by updated desc and take 5; map to the slim shape
  const topLearnings = [...allLearnings]
    .sort((a, b) => (b.updated > a.updated ? 1 : -1))
    .slice(0, 5)
    .map((l) => ({ id: l.id, category: l.category, rule: l.rule, project: l.project }));

  // Policy summary
  const policyResult = loadRepoPolicy(cwd);
  let policySummary: Parameters<typeof buildManagedBlock>[0]["policySummary"] = null;
  if (policyResult && policyResult.ok) {
    const p = policyResult.policy;
    policySummary = {
      secretPatternCount: p.secret_patterns.length,
      secretPatternIds: p.secret_patterns.map((s) => s.id),
      docCoverageCount: p.doc_coverage.length,
      deployVerifyHostCount: p.deploy_verify_hosts.length,
      bypassTokenCount: p.bypass_tokens.length,
    };
  }

  // Recent hook.block events (last 3)
  let recentBlocks: Array<{ ts: string; check: string; reason: string }> = [];
  try {
    const all = readAuditLog();
    const blocks = all.filter((r) => r.event === "hook.block");
    recentBlocks = blocks.slice(-3).reverse().map((r) => ({
      ts: r.ts,
      check: String(r.payload.check ?? "unknown"),
      reason: shortBlockReason(r.payload),
    }));
  } catch {
    // Audit log unreadable or absent — skip silently; managed block omits the section
  }

  const block = buildManagedBlock({
    projectName,
    topLearnings,
    policySummary,
    recentBlocks,
    generatedAt: new Date().toISOString().slice(0, 19) + "Z",
  });

  if (dryRun) {
    process.stdout.write(block + "\n");
    return;
  }

  const result = syncClaudeMd(filePath, block);
  console.log(`✅ ${result.mode} — ${result.filePath} (${result.bytesWritten} bytes)`);
}

function shortBlockReason(payload: Record<string, unknown>): string {
  if (payload.pattern_id) return `secret pattern ${payload.pattern_id} at ${payload.file}:${payload.line}`;
  if (payload.matched_files) {
    const files = Array.isArray(payload.matched_files) ? payload.matched_files.join(", ") : "files";
    return `doc-coverage on ${files} → ${payload.requires_section ?? "?"} (${payload.reason ?? "?"})`;
  }
  return JSON.stringify(payload).slice(0, 120);
}

async function cliHook(args: string[]): Promise<void> {
  const sub = args[0];
  const jsonMode = process.env.CE_JSON === "1";

  if (!sub || sub === "-h" || sub === "--help") {
    console.log(`Usage: contextengine hook <kind>

Run policy-driven pre-commit checks against the staged git diff.

Subcommands:
  secret-scan    Apply policy.secret_patterns to added lines. Exit 1 on
                 any blocking violation, 0 otherwise. Warnings print but
                 don't fail.
  doc-coverage   For each policy.doc_coverage rule, check whether the
                 commit touches matching source paths AND the required
                 doc section is staged. Exit 1 on blocking violations.

Env:
  CE_JSON=1      Emit one-line JSON per check instead of human-readable
                 output (for CI logs). Exit codes unchanged.

Reads .contextengine/policy.json from the current git toplevel. If no
policy file exists, both checks exit 0 (no-op — the legacy hook layer
runs anyway).

Every blocking violation also appends a hook.block record to the
tamper-evident audit log at ~/.contextengine/audit.log.`);
    return;
  }

  // Find repo root via git
  let repoRoot: string;
  try {
    repoRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
    }).trim();
  } catch {
    console.error("Error: not inside a git repository.");
    process.exit(1);
  }

  const policyResult = loadRepoPolicy(repoRoot);
  if (policyResult === null) {
    // No policy file — no-op (legacy hooks still run inline patterns).
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ check: sub, skipped: "no_policy_file" }) + "\n");
    }
    return;
  }
  if (!policyResult.ok) {
    console.error(formatValidationErrors(policyResult.errors));
    console.error(`\nFix .contextengine/policy.json before commits will pass.`);
    process.exit(1);
  }
  const policy = policyResult.policy;

  let stagedFiles;
  try {
    stagedFiles = getStagedFiles(repoRoot);
  } catch (e) {
    console.error(`Error reading staged diff: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (stagedFiles.length === 0) return; // nothing to scan

  if (sub === "secret-scan") {
    const violations = runSecretScan(policy, stagedFiles);
    if (jsonMode) {
      process.stdout.write(formatSecretViolationsJson(violations) + "\n");
    } else {
      console.log(formatSecretViolations(violations));
    }
    const blocking = violations.filter((v) => v.severity === "block");
    for (const v of blocking) {
      safeAppend("hook.block", {
        check: "secret-scan",
        pattern_id: v.patternId,
        file: v.file,
        line: v.lineNumber,
      });
    }
    if (blocking.length > 0) process.exit(1);
    return;
  }

  if (sub === "doc-coverage") {
    const violations = runDocCoverage(policy, stagedFiles, repoRoot);
    if (jsonMode) {
      process.stdout.write(formatDocCoverageViolationsJson(violations) + "\n");
    } else {
      console.log(formatDocCoverageViolations(violations));
    }
    const blocking = violations.filter((v) => v.severity === "block");
    for (const v of blocking) {
      safeAppend("hook.block", {
        check: "doc-coverage",
        source_paths: v.sourcePaths,
        matched_files: v.matchedFiles,
        requires_section: v.requiresSection,
        reason: v.reason,
      });
    }
    if (blocking.length > 0) process.exit(1);
    return;
  }

  console.error(`Unknown hook subcommand: ${sub}. Try 'contextengine hook --help'.`);
  process.exit(1);
}

async function cliEmitEvent(args: string[]): Promise<void> {
  const { safeAppend } = await import("./audit.js");
  const help = args.includes("-h") || args.includes("--help");
  if (help || args.length < 2) {
    console.log(`Usage: contextengine emit-event <event-kind> <payload-json> [--actor NAME]

Appends a single event to the hash-chained audit log. Useful for VS Code
extensions, custom integrations, or scripted test scenarios.

  event-kind    One of: browser.* / vscode.* / cli.* / learning.* / etc.
  payload-json  A JSON object describing the event. Will be validated as
                a Record<string, unknown>.
  --actor NAME  Override the actor field. Defaults to 'cli'.

Examples:
  contextengine emit-event vscode.tool_call '{"tool":"Edit","args_preview":"file=src/x.ts"}'
  contextengine emit-event browser.prompt   '{"surface":"claude.ai","text":"hello","char_count":5}' --actor browser-ext

The event becomes a regular audit-chain record (prev_hash + hash added by
safeAppend), visible via 'contextengine audit-verify' and consumed by the
'contextengine watch' detector + 'drift_status' MCP tool.`);
    process.exit(help ? 0 : 1);
  }

  const eventKind = args[0];
  const payloadJson = args[1];
  let actor = "cli";
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--actor" && args[i + 1]) actor = args[++i];
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(payloadJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("payload must be a JSON object (not array, not primitive)");
    }
    payload = parsed as Record<string, unknown>;
  } catch (e) {
    console.error(`Bad payload JSON: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // Cast — the audit module accepts any string for the event field; the
  // AuditEvent union is documentation, not enforcement. Validation of
  // "what's a valid event kind" is the caller's responsibility (the HTTP
  // server enforces a prefix allow-list; this CLI is trusted).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  safeAppend(eventKind as any, payload, actor);
  console.log(`✅ Appended ${eventKind} to audit log.`);
}

async function cliWatch(args: string[]): Promise<void> {
  const { watchAuditLog, detect } = await import("./detector.js");
  let jsonMode = false;
  let once = false;
  let minSeverity: "info" | "warn" | "critical" = "info";
  let windowSeconds = 300;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") jsonMode = true;
    else if (a === "--once") once = true;
    else if (a === "--severity" && args[i + 1]) {
      const sev = args[++i];
      if (sev !== "info" && sev !== "warn" && sev !== "critical") {
        console.error(`Unknown severity: ${sev}. Try info|warn|critical.`);
        process.exit(1);
      }
      minSeverity = sev;
    } else if (a === "--window" && args[i + 1]) {
      windowSeconds = parseInt(args[++i], 10) || 300;
    } else if (a === "-h" || a === "--help") {
      console.log(`Usage: contextengine watch [--json] [--severity info|warn|critical] [--once] [--window SECONDS]

Streams drift / hallucination / loop / stuck-tool / context-bloat alerts as
they're detected in ~/.contextengine/audit.log.

  --json              One line of NDJSON per alert (for log aggregators / jq).
  --severity X        Floor filter. Default: info (everything).
  --once              Run a single scan over the recent window and exit.
                      Good for cron / health checks.
  --window SECONDS    How far back to scan in --once mode. Default: 300.

Exit codes:
  0   clean (or --once found no critical signals)
  2   --once found at least one critical signal — useful in CI pipelines

Signals also append a 'drift.detected' record to the audit log (hash-chained)
so the alerting itself is auditable.

Status-bar / OS-notification integration is via the VS Code extension —
this CLI is for terminal users, CI, and cron.`);
      return;
    }
  }

  const sevOrder = { info: 0, warn: 1, critical: 2 } as const;
  const passesFilter = (s: { severity: keyof typeof sevOrder }) =>
    sevOrder[s.severity] >= sevOrder[minSeverity];

  const fmt = (s: import("./detector.js").DriftSignal): string => {
    if (jsonMode) {
      return JSON.stringify({
        ts: new Date(s.detectedAt).toISOString(),
        kind: s.kind,
        severity: s.severity,
        reason: s.reason,
        payload: s.payload,
      });
    }
    const sev = s.severity === "critical" ? "CRIT " : s.severity === "warn" ? "WARN " : "INFO ";
    const t = new Date(s.detectedAt).toISOString().slice(11, 19);
    return `[${t}] ${sev} ${s.kind.padEnd(20)} ${s.reason}`;
  };

  if (once) {
    const signals = detect({ windowSeconds }).filter(passesFilter);
    for (const s of signals) {
      console.log(fmt(s));
    }
    const hasCritical = signals.some((s) => s.severity === "critical");
    process.exit(hasCritical ? 2 : 0);
  }

  if (!jsonMode) {
    console.error("[opscontext watch] streaming drift signals (Ctrl-C to exit)…");
  }
  const dispose = watchAuditLog(
    (s) => {
      if (passesFilter(s)) console.log(fmt(s));
    },
    { windowSeconds },
  );

  process.on("SIGINT", () => {
    dispose();
    if (!jsonMode) console.error("\n[opscontext watch] stopped.");
    process.exit(0);
  });
  // Keep alive — the watcher uses internal timers, but a stdin listener also
  // helps catch terminal closes.
  process.stdin.resume();
}

async function cliInitExtensionSecret(args: string[]): Promise<void> {
  const force = args.includes("--force") || args.includes("-f");
  const help = args.includes("-h") || args.includes("--help");
  if (help) {
    console.log(`Usage: contextengine init-extension-secret [--force]

Generates a 32-byte hex token at ~/.contextengine/extension-secret (mode 0600)
and prints it to stdout. The OpsContext browser extension reads the same
token from its options page; both sides must match for events to flow.

  --force, -f   Overwrite an existing secret. Default is to refuse if one
                already exists (prevents accidental rotation that would
                disconnect the extension until it's re-pasted).

After running, paste the printed value into the extension's Options page
(Cmd+Shift+P → "Open extension options" in Chrome, or click the extension
icon → Options).`);
    return;
  }

  const { randomBytes } = await import("crypto");
  const { writeFileSync, existsSync, chmodSync, mkdirSync } = await import("fs");
  const { join } = await import("path");
  const { homedir } = await import("os");

  const dir = join(homedir(), ".contextengine");
  const path = join(dir, "extension-secret");

  if (existsSync(path) && !force) {
    console.error(
      `❌ ${path} already exists. Re-running would invalidate any extension that already has the old value pasted in.\n` +
        `\n` +
        `   Pass --force to rotate (you'll need to re-paste the new value in the extension's Options page).\n` +
        `   Or read the current secret with: cat ${path}`,
    );
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(path, secret + "\n", { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }

  console.log(`✅ Wrote ${path} (mode 600)\n`);
  console.log(`Secret (paste this into the browser extension's Options page):\n`);
  console.log(`  ${secret}\n`);
  console.log(`Next steps:`);
  console.log(`  1. Open Chrome → chrome://extensions → Find "OpsContext Browser Capture"`);
  console.log(`  2. Click "Options" → paste the secret → Save`);
  console.log(`  3. Visit https://claude.ai or https://chatgpt.com — events will flow.`);
  console.log(`\nThe MCP server's event-ingest endpoint is at http://127.0.0.1:7842/events`);
  console.log(`(GET /health to verify it's running).`);
}

async function cliPolicy(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "-h" || sub === "--help") {
    console.log(`Usage: contextengine policy <subcommand>

Subcommands:
  validate <file>   Validate a policy.json file against the v1 schema.
                    Exit 0 on valid, exit 1 with field-level errors otherwise.
  show              Load and pretty-print the active repo policy
                    (.contextengine/policy.json in the current working tree).

The policy file is the declarative contract that replaces inline-bash hook
logic. Schema fields:
  - secret_patterns    Regex rules for the pre-commit secret scanner
  - doc_coverage       Source-subtree → doc-section coverage requirements
  - deploy_verify_hosts Hosts that require a verification probe post-push
  - bypass_tokens      Documented escape hatches with reason + TTL

Enforcement integration is shipping in the next sprint. This release
ships the schema + loader + validator + CLI so policies can be authored,
reviewed, and validated in PR ahead of the hook wiring.`);
    return;
  }

  if (sub === "validate") {
    const filePath = args[1];
    if (!filePath) {
      console.error("Usage: contextengine policy validate <file>");
      process.exit(1);
    }
    let contents: string;
    try {
      contents = readFileSync(filePath, "utf-8");
    } catch (e) {
      console.error(`Cannot read ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    const result = parsePolicy(contents);
    if (!result.ok) {
      console.error(formatValidationErrors(result.errors));
      process.exit(1);
    }
    console.log(`✅ Policy valid (v${result.policy.version}).`);
    console.log(formatPolicySummary(result.policy));
    return;
  }

  if (sub === "show") {
    const cwd = process.cwd();
    const result = loadRepoPolicy(cwd);
    if (result === null) {
      console.error(`No policy found at ${repoPolicyPath(cwd)}.`);
      console.error(`To create one, write a JSON file with at minimum:`);
      console.error(`  { "version": 1 }`);
      process.exit(1);
    }
    if (!result.ok) {
      console.error(formatValidationErrors(result.errors));
      process.exit(1);
    }
    console.log(formatPolicySummary(result.policy));
    return;
  }

  console.error(`Unknown subcommand: ${sub}. Try 'contextengine policy --help'.`);
  process.exit(1);
}

async function cliAuditVerify(): Promise<void> {
  const report = verifyChain();
  if (report.ok) {
    console.log(`✅ Audit chain verified — ${report.total} record(s), hash chain intact.`);
    return;
  }
  console.error(`❌ Audit chain BROKEN at index ${report.breakAtIndex} (of ${report.total}).`);
  console.error(`   Reason: ${report.breakReason}`);
  console.error(`\nA broken chain means the log was either edited after the fact, or a record was`);
  console.error(`partially written during a crash. For compliance-graded evidence, treat all`);
  console.error(`records from the break onward as unverified.`);
  process.exit(2);
}

async function cliEndSession(): Promise<void> {
  const projectDirs = loadProjectDirs();
  const checks: string[] = [];
  let passCount = 0;
  let failCount = 0;

  checks.push("═══════════════════════════════════════");
  checks.push("  ContextEngine — End-of-Session Checklist");
  checks.push("═══════════════════════════════════════\n");

  // --- Check 1: Uncommitted changes across all repos ---
  checks.push("## 1. Git Status\n");
  const reposChecked = new Set<string>();

  for (const dir of projectDirs) {
    try {
      const gitRoot = execSync("git rev-parse --show-toplevel", {
        cwd: dir.path, encoding: "utf-8", timeout: 5000,
      }).trim();

      if (reposChecked.has(gitRoot)) continue;
      reposChecked.add(gitRoot);

      const status = execSync("git status --porcelain", {
        cwd: gitRoot, encoding: "utf-8", timeout: 5000,
      }).trim();

      const repoName = basename(gitRoot);
      // Get current branch
      let branch = "unknown";
      try {
        branch = execSync("git branch --show-current", {
          cwd: gitRoot, encoding: "utf-8", timeout: 5000,
        }).trim();
      } catch { /* ignore */ }

      if (status) {
        const fileCount = status.split("\n").length;
        checks.push(`- ❌ FAIL — ${repoName} (${branch}) has ${fileCount} uncommitted file(s)`);
        const files = status.split("\n").slice(0, 5);
        for (const f of files) {
          checks.push(`  - ${f.trim()}`);
        }
        if (fileCount > 5) checks.push(`  - ... and ${fileCount - 5} more`);
        failCount++;
      } else {
        checks.push(`- ✅ PASS — ${repoName} (${branch}) — clean`);
        passCount++;
      }
    } catch {
      // Not a git repo
    }
  }

  // Also check common doc repos
  const home = process.env.HOME || "";
  const extraRepoPaths = [join(home, "FASTPROD")];
  for (const repoPath of extraRepoPaths) {
    if (!existsSync(repoPath) || reposChecked.has(repoPath)) continue;
    try {
      const gitRoot = execSync("git rev-parse --show-toplevel", {
        cwd: repoPath, encoding: "utf-8", timeout: 5000,
      }).trim();
      if (reposChecked.has(gitRoot)) continue;
      reposChecked.add(gitRoot);
      const status = execSync("git status --porcelain", {
        cwd: gitRoot, encoding: "utf-8", timeout: 5000,
      }).trim();
      const repoName = basename(gitRoot);
      if (status) {
        const fileCount = status.split("\n").length;
        checks.push(`- ❌ FAIL — ${repoName} has ${fileCount} uncommitted file(s)`);
        failCount++;
      } else {
        checks.push(`- ✅ PASS — ${repoName} is clean`);
        passCount++;
      }
    } catch { /* Not a git repo */ }
  }

  checks.push("");

  // --- Check 2: Documentation freshness ---
  checks.push("## 2. Documentation Freshness\n");
  const now = Date.now();
  const SESSION_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

  for (const dir of projectDirs) {
    const copilotPath = join(dir.path, ".github", "copilot-instructions.md");
    if (existsSync(copilotPath)) {
      const stat = statSync(copilotPath);
      const ageMs = now - stat.mtimeMs;
      if (ageMs < SESSION_THRESHOLD_MS) {
        const mins = Math.round(ageMs / 60000);
        checks.push(`- ✅ PASS — ${dir.name}/copilot-instructions.md updated ${mins}m ago`);
        passCount++;
      } else {
        const hours = Math.round(ageMs / 3600000);
        checks.push(`- ⚠️  STALE — ${dir.name}/copilot-instructions.md last modified ${hours}h ago`);
        failCount++;
      }
    } else {
      checks.push(`- ❌ MISSING — ${dir.name}/.github/copilot-instructions.md`);
      failCount++;
    }

    // Check SKILLS.md
    const skillsPath = join(dir.path, "SKILLS.md");
    if (existsSync(skillsPath)) {
      const stat = statSync(skillsPath);
      const ageMs = now - stat.mtimeMs;
      const hours = Math.round(ageMs / 3600000);
      if (ageMs < SESSION_THRESHOLD_MS) {
        checks.push(`- ✅ PASS — ${dir.name}/SKILLS.md updated ${Math.round(ageMs / 60000)}m ago`);
        passCount++;
      } else {
        checks.push(`- ⚠️  STALE — ${dir.name}/SKILLS.md last modified ${hours}h ago`);
        failCount++;
      }
    }

    // Check SCORE.md
    const scorePath = join(dir.path, "SCORE.md");
    if (existsSync(scorePath)) {
      checks.push(`- ✅ EXISTS — ${dir.name}/SCORE.md`);
      passCount++;
    }
  }

  // Check session doc
  const sessionDocPath = join(home, "FASTPROD", "docs", "CROWLR_COMPR_APPS_SESSION.md");
  if (existsSync(sessionDocPath)) {
    const stat = statSync(sessionDocPath);
    const ageMs = now - stat.mtimeMs;
    if (ageMs < SESSION_THRESHOLD_MS) {
      const mins = Math.round(ageMs / 60000);
      checks.push(`- ✅ PASS — SESSION.md updated ${mins}m ago`);
      passCount++;
    } else {
      const hours = Math.round(ageMs / 3600000);
      checks.push(`- ⚠️  STALE — SESSION.md last modified ${hours}h ago — append session summary`);
      failCount++;
    }
  }

  checks.push("");

  // --- Auto-import learnings from docs before checking stats ---
  const docSources = loadSources().map((s) => ({ path: s.path, name: s.name }));
  const autoImport = autoImportFromSources(docSources);
  if (autoImport.imported > 0) {
    checks.push(`📥 Auto-imported ${autoImport.imported} new learnings from ${autoImport.total} doc sources\n`);
  }

  // --- Check 3: Learnings Store ---
  checks.push("## 3. Learnings Store\n");
  const stats = learningsStats();
  checks.push(`- 📊 **${stats.total} learnings** across **${Object.keys(stats.categories).length} categories**`);
  // Show category breakdown
  const sortedCategories = Object.entries(stats.categories).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sortedCategories) {
    checks.push(`  - ${cat}: ${count}`);
  }

  // Show project-scoped count for current workspace
  const projectNames = projectDirs.map((d) => d.name);
  const scopedLearnings = listLearnings(undefined, projectNames);
  const otherCount = stats.total - scopedLearnings.length;
  checks.push(`- 🔒 **${scopedLearnings.length}** visible to current workspace (${otherCount} scoped to other projects)`);
  passCount++;

  checks.push("");

  // --- Check 4: Sessions ---
  checks.push("## 4. Sessions\n");
  const sessions = listSessions();
  if (sessions.length > 0) {
    checks.push(`- 📁 **${sessions.length} saved sessions**`);
    // Show 3 most recent
    const recent = sessions.slice(0, 3);
    for (const s of recent) {
      const age = Math.round((now - new Date(s.updated).getTime()) / 3600000);
      checks.push(`  - ${s.name} (${s.entries} entries, ${age}h ago)`);
    }
    if (sessions.length > 3) checks.push(`  - ... and ${sessions.length - 3} more`);
    passCount++;
  } else {
    checks.push(`- ⚠️  No sessions saved — run \`save_session\` before ending`);
    failCount++;
  }

  checks.push("");

  // --- Summary ---
  checks.push("═══════════════════════════════════════");
  checks.push("## Summary\n");
  const total = passCount + failCount;
  if (failCount === 0) {
    checks.push(`✅ ALL CLEAR — ${passCount}/${total} checks passed. Safe to end session.`);
  } else {
    checks.push(`⚠️  ${failCount} item(s) need attention — ${passCount}/${total} passed.`);
    checks.push("");
    checks.push("Before ending this session:");
    checks.push("1. Commit and push all uncommitted changes");
    checks.push("2. Update copilot-instructions.md with new facts");
    checks.push("3. Save session with `save_session`");
    checks.push("4. Save learnings with `save_learning` for each reusable pattern");
    checks.push("5. Run `contextengine end-session` again to verify");
  }

  console.log(checks.join("\n"));
  process.exit(failCount > 0 ? 1 : 0);
}

async function cliImportLearnings(args: string[]): Promise<void> {
  // import-learnings <file> [-c category] [-p project]
  let filePath = "";
  let category = "other";
  let project: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-c" || args[i] === "--category") && args[i + 1]) {
      category = args[++i];
    } else if ((args[i] === "-p" || args[i] === "--project") && args[i + 1]) {
      project = args[++i];
    } else if (!filePath) {
      filePath = args[i];
    }
  }

  if (!filePath) {
    console.error("Usage: contextengine import-learnings <file.md|file.json> [-c category] [-p project]");
    process.exit(1);
  }

  const result = importLearningsFromFile(filePath, category, project);
  console.log(`\n📥 Import Results:`);
  console.log(`   Imported: ${result.imported}`);
  console.log(`   Updated:  ${result.updated}`);
  console.log(`   Skipped:  ${result.skipped}`);
  if (result.errors.length > 0) {
    console.log(`   Errors:`);
    for (const err of result.errors) {
      console.log(`     - ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI: stats — show live session stats from MCP server
// ---------------------------------------------------------------------------

function cliStats(): void {
  const statsFile = join(homedir(), ".contextengine", "session-stats.json");
  if (!existsSync(statsFile)) {
    console.log("\n📊 No active session stats found.");
    console.log("   Stats are written by the MCP server during active sessions.");
    console.log("   Start a session with your AI agent to see stats here.\n");
    return;
  }

  try {
    const raw = readFileSync(statsFile, "utf-8");
    const stats = JSON.parse(raw);

    console.log("\n📊 ContextEngine Session Stats\n");
    console.log(`  ⏱  Uptime:           ${stats.uptimeMinutes ?? 0} min`);
    console.log(`  🔧 Tool calls:       ${stats.toolCalls ?? 0}`);
    console.log(`  🧠 Learnings saved:  ${stats.learningsSaved ?? 0}`);
    console.log(`  🔍 Search recalls:   ${stats.searchRecalls ?? 0} (learnings surfaced)`);
    console.log(`  📋 Nudges issued:    ${stats.nudgesIssued ?? 0}`);
    console.log(`  ⛔ Truncations:      ${stats.truncations ?? 0}`);
    console.log(`  💾 Session saved:    ${stats.sessionSaved ? "✅" : "❌"}`);
    console.log(`  ⏱  Time saved:       ~${stats.timeSavedMinutes ?? 0} min`);
    console.log(`  🕐 Started:          ${stats.startedAt ?? "unknown"}`);
    console.log(`  🔄 Last update:      ${stats.updatedAt ?? "unknown"}`);
    console.log("");
  } catch {
    console.error("Error reading session stats.");
  }
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
  contextengine init                   Scaffold project (mcp.json, docs, hooks, config)
  contextengine search <query> [-n N]  Search indexed knowledge (default: top 5)
  contextengine list-sources           Show all indexed sources with chunk counts
  contextengine list-projects          Discover and analyze all projects (Pro)
  contextengine list-learnings [cat]   List all learnings (optional: filter by category)
  contextengine save-learning <text> -c <category>  Save a learning
  contextengine delete-learning <id>   Delete a learning by ID
  contextengine import-learnings <file> [-c cat] [-p project]  Bulk-import learnings
  contextengine export-learnings [--project NAME] [--category CAT] [--format json|markdown] [--include-universal]
                                       Export learnings (scope to one project for safe sharing)
  contextengine save-session <name> <key> <value>   Save session context
  contextengine load-session <name>    Restore session context
  contextengine list-sessions          List all saved sessions
  contextengine delete-session <name>  Delete a saved session
  contextengine end-session            Pre-flight checklist (uncommitted changes, doc freshness)
  contextengine audit-export [--since DATE] [--until DATE] [--format jsonl|csv]
                                       Export hash-chained audit log (evidence aligned with
                                       SOC 2 CC7.2 + ISO 27001 A.12.4.1 — not a certification)
  contextengine audit-verify           Verify audit log chain integrity (tamper detection)
  contextengine policy <validate|show> [args]
                                       Author + validate the declarative .contextengine/policy.json
  contextengine init-extension-secret [--force]
                                       Generate ~/.contextengine/extension-secret for the browser ext
  contextengine install-autostart [--force]
                                       Install macOS LaunchAgent so MCP server auto-starts at login
                                       (uninstall-autostart / autostart-status — companion commands)
  contextengine install-claude-hook    Wire Claude Code terminal sessions into the OpsContext audit log
                                       (UserPromptSubmit + PostToolUse + SessionStart hook entries)
  contextengine watch [--json] [--severity info|warn|critical] [--once] [--window SECONDS]
                                       Stream drift / loop / stuck-tool / fabrication alerts from the audit log
  contextengine emit-event <kind> <payload-json> [--actor NAME]
                                       Append a single event to the audit log (for integrations / scripted tests)
  contextengine hook <secret-scan|doc-coverage>
                                       Run policy-driven pre-commit checks against staged diff
                                       (exit 1 on blocking violation; CE_JSON=1 for CI output)
  contextengine install-skill [--global | --project] [--force]
                                       Install bundled OpsContext skill into Claude Code's skills dir
  contextengine sync-claude-md [--path CLAUDE.md] [--dry-run]
                                       Refresh the OpsContext-managed block in CLAUDE.md
                                       (top learnings + policy summary + recent hook blocks)
  contextengine score [project] [--html] [--no-save] AI-readiness score (Pro, writes SCORE.md)
  contextengine audit                  Run compliance audit (Pro)
  contextengine activate <key> <email> Activate a Pro license
  contextengine deactivate             Remove license and premium modules
  contextengine stats                  Show live MCP session stats (value meter)
  contextengine status                 Show license status
  contextengine help                   Show this message

Flags:
  --yes, -y   Skip all interactive prompts (auto-accept defaults)

Examples:
  npx @compr/contextengine-mcp search "docker nginx"
  npx @compr/contextengine-mcp score ContextEngine
  npx @compr/contextengine-mcp score --html
  npx @compr/contextengine-mcp save-session my-project summary "Deployed v2, fixed auth"
  npx @compr/contextengine-mcp load-session my-project
  npx @compr/contextengine-mcp end-session
  npx @compr/contextengine-mcp import-learnings rules.md -c deployment
  npx @compr/contextengine-mcp init --yes
  echo "value" | npx @compr/contextengine-mcp save-session my-project notes --stdin

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
  const noSaveFlag = args.includes("--no-save");
  const project = args.filter(a => !a.startsWith("--"))[0];
  cliScore(project, htmlFlag, !noSaveFlag).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "audit") {
  cliAudit().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "save-session") {
  cliSaveSession(process.argv.slice(3)).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "load-session") {
  cliLoadSession(process.argv[3] || "").catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "list-sessions") {
  cliListSessions().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "delete-session") {
  cliDeleteSession(process.argv[3] || "").catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "export-learnings") {
  cliExportLearnings(process.argv.slice(3)).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "audit-export") {
  cliAuditExport(process.argv.slice(3)).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "policy") {
  cliPolicy(process.argv.slice(3)).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "hook") {
  cliHook(process.argv.slice(3)).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "install-skill") {
  cliInstallSkill(process.argv.slice(3)).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "sync-claude-md") {
  cliSyncClaudeMd(process.argv.slice(3)).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "audit-verify") {
  cliAuditVerify().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "end-session") {
  cliEndSession().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "import-learnings") {
  cliImportLearnings(process.argv.slice(3)).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "activate") {
  const key = process.argv[3];
  const email = process.argv[4];
  if (!key || !email) {
    console.error("Usage: contextengine activate <license-key> <email>");
    console.error("Get a license: https://api.compr.ch/contextengine/pricing");
    process.exit(1);
  }
  activate(key, email).then((result) => {
    console.log(result.message);
    process.exit(result.success ? 0 : 1);
  }).catch((err) => {
    console.error("Activation error:", err);
    process.exit(1);
  });
} else if (command === "emit-event") {
  cliEmitEvent(process.argv.slice(3)).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "watch") {
  cliWatch(process.argv.slice(3)).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "init-extension-secret") {
  cliInitExtensionSecret(process.argv.slice(3)).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else if (command === "install-autostart") {
  import("./install-autostart.js").then((m) =>
    m.cliInstallAutostart(process.argv.slice(3)),
  ).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (command === "uninstall-autostart") {
  import("./install-autostart.js").then((m) =>
    m.cliUninstallAutostart(process.argv.slice(3)),
  ).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (command === "autostart-status") {
  import("./install-autostart.js").then((m) =>
    m.cliAutostartStatus(process.argv.slice(3)),
  ).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (command === "install-claude-hook") {
  import("./install-claude-hook.js").then((m) =>
    m.cliInstallClaudeHook(process.argv.slice(3)),
  ).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (command === "uninstall-claude-hook") {
  import("./install-claude-hook.js").then((m) =>
    m.cliUninstallClaudeHook(process.argv.slice(3)),
  ).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (command === "stats") {
  cliStats();
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

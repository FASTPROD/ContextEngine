import { resolve, join, basename, dirname, sep } from "path";
import { homedir } from "os";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";

/**
 * A knowledge source that ContextEngine indexes.
 */
export interface KnowledgeSource {
  /** Human-readable label */
  name: string;
  /** Absolute path to the file */
  path: string;
  /** File type for parser selection */
  type: "markdown" | "code";
}

/**
 * A discovered project directory for operational data collection.
 */
export interface ProjectDirectory {
  /** Human-readable project name (directory basename) */
  name: string;
  /** Absolute path to the project root */
  path: string;
}

/**
 * User configuration loaded from contextengine.json
 */
export interface ContextEngineConfig {
  /** Explicit list of files to index */
  sources?: Array<{
    name: string;
    path: string;
  }>;
  /** Directories to scan for knowledge files */
  workspaces?: string[];
  /** File patterns to auto-discover within workspaces */
  patterns?: string[];
  /** Directories to scan for code files (TS/JS/Python) — e.g. ["src/"] relative to project root */
  codeDirs?: string[];
  /** Enable operational data collection (git, deps, env, etc.) — default true */
  collectOps?: boolean;
  /** Enable system-wide operational data (docker, pm2, nginx, cron, shell history) — default true */
  collectSystemOps?: boolean;
  /**
   * Plugin adapters — custom data source connectors.
   * Each adapter is an ES module that implements the Adapter interface.
   * @example [{ "name": "notion", "module": "./adapters/notion.js", "config": { "token": "$NOTION_TOKEN" } }]
   */
  adapters?: Array<{
    name: string;
    module: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  }>;
}

import { discoverClaudeMemory } from "./claude-integration.js";

const DEFAULT_PATTERNS = [
  // GitHub Copilot
  ".github/copilot-instructions.md",
  ".github/instructions/copilot-instructions.md",
  ".github/SKILLS.md",
  "SKILLS.md", // `contextengine init` writes SKILLS.md at the repo root — index both

  // Claude Code
  "CLAUDE.md",
  // Cursor
  ".cursorrules",
  ".cursor/rules",
  // Codex / multi-agent
  "AGENTS.md",
  // Context engineering
  "CONTEXT_MAP.md",
  // Learnings files: the only ordinary-looking docs the auto-import reads in full
  // ([LOCK] [AUTO-IMPORT-ONLY-MARKED-LEARNINGS] in learnings.ts)
  "AGENT-LEARNINGS.md",
  "docs/AGENT-LEARNINGS.md",
  "LEARNINGS.md",
  "docs/LEARNINGS.md",
];

/**
 * Look for contextengine.json in standard locations.
 * Priority: env var > CWD > home dir
 */
function findConfigFile(): string | null {
  const candidates: string[] = [];

  const envPath = process.env.CONTEXTENGINE_CONFIG;
  if (envPath) {
    candidates.push(resolve(envPath));
  }

  candidates.push(
    resolve(process.cwd(), "contextengine.json"),
    resolve(homedir(), ".contextengine.json")
  );

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Auto-discover knowledge files by scanning directories for known patterns.
 * Scans one level deep (each subdirectory = a project).
 */
function discoverSources(
  dirs: string[],
  patterns: string[]
): KnowledgeSource[] {
  const sources: KnowledgeSource[] = [];

  for (const dir of dirs) {
    const absDir = resolve(dir.replace(/^~/, homedir()));
    if (!existsSync(absDir)) continue;

    // Check patterns at this level
    for (const pattern of patterns) {
      const filePath = join(absDir, pattern);
      if (existsSync(filePath)) {
        const dirName = absDir.split("/").pop() || absDir;
        const fileName = pattern.split("/").pop() || pattern;
        sources.push({
          name: `${dirName} — ${fileName}`,
          path: filePath,
          type: "markdown",
        });
      }
    }

    // Scan one level deep (subdirectories = projects)
    try {
      for (const entry of readdirSync(absDir)) {
        if (entry.startsWith(".") || entry === "node_modules") continue;
        const subDir = join(absDir, entry);
        try {
          if (!statSync(subDir).isDirectory()) continue;
        } catch {
          continue;
        }
        for (const pattern of patterns) {
          const filePath = join(subDir, pattern);
          if (existsSync(filePath)) {
            const fileName = pattern.split("/").pop() || pattern;
            sources.push({
              name: `${entry} — ${fileName}`,
              path: filePath,
              type: "markdown",
            });
          }
        }
      }
    } catch {
      // Permission denied — skip
    }
  }

  return sources;
}

/**
 * Load knowledge sources.
 *
 * Resolution order:
 * 1. Config file (CONTEXTENGINE_CONFIG env, ./contextengine.json, ~/.contextengine.json)
 * 2. CONTEXTENGINE_WORKSPACES env var (colon-separated paths)
 * 3. Auto-discover from ~/Projects
 *
 * Claude Code auto-memory (~/.claude/projects/<slug>/memory/*.md) is added
 * to every resolution path unless OPSCONTEXT_SKIP_CLAUDE_MEMORY=1.
 */
export function loadSources(): KnowledgeSource[] {
  const configPath = findConfigFile();

  if (configPath) {
    console.error(`[ContextEngine] 📄 Config: ${configPath}`);
    const config: ContextEngineConfig = JSON.parse(
      readFileSync(configPath, "utf-8")
    );
    const sources: KnowledgeSource[] = [];

    // Explicit sources
    if (config.sources) {
      for (const s of config.sources) {
        const absPath = resolve(
          configPath,
          "..",
          s.path.replace(/^~/, homedir())
        );
        if (existsSync(absPath)) {
          sources.push({ name: s.name, path: absPath, type: "markdown" });
        } else {
          console.error(`[ContextEngine] ⚠ Not found: ${absPath}`);
        }
      }
    }

    // Workspace auto-discovery
    if (config.workspaces) {
      const patterns = config.patterns || DEFAULT_PATTERNS;
      const resolved = config.workspaces.map((w) =>
        resolve(configPath!, "..", w.replace(/^~/, homedir()))
      );
      sources.push(...discoverSources(resolved, patterns));
    }

    sources.push(...claudeMemorySources());
    return dedup(sources);
  }

  // Env var fallback
  const envWorkspaces = process.env.CONTEXTENGINE_WORKSPACES;
  if (envWorkspaces) {
    console.error(`[ContextEngine] 🔍 Discovering from CONTEXTENGINE_WORKSPACES`);
    const dirs = envWorkspaces.split(":").filter(Boolean);
    const found = discoverSources(dirs, DEFAULT_PATTERNS);
    return dedup([...found, ...claudeMemorySources()]);
  }

  // Auto-discover from ~/Projects
  const projectsDir = resolve(homedir(), "Projects");
  if (existsSync(projectsDir)) {
    console.error(`[ContextEngine] 🔍 Auto-discovering from ~/Projects`);
    const found = discoverSources([projectsDir], DEFAULT_PATTERNS);
    return dedup([...found, ...claudeMemorySources()]);
  }

  console.error(
    `[ContextEngine] ⚠ No sources found. Create contextengine.json or set CONTEXTENGINE_WORKSPACES.`
  );
  // Claude memory may still exist even without project workspaces — surface it.
  return claudeMemorySources();
}

/**
 * Pull Claude Code auto-memory into the source list (read-only). Skips when
 * OPSCONTEXT_SKIP_CLAUDE_MEMORY=1 (escape hatch for tests + air-gapped runs
 * where ~/.claude/ contents may not be indexable).
 */
function claudeMemorySources(): KnowledgeSource[] {
  if (process.env.OPSCONTEXT_SKIP_CLAUDE_MEMORY === "1") return [];
  try {
    return discoverClaudeMemory();
  } catch {
    return [];
  }
}

/** Remove duplicate paths */
function dedup(sources: KnowledgeSource[]): KnowledgeSource[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    if (seen.has(s.path)) return false;
    seen.add(s.path);
    return true;
  });
}

/**
 * Discover project directories from workspaces.
 * Returns one entry per top-level project found.
 */
export function loadProjectDirs(): ProjectDirectory[] {
  const configPath = findConfigFile();
  const dirs: ProjectDirectory[] = [];
  let workspaceDirs: string[] = [];

  if (configPath) {
    const config: ContextEngineConfig = JSON.parse(
      readFileSync(configPath, "utf-8")
    );
    if (config.collectOps === false) return []; // opted out
    if (config.workspaces) {
      workspaceDirs = config.workspaces.map((w) =>
        resolve(configPath!, "..", w.replace(/^~/, homedir()))
      );
    }
  }

  /**
   * 🔒 LOCKED [ENV-WORKSPACES-WINS] — 2026-08-16
   * ⛔ NEVER demote CONTEXTENGINE_WORKSPACES back to a fallback that only applies when the
   *    config file happens not to define `workspaces`.
   * WHY: it WAS such a fallback (`if (workspaceDirs.length === 0)`), so on any machine with a
   *      contextengine.json defining workspaces — which is the documented setup — the env var
   *      was read, ignored, and never reported. Every MCP config block we ship in
   *      skills/opscontext/SKILL.md sets `env: { CONTEXTENGINE_WORKSPACES: ... }`, so our own
   *      documented integration silently did nothing.
   *      Caught the hard way: an attempt to sandbox a review agent by pointing this variable at
   *      a scratch directory was ignored, and `score --all` wrote SCORE.md into 28 real
   *      repositories instead. The sandbox reported success because the variable was accepted
   *      without complaint — absence of an error read as confirmation.
   * FIX: standard precedence — an explicit env var beats a config file beats auto-discovery.
   *      It is set per-invocation and is therefore the most specific statement of intent.
   */
  const envWorkspaces = process.env.CONTEXTENGINE_WORKSPACES;
  if (envWorkspaces) {
    const fromEnv = envWorkspaces.split(":").filter(Boolean);
    if (fromEnv.length > 0) workspaceDirs = fromEnv;
  }

  // Auto-discover fallback
  if (workspaceDirs.length === 0) {
    const projectsDir = resolve(homedir(), "Projects");
    if (existsSync(projectsDir)) {
      workspaceDirs = [projectsDir];
    }
  }

  for (const wsDir of workspaceDirs) {
    const absDir = resolve(wsDir.replace(/^~/, homedir()));
    if (!existsSync(absDir)) continue;

    try {
      for (const entry of readdirSync(absDir)) {
        if (entry.startsWith(".") || entry === "node_modules") continue;
        const subDir = join(absDir, entry);
        try {
          if (!statSync(subDir).isDirectory()) continue;
        } catch {
          continue;
        }
        dirs.push({ name: entry, path: subDir });
      }
    } catch {
      // Permission denied — skip
    }
  }

  return dirs;
}

/**
 * Does this token look like a filesystem path rather than a bare project name?
 *
 * Deliberately conservative: only strings that CANNOT be a directory basename
 * (they contain a separator, or start with `~`/`.`) are treated as
 * path-only. Everything else stays eligible for name lookup first, so
 * `score KONIVE.com` keeps resolving exactly as it did before this existed.
 */
export function looksLikePath(token: string): boolean {
  return (
    token.includes("/") ||
    token.includes(sep) ||
    token.startsWith("~") ||
    token === "." ||
    token === ".."
  );
}

/**
 * 🔒 LOCKED [SCORE-ACCEPTS-PATH] — 2026-08-16
 * ⛔ NEVER narrow this back to `dirs.find(d => d.name === token)` alone.
 * WHY: `contextengine score /Users/yan/Projects/PLANK.io` failed with
 *      "Project not found: /Users/yan/Projects/PLANK.io" while listing PLANK.io
 *      among the available projects. A path is the natural first guess for a
 *      tool that prints absolute paths in its own output, and the error named
 *      the one thing the user had clearly just given it. The directory was
 *      never inspected — the lookup only ever compared basenames, so this was
 *      [ABSENCE-IS-NOT-A-VERDICT] at the argument-parsing layer: "not in my
 *      name index" was reported as "does not exist".
 * FIX: resolve names AND paths. A path that exists AND carries a project marker is a
 *      project, whether or not it sits under a configured workspace — that is what makes
 *      the tool usable outside `~/Projects`.
 *
 * 🔒 LOCKED [RESOLVE-PATH-MUST-BE-A-PROJECT] — 2026-08-16
 * ⛔ NEVER accept "it is a directory that exists" as proof that a path is a project, and
 *    NEVER let a bare name that missed the index fall through to path resolution.
 * WHY: the first cut did both, and an adversarial review reproduced three consequences.
 *      1. `cd ~/Projects && score .` wrote `~/Projects/SCORE.md` — "Projects: 27/100 (F),
 *         Not a git repo" — into the CONTAINER of 37 repositories. The identical command
 *         WITHOUT the `.` was correctly refused, so the guard existed and one entry point
 *         walked straight past it. Same for `score ~/Projects`, `score ..`, and `score /`.
 *      2. `score src`, `score dist`, `score docs` — a typo or a half-remembered name — no
 *         longer errored with "Available: …". The bare token fell through to
 *         `resolve(token)` against the cwd, so it silently scored a SUBDIRECTORY and wrote
 *         a SCORE.md into it. In this repo `score dist` writes `dist/SCORE.md`, which then
 *         ships inside the npm tarball.
 *      3. It made the sibling LOCK a half-truth: [SCORE-CWD-MUST-BE-A-PROJECT] promises a
 *         non-project is never scored, but enforced it on the no-argument path only.
 * FIX: a directory must carry a build/VCS marker to be scoreable, and a bare name resolves
 *      against the fleet index ONLY. Configured projects always pass — they are the fleet
 *      by definition. Absence of a marker is a measurement, not permission to write.
 */
const PROJECT_MARKERS = [
  ".git", "package.json", "pyproject.toml", "requirements.txt", "setup.py",
  "composer.json", "pubspec.yaml", "go.mod", "Cargo.toml", "Gemfile",
  "pom.xml", "build.gradle", "Makefile", "CMakeLists.txt",
];

/** Does this directory carry any build/VCS marker that makes it a project? */
export function hasProjectMarker(dir: string): boolean {
  return PROJECT_MARKERS.some((m) => existsSync(join(dir, m)));
}

export function resolveProjectDir(
  token: string,
  dirs: ProjectDirectory[]
): ProjectDirectory | null {
  // A bare name resolves against the fleet index ONLY. It must never silently
  // become a cwd-relative directory — that is how `score src` wrote src/SCORE.md
  // instead of printing "Project not found. Available: …". Use `./src` to mean a path.
  if (!looksLikePath(token)) {
    return (
      dirs.find((d) => d.name.toLowerCase() === token.toLowerCase()) ?? null
    );
  }

  // Path resolution — absolute, relative, or `~`-prefixed.
  const abs = resolve(token.replace(/^~/, homedir()));
  try {
    if (!statSync(abs).isDirectory()) return null;
  } catch {
    return null; // ENOENT / EACCES — not a usable directory.
  }

  // A configured project is a project by definition, marker or not.
  const known = dirs.find((d) => resolve(d.path) === abs);
  if (known) return known;

  // Otherwise it must look like a project. `~/Projects` and `/` do not.
  return hasProjectMarker(abs) ? { name: basename(abs), path: abs } : null;
}

/**
 * 🔒 LOCKED [SCORE-CWD-MUST-BE-A-PROJECT] — 2026-08-16
 * ⛔ NEVER fall back to returning `start` when no project marker is found. A directory
 *    that is not a project must produce null, and the caller must refuse to score it.
 * WHY: the first cut of this returned `start` on failure, reasoning that "an un-versioned
 *      directory is still scoreable — it just scores badly." That is exactly the
 *      absence-as-verdict mistake this codebase keeps relearning. Running `score` from
 *      `~/Projects` — a CONTAINER of 37 projects, not a project — walked to the filesystem
 *      root, found nothing, fell back, scored the container as though it were a project,
 *      and wrote `~/Projects/SCORE.md` claiming "Projects: 27/100 (F)". Run from `/` it
 *      would do the same to the filesystem root. "I cannot tell which project you mean" is
 *      an unknown, and the safe response to an unknown scope is to ask, never to write.
 * FIX: return null and let the caller error out with the three things the user can do
 *      instead (cd into a project, name one, or --all). Found by an adversarial review
 *      agent that ran the real CLI from `/` and `~/Projects`.
 *
 * 🔒 LOCKED [GIT-ROOT-IS-THE-PROJECT-BOUNDARY] — 2026-08-16
 * ⛔ NEVER return the nearest `package.json` directory without first checking whether a
 *    `.git` sits above it.
 * WHY: stopping at the nearest marker meant `cd ContextEngine/server && score` reported
 *      **"Scoring current project: server ... 32% (F) — Not a git repo, No CI pipeline,
 *      README.md Missing"** and wrote `server/SCORE.md`. Every one of those statements is
 *      false about the project the user is standing in: the repo root has `.git`, CI, and
 *      a README. A build file marks a *package*; `.git` marks the *project*. Reporting
 *      "Not a git repo" from inside a git repo is the scorer describing a boundary it
 *      invented — absence-as-verdict again, this time about where the project ends.
 * FIX: `.git` wins. Walk up looking for it, remembering the nearest build file on the way,
 *      and fall back to that remembered directory only if no `.git` exists anywhere above.
 *      A genuinely standalone package (no git anywhere) still resolves to itself.
 *
 * Walk up from `start` to the enclosing project root. Returns null when nothing is
 * found anywhere above `start`.
 */
const BUILD_FILE_MARKERS = [
  "package.json", "pyproject.toml", "requirements.txt", "setup.py",
  "composer.json", "pubspec.yaml", "go.mod", "Cargo.toml", "Gemfile",
  "pom.xml", "build.gradle", "Makefile", "CMakeLists.txt",
];

export function findProjectRoot(start: string): string | null {
  let dir = resolve(start);
  let nearestBuildFile: string | null = null;

  for (;;) {
    // .git is the project boundary and always wins, however far up it sits.
    if (existsSync(join(dir, ".git"))) return dir;

    if (
      nearestBuildFile === null &&
      BUILD_FILE_MARKERS.some((m) => existsSync(join(dir, m)))
    ) {
      nearestBuildFile = dir;
    }

    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // No .git anywhere above — a standalone package resolves to itself; a plain
  // directory (a container, or /) resolves to nothing at all.
  return nearestBuildFile;
}

/**
 * Load the raw config (for checking flags like collectSystemOps).
 */
export function loadConfig(): ContextEngineConfig {
  const configPath = findConfigFile();
  if (configPath) {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  }
  return {};
}

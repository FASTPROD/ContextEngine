import { resolve, join } from "path";
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
}

const DEFAULT_PATTERNS = [
  // GitHub Copilot
  ".github/copilot-instructions.md",
  ".github/SKILLS.md",
  // Claude Code
  "CLAUDE.md",
  // Cursor
  ".cursorrules",
  ".cursor/rules",
  // Codex / multi-agent
  "AGENTS.md",
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

    return dedup(sources);
  }

  // Env var fallback
  const envWorkspaces = process.env.CONTEXTENGINE_WORKSPACES;
  if (envWorkspaces) {
    console.error(`[ContextEngine] 🔍 Discovering from CONTEXTENGINE_WORKSPACES`);
    const dirs = envWorkspaces.split(":").filter(Boolean);
    return dedup(discoverSources(dirs, DEFAULT_PATTERNS));
  }

  // Auto-discover from ~/Projects
  const projectsDir = resolve(homedir(), "Projects");
  if (existsSync(projectsDir)) {
    console.error(`[ContextEngine] 🔍 Auto-discovering from ~/Projects`);
    return dedup(discoverSources([projectsDir], DEFAULT_PATTERNS));
  }

  console.error(
    `[ContextEngine] ⚠ No sources found. Create contextengine.json or set CONTEXTENGINE_WORKSPACES.`
  );
  return [];
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

  // Env var fallback
  if (workspaceDirs.length === 0) {
    const envWorkspaces = process.env.CONTEXTENGINE_WORKSPACES;
    if (envWorkspaces) {
      workspaceDirs = envWorkspaces.split(":").filter(Boolean);
    }
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
 * Load the raw config (for checking flags like collectSystemOps).
 */
export function loadConfig(): ContextEngineConfig {
  const configPath = findConfigFile();
  if (configPath) {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  }
  return {};
}

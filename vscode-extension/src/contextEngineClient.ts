/**
 * ContextEngine Client — executes CLI commands and parses output.
 *
 * The VS Code extension delegates to the ContextEngine CLI (`contextengine`)
 * rather than importing Node modules directly. This keeps the extension
 * lightweight and avoids bundling the full engine (embeddings, BM25, etc.).
 *
 * @module contextEngineClient
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  score: number;
  source: string;
  section: string;
  lines: string;
  content: string;
}

export interface SessionEntry {
  key: string;
  value: string;
  timestamp: string;
}

export interface EndSessionCheck {
  project: string;
  check: string;
  status: "PASS" | "FAIL";
  detail: string;
}

export interface GitProject {
  path: string;
  name: string;
  branch: string;
  dirty: number;
  uncommittedFiles: string[];
}

// ---------------------------------------------------------------------------
// CLI Resolution
// ---------------------------------------------------------------------------

let _cliPath: string | undefined;

/**
 * Find the contextengine CLI binary. Tries, in order:
 * 1. A workspace-local `node_modules/.bin/contextengine`
 * 2. The global `npx contextengine` path
 * 3. Falls back to `npx` as a wrapper
 */
export function resolveCLI(): string {
  if (_cliPath) return _cliPath;

  // Prefer workspace-local installation
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    for (const folder of workspaceFolders) {
      const localBin = vscode.Uri.joinPath(
        folder.uri,
        "node_modules",
        ".bin",
        "contextengine"
      ).fsPath;
      try {
        // Check if file exists synchronously — we're in a sync function
        const fs = require("fs");
        if (fs.existsSync(localBin)) {
          _cliPath = localBin;
          return _cliPath;
        }
      } catch {
        // continue
      }
    }
  }

  // Fall back to npx
  _cliPath = "npx";
  return _cliPath;
}

function buildCommand(): { cmd: string; baseArgs: string[] } {
  const cli = resolveCLI();
  if (cli === "npx") {
    return { cmd: "npx", baseArgs: ["--yes", "@compr/contextengine-mcp"] };
  }
  return { cmd: cli, baseArgs: [] };
}

// ---------------------------------------------------------------------------
// Command Execution
// ---------------------------------------------------------------------------

async function runCLI(
  args: string[],
  options?: { cwd?: string; timeout?: number }
): Promise<{ stdout: string; stderr: string }> {
  const { cmd, baseArgs } = buildCommand();
  const fullArgs = [...baseArgs, ...args];

  try {
    const result = await execFileAsync(cmd, fullArgs, {
      cwd: options?.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      timeout: options?.timeout || 30_000,
      maxBuffer: 1024 * 1024, // 1MB
      env: { ...process.env, NO_COLOR: "1" },
    });
    return result;
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    // Some CLI commands exit with non-zero on "FAIL" checks (e.g., end-session)
    if (err.stdout) {
      return { stdout: err.stdout || "", stderr: err.stderr || "" };
    }
    throw new Error(
      `ContextEngine CLI failed: ${err.message || "unknown error"}`
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search the ContextEngine knowledge base.
 */
export async function search(
  query: string,
  topK = 5
): Promise<SearchResult[]> {
  const { stdout } = await runCLI(["search", query, "-n", String(topK)]);
  return parseSearchResults(stdout);
}

/**
 * List all indexed knowledge sources.
 */
export async function listSources(): Promise<string> {
  const { stdout } = await runCLI(["list-sources"]);
  return stdout;
}

/**
 * List all saved sessions.
 */
export async function listSessions(): Promise<string> {
  const { stdout } = await runCLI(["list-sessions"]);
  return stdout;
}

/**
 * Load a session by name.
 */
export async function loadSession(name: string): Promise<string> {
  const { stdout } = await runCLI(["load-session", name]);
  return stdout;
}

/**
 * Save a key-value entry to a named session.
 */
export async function saveSession(
  name: string,
  key: string,
  value: string
): Promise<string> {
  const { stdout } = await runCLI(["save-session", name, key, value]);
  return stdout;
}

/**
 * Run the end-session checklist.
 * Returns structured check results.
 */
export async function endSession(): Promise<EndSessionCheck[]> {
  const { stdout } = await runCLI(["end-session", "--yes"], { timeout: 60_000 });
  return parseEndSessionResults(stdout);
}

/**
 * Save a learning.
 */
export async function saveLearning(
  rule: string,
  category: string,
  context?: string,
  project?: string
): Promise<string> {
  const args = ["save-learning", rule, "-c", category];
  if (context) args.push("--context", context);
  if (project) args.push("-p", project);
  const { stdout } = await runCLI(args);
  return stdout;
}

/**
 * List learnings, optionally filtered by category.
 */
export async function listLearnings(category?: string): Promise<string> {
  const args = ["list-learnings"];
  if (category) args.push("-c", category);
  const { stdout } = await runCLI(args);
  return stdout;
}

// ---------------------------------------------------------------------------
// Git Status (direct git commands — does NOT require ContextEngine CLI)
// ---------------------------------------------------------------------------

/**
 * Scan all workspace folders for git status.
 * Returns an array of projects with their dirty file counts.
 */
export async function scanGitStatus(): Promise<GitProject[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return [];

  const projects: GitProject[] = [];

  for (const folder of workspaceFolders) {
    try {
      const cwd = folder.uri.fsPath;

      // Get branch name
      const { stdout: branchOut } = await execFileAsync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd, timeout: 5000 }
      );
      const branch = branchOut.trim();

      // Get list of changed files (staged + unstaged + untracked)
      const { stdout: statusOut } = await execFileAsync(
        "git",
        ["status", "--porcelain"],
        { cwd, timeout: 5000 }
      );
      const lines = statusOut
        .split("\n")
        .filter((l) => l.trim().length > 0);

      const uncommittedFiles = lines.map((l) => l.substring(3).trim());

      projects.push({
        path: cwd,
        name: folder.name,
        branch,
        dirty: lines.length,
        uncommittedFiles,
      });
    } catch {
      // Not a git repo or git not available — skip silently
    }
  }

  return projects;
}

/**
 * Stage and commit all changes in a given project path.
 */
export async function gitCommitAll(
  projectPath: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await execFileAsync("git", ["add", "-A"], {
      cwd: projectPath,
      timeout: 10_000,
    });
    await execFileAsync("git", ["commit", "-m", message], {
      cwd: projectPath,
      timeout: 15_000,
    });
    return { success: true };
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    return {
      success: false,
      error: err.stderr || err.message || "Unknown error",
    };
  }
}

/**
 * Push to all remotes for a given project.
 */
export async function gitPush(
  projectPath: string
): Promise<{ remote: string; success: boolean; error?: string }[]> {
  const results: { remote: string; success: boolean; error?: string }[] = [];

  try {
    const { stdout: remotesOut } = await execFileAsync(
      "git",
      ["remote"],
      { cwd: projectPath, timeout: 5000 }
    );
    const remotes = remotesOut.split("\n").filter((r) => r.trim());

    // Get current branch
    const { stdout: branchOut } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: projectPath, timeout: 5000 }
    );
    const branch = branchOut.trim();

    for (const remote of remotes) {
      try {
        await execFileAsync(
          "git",
          ["push", remote, branch],
          { cwd: projectPath, timeout: 30_000 }
        );
        results.push({ remote, success: true });
      } catch (error: unknown) {
        const err = error as { stderr?: string; message?: string };
        results.push({
          remote,
          success: false,
          error: err.stderr || err.message || "Push failed",
        });
      }
    }
  } catch (error: unknown) {
    const err = error as { message?: string };
    results.push({
      remote: "unknown",
      success: false,
      error: err.message || "Failed to get remotes",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseSearchResults(stdout: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = stdout.split(/--- Result \d+/);

  for (const block of blocks) {
    if (!block.trim()) continue;

    const scoreMatch = block.match(/\(score:\s*([\d.]+)\)/);
    const sourceMatch = block.match(/Source:\s*(.+)/);
    const sectionMatch = block.match(/Section:\s*(.+)/);
    const linesMatch = block.match(/Lines:\s*(.+)/);

    if (scoreMatch && sourceMatch) {
      // Content is everything after the metadata lines
      const metaEnd = block.lastIndexOf("Lines:");
      const contentStart = metaEnd > -1 ? block.indexOf("\n", metaEnd) + 1 : 0;
      const content = block.substring(contentStart).trim();

      results.push({
        score: parseFloat(scoreMatch[1]),
        source: sourceMatch[1].trim(),
        section: sectionMatch?.[1]?.trim() || "",
        lines: linesMatch?.[1]?.trim() || "",
        content,
      });
    }
  }

  return results;
}

function parseEndSessionResults(stdout: string): EndSessionCheck[] {
  const checks: EndSessionCheck[] = [];
  const lines = stdout.split("\n");

  for (const line of lines) {
    const passMatch = line.match(/✅\s*PASS\s*[—–-]\s*(.+?):\s*(.+)/);
    const failMatch = line.match(/❌\s*FAIL\s*[—–-]\s*(.+?):\s*(.+)/);

    if (passMatch) {
      checks.push({
        project: "",
        check: passMatch[1].trim(),
        status: "PASS",
        detail: passMatch[2].trim(),
      });
    } else if (failMatch) {
      checks.push({
        project: "",
        check: failMatch[1].trim(),
        status: "FAIL",
        detail: failMatch[2].trim(),
      });
    }
  }

  return checks;
}

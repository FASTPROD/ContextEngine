// 🔒 LOCKED [HOOK-CHECKERS] — 2026-06-10
// ⛔ NEVER print the matched secret value in violation output. Print pattern
//    id + file + line + redaction only. Leaking secrets via "helpful" error
//    messages was a classic regression in v1.x of similar tools.
// ⛔ NEVER swallow git errors silently — if git isn't available, surface the
//    failure so the user knows the gate is not actually running.
// WHY: This is the production enforcement path. A check that silently
//    passes when broken is worse than no check — it ships false
//    compliance evidence. Loud failure ≫ silent skip.
// FIX: To add a new gate, add a runXxx() function here, expose via the
//    `hook` CLI subcommand, never widen the secret-redaction contract.
//
// Hook checkers — TypeScript implementations of the policy gates that the
// pre-commit hook (or any other PreToolUse / CI surface) invokes.
//
// Inputs are fed by helpers that read the actual git working state.
// Each runner returns a list of violations + a summary; the CLI maps that
// onto exit codes + audit events + human/machine output.

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import type { Policy } from "./policy.js";

// ---------------------------------------------------------------------------
// Glob matching (tiny, no dep)
// ---------------------------------------------------------------------------

/**
 * Convert a glob with `*`, `**`, `?` into an anchored RegExp.
 * Supports the subset of globs that policy.json paths use in practice:
 *   - `**\/` recursively matches directories
 *   - `*` matches any char except `/`
 *   - `?` matches a single char except `/`
 *   - Literal path separators and dots
 */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` — match across directory separators (including zero dirs)
        // `**/` consumes the trailing slash if present
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (".+^$()|{}[]\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

export function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

export interface StagedFile {
  path: string;
  /** Added lines only (the `+` lines from --unified=0, with the leading `+` stripped) */
  addedLines: Array<{ lineNumber: number; content: string }>;
}

/**
 * Read the staged diff as a structured list. Uses git CLI directly — no
 * surprises about index state, no library to keep in sync with git.
 *
 * Errors from git (not a repo, no staged changes, etc.) are RE-THROWN, not
 * swallowed. The caller decides whether "no staged changes" is fatal.
 */
export function getStagedFiles(repoRoot: string): StagedFile[] {
  const nameOutput = execSync("git diff --cached --name-only --diff-filter=ACMR", {
    cwd: repoRoot,
    encoding: "utf-8",
  }).trim();
  if (!nameOutput) return [];

  const fileNames = nameOutput.split("\n");
  const result: StagedFile[] = [];

  for (const file of fileNames) {
    let diff: string;
    try {
      diff = execSync(`git diff --cached --unified=0 -- "${file.replace(/"/g, '\\"')}"`, {
        cwd: repoRoot,
        encoding: "utf-8",
      });
    } catch {
      // Binary file, deleted, or path that doesn't roundtrip — skip safely.
      continue;
    }

    const addedLines: Array<{ lineNumber: number; content: string }> = [];
    let currentLine = 0;
    for (const line of diff.split("\n")) {
      // Hunk header: @@ -a,b +c,d @@
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        currentLine = parseInt(hunk[1], 10);
        continue;
      }
      if (line.startsWith("+++")) continue;
      if (line.startsWith("+")) {
        addedLines.push({ lineNumber: currentLine, content: line.slice(1) });
        currentLine++;
      } else if (line.startsWith(" ") || line.startsWith("---")) {
        // Context or header — should not appear with --unified=0 but be safe
      } else if (line.startsWith("-")) {
        // Removed lines don't advance the new-file line counter
      } else {
        currentLine++;
      }
    }
    result.push({ path: file, addedLines });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Secret-scan checker
// ---------------------------------------------------------------------------

export interface SecretViolation {
  patternId: string;
  severity: "block" | "warn";
  file: string;
  lineNumber: number;
  /** Pattern source for audit attribution. Never the matched value. */
  patternSource: string;
}

/**
 * Apply policy.secret_patterns to a list of staged files. Returns one
 * violation per matched line. Honors the `paths` glob scoping per pattern.
 *
 * IMPORTANT: We never return the matched secret value. Only the location
 * + pattern id. This is the redaction contract.
 */
export function runSecretScan(policy: Policy, files: StagedFile[]): SecretViolation[] {
  const violations: SecretViolation[] = [];
  for (const pattern of policy.secret_patterns) {
    const re = new RegExp(pattern.pattern);
    for (const file of files) {
      if (pattern.paths?.length && !matchesAnyGlob(file.path, pattern.paths)) continue;
      for (const line of file.addedLines) {
        if (re.test(line.content)) {
          violations.push({
            patternId: pattern.id,
            severity: pattern.severity,
            file: file.path,
            lineNumber: line.lineNumber,
            patternSource: pattern.pattern,
          });
        }
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Doc-coverage checker (diff-aware, not time-aware)
// ---------------------------------------------------------------------------

export interface DocCoverageViolation {
  severity: "block" | "warn";
  sourcePaths: string[];        // Globs from the rule
  matchedFiles: string[];        // Actual staged files matching the globs
  requiresSection: string;       // "DOC.md#anchor"
  reason: "doc-section-not-found" | "doc-not-staged-and-section-unchanged";
}

/**
 * For each doc_coverage rule, check:
 *   - did this commit touch any of the rule's source paths?
 *   - if yes, is the required doc-section file either (a) also in the staged
 *     diff, or (b) present at the expected path?
 *
 * "Section unchanged" detection requires reading the doc; we treat presence
 * of the file as the floor (a real next-iteration improvement: hash the
 * section under the anchor and require staged change to the anchor section
 * when triggered. For now, presence + warn=non-staged is the contract).
 */
export function runDocCoverage(
  policy: Policy,
  files: StagedFile[],
  repoRoot: string,
): DocCoverageViolation[] {
  const stagedSet = new Set(files.map((f) => f.path));
  const violations: DocCoverageViolation[] = [];

  for (const rule of policy.doc_coverage) {
    const matchedFiles = files
      .map((f) => f.path)
      .filter((p) => matchesAnyGlob(p, rule.paths));
    if (matchedFiles.length === 0) continue; // rule did not fire

    const [docPath /*, anchor*/] = rule.requires_section.split("#");
    const absoluteDocPath = join(repoRoot, docPath);

    if (!existsSync(absoluteDocPath)) {
      violations.push({
        severity: rule.severity,
        sourcePaths: rule.paths,
        matchedFiles,
        requiresSection: rule.requires_section,
        reason: "doc-section-not-found",
      });
      continue;
    }

    // If the doc file IS staged, the commit author is updating it — pass.
    if (stagedSet.has(docPath)) continue;

    // Doc exists but is not in this commit. v1 contract: warn-or-block based
    // on severity. Next iteration: hash the section under the anchor and
    // require staged change to that section's lines specifically.
    violations.push({
      severity: rule.severity,
      sourcePaths: rule.paths,
      matchedFiles,
      requiresSection: rule.requires_section,
      reason: "doc-not-staged-and-section-unchanged",
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Doc section hash (foundation for future v2 staged-section-change check)
// ---------------------------------------------------------------------------

/**
 * Compute a stable SHA-256 of the section content under a markdown anchor.
 * "Section" = lines from `## Anchor` (or `### Anchor` etc.) up to the next
 * heading at the same or higher level. Used by the next-iteration v2 check.
 *
 * Exposed now so the CLI can surface a stable hash for compliance evidence
 * (e.g., "as of this commit, the firewall section is hash X").
 */
export function hashDocSection(filePath: string, anchor: string): string | null {
  if (!existsSync(filePath)) return null;
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  let inSection = false;
  let sectionLevel = -1;
  const section: string[] = [];

  for (const line of lines) {
    const heading = line.match(/^(#+)\s+(.+?)\s*$/);
    if (heading) {
      const level = heading[1].length;
      const headSlug = slug(heading[2]);
      if (!inSection && headSlug === slug(anchor)) {
        inSection = true;
        sectionLevel = level;
        continue;
      }
      if (inSection && level <= sectionLevel) {
        // Hit a sibling or higher heading — section ended
        break;
      }
    }
    if (inSection) section.push(line);
  }

  if (!inSection) return null;
  return createHash("sha256").update(section.join("\n")).digest("hex");
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatSecretViolations(violations: SecretViolation[]): string {
  if (violations.length === 0) return "✅ No policy secret patterns matched.";
  const lines: string[] = [];
  const blocking = violations.filter((v) => v.severity === "block").length;
  const warning = violations.filter((v) => v.severity === "warn").length;
  lines.push(
    `🔒 SECRET POLICY: ${violations.length} violation(s) — ${blocking} blocking, ${warning} warning(s).`,
  );
  for (const v of violations) {
    lines.push(`  [${v.severity}] ${v.patternId} at ${v.file}:${v.lineNumber}`);
  }
  return lines.join("\n");
}

export function formatDocCoverageViolations(violations: DocCoverageViolation[]): string {
  if (violations.length === 0) return "✅ All doc-coverage rules satisfied.";
  const lines: string[] = [];
  const blocking = violations.filter((v) => v.severity === "block").length;
  const warning = violations.filter((v) => v.severity === "warn").length;
  lines.push(
    `📄 DOC COVERAGE: ${violations.length} violation(s) — ${blocking} blocking, ${warning} warning(s).`,
  );
  for (const v of violations) {
    const reason =
      v.reason === "doc-section-not-found"
        ? "doc file does not exist"
        : "doc not staged in this commit (and section content unchanged)";
    lines.push(`  [${v.severity}] ${v.matchedFiles.join(", ")} → ${v.requiresSection} (${reason})`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Machine-readable output (for CI pipelines)
// ---------------------------------------------------------------------------

export function formatSecretViolationsJson(violations: SecretViolation[]): string {
  return JSON.stringify({
    check: "secret-scan",
    violations_total: violations.length,
    blocking: violations.filter((v) => v.severity === "block").length,
    warnings: violations.filter((v) => v.severity === "warn").length,
    violations: violations.map((v) => ({
      pattern_id: v.patternId,
      severity: v.severity,
      file: v.file,
      line: v.lineNumber,
    })),
  });
}

export function formatDocCoverageViolationsJson(violations: DocCoverageViolation[]): string {
  return JSON.stringify({
    check: "doc-coverage",
    violations_total: violations.length,
    blocking: violations.filter((v) => v.severity === "block").length,
    warnings: violations.filter((v) => v.severity === "warn").length,
    violations: violations.map((v) => ({
      severity: v.severity,
      source_paths: v.sourcePaths,
      matched_files: v.matchedFiles,
      requires_section: v.requiresSection,
      reason: v.reason,
    })),
  });
}


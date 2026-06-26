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
//
// ---------------------------------------------------------------------------
// ACCEPTED LIMITS — out-of-scope by design (do NOT classify these as bugs)
// ---------------------------------------------------------------------------
//   1. `git commit --no-verify` — documented git escape hatch. Cannot be
//      caught at the hook layer (git skips ALL hooks under that flag).
//      Mitigation lives upstream of git (CODEOWNERS / branch protection /
//      server-side push rules), not here.
//   2. Workflow ID format (`wf_x`) is NOT verified against actual
//      audit-log entries — adding that would require a server-side query
//      against the OpsContext audit-log service. Deferred to a later
//      iteration. We only enforce the text-shape of the citation, not that
//      it corresponds to a real workflow.
//   3. Direct SSH edits, cron edits, Cloudflare UI edits — out of scope
//      by design. If the change never enters git, no commit hook can
//      observe it. Defense-in-depth is via sidecar collectors (PM2,
//      systemd, cron, Cloudflare audit log) feeding the central audit log.
//   4. Glob case-sensitivity on case-insensitive filesystems (APFS / NTFS)
//      — git itself does NOT normalize this. A rule scoped to
//      `server/Deploy.sh` will not match a path `server/deploy.sh` on
//      Linux but WILL match on macOS-default APFS. Mitigation: author
//      policy.json with case-sensitive paths that match git's stored
//      paths exactly.
//   5. Sibling-project deploy scripts (KONIVE / PLANK / etc.) — each
//      project gets its own `.contextengine/policy.json`. This rule only
//      applies to the repo it lives in. Cross-repo enforcement is a
//      separate concern (org-policy distribution via `extends:`).

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
// Commit-message-required checker (Agent B — Option B consumer)
// ---------------------------------------------------------------------------
//
// Consumes the `commit_message_required` rule type added by Agent A
// (CommitMessageRequiredSchema in src/policy.ts, sample rule
// `multi-agent-for-shared-infra` in .contextengine/policy.json).
//
// Trigger: any staged file path matches the rule's `paths` globs.
// Pass:    the commit message matches the rule's `pattern` (ERE regex).
// Bypass:  the commit body contains `--skip-multi-agent-reason: <reason>`
//          — the bypass IS recorded as a separate kind (`bypass`) so the
//          CLI can emit a `policy.skipped` audit event with the reason.
//
// We intentionally do NOT swallow the bypass into "no violation":
// surfacing it as a `bypass` kind lets the CLI keep the audit-log append
// in the same place as `hook.block` events, preserving symmetry.

/** Canonical bypass marker. Lives at the top of the checker so editors
 *  can grep for it when reviewing the audit story. */
export const COMMIT_BYPASS_PREFIX = "--skip-multi-agent-reason:";

/** Minimum reason length when bypassing. Hardened 2026-06-26 (verifier
 *  Bypass #11): the previous 5-char floor passed `12345` as a "valid"
 *  reason — no semantic content, just a placeholder to defeat the gate.
 *  Now 20 chars + at least one whitespace character (real reasons are
 *  prose with words, not concatenated tokens). Matches
 *  BypassTokenSchema.requires_reason_min_length default of 20. */
const MIN_BYPASS_REASON_LENGTH = 20;

export interface CommitMessageViolation {
  kind: "missing-pattern" | "bypass";
  severity: "block" | "warn";
  ruleId: string;
  matchedFiles: string[];
  pattern: string;
  description?: string;
  /** Only set when kind === "bypass". The free-text reason captured
   *  after `--skip-multi-agent-reason:` for the audit log. */
  bypassReason?: string;
}

/** Extract a bypass reason from the commit message. Returns the
 *  reason text (trimmed) or null when absent.
 *
 *  Hardened 2026-06-26 (verifier Bypass #5 + #11):
 *    - The bypass-marker MUST appear at the start of its own line
 *      (only leading whitespace allowed). Mid-line or commented-out
 *      markers like `# Note: do NOT use --skip-multi-agent-reason: ever`
 *      are REJECTED — the `#` (or any non-whitespace char) before the
 *      prefix on the same line disqualifies the line.
 *    - Reason must be ≥ MIN_BYPASS_REASON_LENGTH chars (20).
 *    - Reason must contain at least one whitespace character — real
 *      reasons are prose ("emergency rollback at 03:00 UTC"), not
 *      alphanumeric placeholders ("12345" / "abc123def456…"). A token
 *      without spaces is almost certainly a defeat attempt.
 */
export function extractBypassReason(commitMessage: string): string | null {
  for (const rawLine of commitMessage.split(/\r?\n/)) {
    // Allow ONLY leading whitespace before the prefix (no `#`, no quote,
    // no other prose). Verifier Bypass #5 attack vector closed here.
    const leadingMatch = rawLine.match(/^(\s*)/);
    const leading = leadingMatch ? leadingMatch[1] : "";
    const afterLeading = rawLine.slice(leading.length);
    if (!afterLeading.startsWith(COMMIT_BYPASS_PREFIX)) continue;

    const reason = afterLeading.slice(COMMIT_BYPASS_PREFIX.length).trim();
    if (reason.length < MIN_BYPASS_REASON_LENGTH) continue;
    // Real reasons contain at least one space — reject "12345",
    // "abcdef1234567890ABCDE", and other word-less placeholders.
    if (!/\s/.test(reason)) continue;
    return reason;
  }
  return null;
}

/**
 * Strip any top-level alternation branch from a policy regex pattern
 * that contains the literal COMMIT_BYPASS_PREFIX. Verifier Bypass #3:
 * the canonical policy pattern
 *
 *   Multi-agent: wf_[a-z0-9-]+|--skip-multi-agent-reason: .+
 *
 * had two branches in one pattern; the second branch matched the literal
 * bypass marker anywhere in the message (including mid-line, commented
 * out, etc.), short-circuiting the strict line-anchored validation in
 * extractBypassReason. Fix: the matcher in runCommitMessageRequired
 * ignores the bypass-marker branch entirely — bypass MUST go through
 * extractBypassReason's hardened validation.
 *
 * Returns the cleaned pattern. If every branch is bypass-related (rare
 * footgun), returns null — caller treats as "no positive branch to
 * satisfy", which is the safe default.
 */
export function stripBypassBranchFromPattern(pattern: string): string | null {
  // Top-level alternation split. This is a SIMPLE split — patterns with
  // nested grouping that uses `|` inside `(...)` aren't decomposed, but
  // the canonical policy patterns don't use that shape. If a future
  // policy needs nested alternation, the safer move is to author the
  // bypass branch out of the policy entirely (it belongs to
  // extractBypassReason, not to the pattern).
  const branches = pattern.split("|");
  const cleaned = branches.filter(
    (b) => !b.includes(COMMIT_BYPASS_PREFIX),
  );
  if (cleaned.length === 0) return null;
  return cleaned.join("|");
}

/**
 * Apply policy.commit_message_required rules to a staged-file list +
 * commit message. Returns one entry per fired rule (either a
 * missing-pattern violation OR a bypass acknowledgement).
 *
 * Empty list = nothing fired (either no rule's `paths` matched, or every
 * fired rule was satisfied by the message).
 *
 * IMPORTANT: This does NOT itself decide exit codes. The caller (CLI)
 * decides: missing-pattern + severity=block → exit 1 + hook.block event;
 * bypass → exit 0 + policy.skipped event with the reason.
 */
export function runCommitMessageRequired(
  policy: Policy,
  files: StagedFile[],
  commitMessage: string,
): CommitMessageViolation[] {
  const results: CommitMessageViolation[] = [];
  const bypassReason = extractBypassReason(commitMessage);

  for (const rule of policy.commit_message_required) {
    const matchedFiles = files
      .map((f) => f.path)
      .filter((p) => matchesAnyGlob(p, rule.paths));
    if (matchedFiles.length === 0) continue; // rule did not fire

    // Bypass takes precedence — record it, do not block.
    if (bypassReason !== null) {
      results.push({
        kind: "bypass",
        severity: rule.severity,
        ruleId: rule.id,
        matchedFiles,
        pattern: rule.pattern,
        description: rule.description,
        bypassReason,
      });
      continue;
    }

    // No bypass — check the pattern. Strip any bypass-marker alternation
    // branch first (verifier Bypass #3): the bypass path is owned by
    // extractBypassReason ONLY. Pattern-matching the bypass marker text
    // is forbidden because the policy regex has no line-anchoring and
    // therefore cannot distinguish a real bypass from a quoted/commented
    // mention of the marker.
    const cleanedPattern = stripBypassBranchFromPattern(rule.pattern);
    if (cleanedPattern === null) {
      // Pattern was 100% bypass-branches. Treat as missing-pattern —
      // the rule has no positive enforcement branch left after
      // sanitization.
      results.push({
        kind: "missing-pattern",
        severity: rule.severity,
        ruleId: rule.id,
        matchedFiles,
        pattern: rule.pattern,
        description: rule.description,
      });
      continue;
    }

    let re: RegExp;
    try {
      re = new RegExp(cleanedPattern);
    } catch {
      // Malformed pattern in policy.json — surface as a missing-pattern
      // violation rather than crashing the hook. The CLI will print the
      // rule.description, which should explain the contract.
      results.push({
        kind: "missing-pattern",
        severity: rule.severity,
        ruleId: rule.id,
        matchedFiles,
        pattern: rule.pattern,
        description: rule.description,
      });
      continue;
    }
    if (!re.test(commitMessage)) {
      results.push({
        kind: "missing-pattern",
        severity: rule.severity,
        ruleId: rule.id,
        matchedFiles,
        pattern: rule.pattern,
        description: rule.description,
      });
    }
  }

  return results;
}

export function formatCommitMessageViolations(
  violations: CommitMessageViolation[],
): string {
  if (violations.length === 0) return "✅ All commit-message-required rules satisfied.";
  const lines: string[] = [];
  const blocking = violations.filter((v) => v.kind === "missing-pattern" && v.severity === "block").length;
  const bypasses = violations.filter((v) => v.kind === "bypass").length;
  lines.push(
    `📝 COMMIT MESSAGE POLICY: ${violations.length} rule(s) fired — ${blocking} blocking, ${bypasses} bypassed.`,
  );
  for (const v of violations) {
    if (v.kind === "bypass") {
      lines.push(
        `  [bypass] ${v.ruleId} on ${v.matchedFiles.join(", ")} — reason: "${v.bypassReason}" (logged to audit)`,
      );
      continue;
    }
    lines.push(
      `  [${v.severity}] ${v.ruleId} on ${v.matchedFiles.join(", ")} — commit body must match /${v.pattern}/`,
    );
    if (v.description) lines.push(`           ${v.description}`);
  }
  return lines.join("\n");
}

export function formatCommitMessageViolationsJson(
  violations: CommitMessageViolation[],
): string {
  return JSON.stringify({
    check: "commit-message-required",
    violations_total: violations.length,
    blocking: violations.filter((v) => v.kind === "missing-pattern" && v.severity === "block").length,
    bypasses: violations.filter((v) => v.kind === "bypass").length,
    violations: violations.map((v) => ({
      kind: v.kind,
      severity: v.severity,
      rule_id: v.ruleId,
      matched_files: v.matchedFiles,
      pattern: v.pattern,
      bypass_reason: v.bypassReason,
    })),
  });
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


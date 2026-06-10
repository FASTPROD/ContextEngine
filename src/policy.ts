// 🔒 LOCKED [POLICY-CONTRACT] — 2026-06-10
// ⛔ NEVER bump `version: 1` without a migration path that keeps v1
//    policies loadable. Org policy URLs in the wild will pin a version;
//    breaking the loader silently breaks remote policy distribution.
// ⛔ NEVER add NEW required fields to existing schemas — only optional
//    fields with defaults. Old policies must still validate.
// WHY: This is the contract that hooks, CI templates, and the future
//    signed-policy-distribution layer will all consume. Schema breakage
//    here cascades into every consumer. The audit's hook-redesign
//    proposal hinges on this single declarative contract replacing 329
//    LOC of inline bash.
// FIX: To evolve, add `version: 2` schema alongside, dispatch in
//    `parsePolicy()` based on the version field, keep `validatePolicy()`
//    backward-compatible.
//
// Declarative policy contract — .contextengine/policy.json at repo root.
//
// Hooks (pre-commit, CC PreToolUse, CI templates) consume this single file
// instead of carrying inline bash. Reviewable in PR, portable across IDE +
// git + CI layers, signable as an org-distributed bundle later.

import { z } from "zod";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * A regex pattern the secret scanner should match against staged diff content.
 * Optional `paths` glob list scopes the pattern (e.g. JWT pattern only
 * applied to docs/sessions/**\/*.md, the Apec-leak shape).
 */
export const SecretPatternSchema = z.object({
  id: z.string().min(1).describe("Stable identifier for audit-log attribution"),
  pattern: z.string().min(1).describe("ERE regex matched against added lines"),
  paths: z.array(z.string()).optional().describe("Glob patterns scoping the rule; omit for all files"),
  severity: z.enum(["block", "warn"]).default("block"),
  description: z.string().optional(),
});
export type SecretPattern = z.infer<typeof SecretPatternSchema>;

/**
 * A source-tree subtree that requires a documentation section to stay current.
 * Diff-aware: the gate fires only when commit touches the mapped subtree AND
 * the corresponding doc section's hash is unchanged. Replaces the 4-hour
 * wall-clock timer from the legacy hook.
 */
export const DocCoverageSchema = z.object({
  paths: z.array(z.string()).min(1).describe("Source-tree globs that this rule covers"),
  requires_section: z.string().min(1).describe("Doc path with anchor, e.g. SKILLS.md#protocol-firewall"),
  severity: z.enum(["block", "warn"]).default("block"),
  description: z.string().optional(),
});
export type DocCoverage = z.infer<typeof DocCoverageSchema>;

/**
 * A production host that requires a verification probe within N seconds of
 * a git push. Encodes the "DEPLOY = VERIFY LIVE" rule from CLAUDE.md.
 */
export const DeployVerifyHostSchema = z.object({
  host: z.string().min(1),
  require_probe: z.string().min(1).describe("Shell command run to verify, e.g. curl -sf https://host/healthz"),
  within_seconds: z.number().int().positive().default(60),
  description: z.string().optional(),
});
export type DeployVerifyHost = z.infer<typeof DeployVerifyHostSchema>;

/**
 * A documented escape hatch for the hook. Beats undocumented `touch` /
 * `--no-verify` workarounds. Bypass token requires a reason and lives in
 * the audit log.
 */
export const BypassTokenSchema = z.object({
  id: z.string().min(1).describe("Stable identifier for audit-log attribution"),
  ttl_seconds: z.number().int().positive().default(300).describe("How long after issuance the token is valid"),
  requires_reason_min_length: z.number().int().min(0).default(20),
  description: z.string().optional(),
});
export type BypassToken = z.infer<typeof BypassTokenSchema>;

/**
 * The full policy document — schema version 1.
 */
export const PolicySchema = z.object({
  version: z.literal(1).describe("Policy schema version. Pin to 1 — bumps require a migration path."),
  extends: z
    .string()
    .url()
    .optional()
    .describe("Org policy URL (HTTPS or git). Signed-bundle distribution is a P1 #5 follow-up."),
  secret_patterns: z.array(SecretPatternSchema).default([]),
  doc_coverage: z.array(DocCoverageSchema).default([]),
  deploy_verify_hosts: z.array(DeployVerifyHostSchema).default([]),
  bypass_tokens: z.array(BypassTokenSchema).default([]),
});
export type Policy = z.infer<typeof PolicySchema>;

// ---------------------------------------------------------------------------
// Loading & validation
// ---------------------------------------------------------------------------

/**
 * Validate a raw parsed object against the policy schema. Returns either
 * a validated Policy or a structured list of field-level errors.
 */
export type ValidationResult =
  | { ok: true; policy: Policy }
  | { ok: false; errors: Array<{ path: string; message: string }> };

export function validatePolicy(raw: unknown): ValidationResult {
  const result = PolicySchema.safeParse(raw);
  if (result.success) return { ok: true, policy: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => ({
      path: i.path.length ? i.path.join(".") : "(root)",
      message: i.message,
    })),
  };
}

/**
 * Parse policy file contents. Currently supports JSON only. YAML support
 * is on the roadmap — purely an ergonomic addition, no runtime difference.
 */
export function parsePolicy(contents: string): ValidationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (e) {
    return {
      ok: false,
      errors: [{ path: "(root)", message: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }],
    };
  }
  return validatePolicy(raw);
}

/**
 * Load the repo-local policy from .contextengine/policy.json. Returns null
 * when no policy file exists (repos without explicit policy still work —
 * hooks fall back to built-in defaults).
 *
 * Returns ValidationResult so consumers can surface schema errors to the
 * user instead of crashing on a malformed file.
 */
export function loadRepoPolicy(repoRoot: string): ValidationResult | null {
  const path = repoPolicyPath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    const contents = readFileSync(path, "utf-8");
    return parsePolicy(contents);
  } catch (e) {
    return {
      ok: false,
      errors: [{ path: "(file)", message: `Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}` }],
    };
  }
}

export function repoPolicyPath(repoRoot: string): string {
  return join(repoRoot, ".contextengine", "policy.json");
}

// ---------------------------------------------------------------------------
// Pretty-print
// ---------------------------------------------------------------------------

export function formatPolicySummary(policy: Policy): string {
  const lines: string[] = [];
  lines.push(`# ContextEngine policy (v${policy.version})`);
  if (policy.extends) {
    lines.push(`Extends: ${policy.extends}  (signed bundle resolution: not yet implemented — P1 #5)`);
  }
  lines.push("");
  lines.push(`Secret patterns: ${policy.secret_patterns.length}`);
  for (const p of policy.secret_patterns) {
    const scope = p.paths?.length ? p.paths.join(", ") : "(all files)";
    lines.push(`  - [${p.severity}] ${p.id} → scoped to ${scope}`);
  }
  lines.push("");
  lines.push(`Doc coverage rules: ${policy.doc_coverage.length}`);
  for (const c of policy.doc_coverage) {
    lines.push(`  - [${c.severity}] ${c.paths.join(", ")} → ${c.requires_section}`);
  }
  lines.push("");
  lines.push(`Deploy-verify hosts: ${policy.deploy_verify_hosts.length}`);
  for (const h of policy.deploy_verify_hosts) {
    lines.push(`  - ${h.host} → probe within ${h.within_seconds}s: ${h.require_probe}`);
  }
  lines.push("");
  lines.push(`Bypass tokens: ${policy.bypass_tokens.length}`);
  for (const b of policy.bypass_tokens) {
    lines.push(`  - ${b.id} → TTL ${b.ttl_seconds}s, reason ≥ ${b.requires_reason_min_length} chars`);
  }
  return lines.join("\n");
}

export function formatValidationErrors(errors: Array<{ path: string; message: string }>): string {
  const lines: string[] = [];
  lines.push(`❌ Policy validation failed — ${errors.length} error(s):`);
  for (const e of errors) {
    lines.push(`  • ${e.path}: ${e.message}`);
  }
  return lines.join("\n");
}

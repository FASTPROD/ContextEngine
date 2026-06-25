// 🔒 LOCKED [COMMUNITY-EXPORT-SAFETY] — 2026-06-24
// ⛔ NEVER weaken, narrow, comment-out, or "optimize" the redaction patterns
//   in PATTERNS, PII_PATTERNS, or PERSONAL_IDENTIFIERS. Do not shorten the
//   project brand list. Do not remove the "empty after redaction → reject"
//   guard. Do not turn `salt='opscontext-public-v1'` into a runtime config
//   knob — the salt being a compile-time constant is what makes Tier-A IDs
//   deterministic across machines.
// WHY: this module is the ONLY thing standing between the user's 942+
//   personal learnings (real ops IP — production incidents, client-specific
//   bug fixes, "don't deploy on Friday because…") and a public GitHub repo
//   under MIT license. A single missed pattern = irreversible IP leak the
//   moment the export hits a public mirror. There is no take-back.
// FIX: if a new secret shape needs coverage, ADD a pattern. If a brand name
//   for a future project needs masking, ADD it to PROJECT_BRAND_NAMES.
//   The rule is monotone: redaction coverage only grows, never shrinks.
//   For any change here: pair-review with Yan and run the redactRule tests
//   plus a manual eyeball on 20 random Tier-A entries before publishing.
// SEE ALSO: chrome-extension/src/content/shared/redact.ts (the same patterns,
//   independently mirrored — keep both in sync; if you patch one, patch the
//   other in the same commit).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { createHash } from "crypto";
import { execSync, spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { listLearnings, type Learning } from "./learnings.js";
import { safeAppend } from "./audit.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An ExportedRule is the sanitized, publishable shape of a Learning.
 *
 * Differences from Learning:
 * - `id` is NOT the user's local UUID. For Tier A it's sha256(originalId, salt)
 *   so it's stable across exports but does not link back to the user's store.
 *   For Tier B it can preserve the original id (PRO subscribers are
 *   authenticated; not a public artifact).
 * - `rule` and `context` are passed through `redactRule` — secrets, PII, and
 *   personal/project identifiers replaced with token markers.
 * - `project` is a sha256 prefix when present — co-clustering survives
 *   ("these 3 learnings came from the same project") but the human-readable
 *   brand is gone.
 * - `tags` are preserved verbatim (they're already low-entropy and useful
 *   for the recipient agent's relevance ranking).
 * - `created` / `updated` are intentionally OMITTED — timestamps narrow the
 *   anonymity set, and downstream consumers don't need them.
 */
export interface ExportedRule {
  id: string;
  category: string;
  rule: string;
  context: string;
  project?: string;
  tags: string[];
}

export interface ExportResult {
  tier: "A" | "B";
  outputPath: string;
  count: number;
  dropped: number;
  rules: ExportedRule[];
}

export interface ExportOptions {
  tier: "A" | "B";
  outputPath: string;
  review?: boolean;
}

// ---------------------------------------------------------------------------
// Redaction patterns — mirrors chrome-extension/src/content/shared/redact.ts
// ---------------------------------------------------------------------------

interface SecretPattern {
  id: string;
  re: RegExp;
}

/**
 * Secret-shape patterns. Built from string parts where the literal pattern
 * would itself trigger the local pre-commit secret scanner.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  { id: "aws_access_key", re: /AKIA[0-9A-Z]{16}/g },
  { id: "stripe_live_key", re: /sk_live_[A-Za-z0-9]{24,}/g },
  { id: "stripe_publishable", re: /pk_live_[A-Za-z0-9]{24,}/g },
  { id: "jwt", re: /eyJ[A-Za-z0-9_=-]{8,}\.eyJ[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}/g },
  { id: "anthropic_key", re: /sk-ant-(?:api|admin)\d*-[A-Za-z0-9_-]{32,}/g },
  { id: "openai_key", re: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { id: "github_pat", re: /ghp_[A-Za-z0-9]{36,}/g },
  { id: "github_fine_grained", re: /github_pat_[A-Za-z0-9_]{82}/g },
  // Bearer sk-... — threshold deliberately LOW (4+) per the round-1 verifier's
  // cardinal-sin finding: the adversarial sample "bearer sk-1234abc" leaked
  // through the previous ≥20-char threshold. The false-positive surface from
  // 4-char threshold is bounded (random words ≥4 chars after "bearer sk-"
  // are exceedingly rare in conversational text); the false-negative cost
  // here is IP/secret leakage to a public community library. Skewed
  // accordingly. LOCK [COMMUNITY-EXPORT-SAFETY].
  { id: "bearer_sk", re: /[Bb]earer\s+sk-[A-Za-z0-9_-]{4,}/g },
  // Looser sibling — catches `sk-<short>` even without the "bearer" prefix
  // (covers "I had to debug an sk-1234abc auth failure"). Also low threshold
  // for the same reason as bearer_sk.
  { id: "loose_sk_token", re: /\bsk-[A-Za-z0-9_-]{4,}/g },
  {
    id: "ssh_private_key",
    re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g,
  },
  {
    id: "generic_cred_assign",
    // Permit slashes in the value (so AWS_SECRET=<40 chars with slashes>
    // matches as ONE unit and the trailing tail can't survive). Round-1
    // verifier caught the previous pattern truncating at the first slash
    // and leaving "/K7MDENG/bPxRfiCYEXAMPLEKEY" in the output.
    re: (() => {
      const keys = ["pass" + "word", "passwd", "sec" + "ret", "to" + "ken", "api[_-]?key", "apikey", "aws[_-]?(?:access|secret)[_-]?key"].join("|");
      const value = "[A-Za-z0-9!@#$%^&*_+=/-]{12,}";
      return new RegExp(`(?:${keys})\\s*[:=]\\s*['\"]?${value}['\"]?`, "gi");
    })(),
  },
  // AWS secret-key shape: 40 chars of [A-Za-z0-9/+]. Run LAST because it's
  // the loosest pattern — anything earlier wins first. Note: generic_cred_assign
  // now allows slashes in the value half so AWS_SECRET=<40-char-with-slashes>
  // is consumed as one unit upstream; this pattern catches the bare-key case
  // (no surrounding "AWS_SECRET=" prefix).
  {
    id: "aws_secret_key",
    re: /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g,
  },
];

// ---------------------------------------------------------------------------
// PII patterns
// ---------------------------------------------------------------------------

interface PiiPattern {
  id: string;
  re: RegExp;
  replacement: string;
}

const PII_PATTERNS: PiiPattern[] = [
  {
    id: "email",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: "[EMAIL]",
  },
  {
    // Credit-card-shape: run BEFORE the phone pattern (otherwise phone eats it).
    id: "cc",
    re: /\b(?:\d[ -]?){13,19}\b/g,
    replacement: "[CC]",
  },
  {
    id: "phone",
    // Filtered in-callback to avoid redacting generic numeric strings.
    re: /\+?[\d\s\-().]{10,}/g,
    replacement: "[PHONE]",
  },
];

// ---------------------------------------------------------------------------
// Personal identifiers — Yan's actual workspace footprint
// ---------------------------------------------------------------------------

/** Contact-shaped identifiers — names + owned domains. Case-insensitive, whole-word. */
const CONTACT_IDENTIFIERS = ["yannick", "yan", "compr.ch", "compr.fr"] as const;

/** Brand names of Yan's projects. Replaced with the generic token [project]. */
const PROJECT_BRAND_NAMES = [
  "CROWLR", "KONIVE", "INVOC", "INVOK", "PLANK", "COMPR", "FASTPROD",
] as const;

/** Absolute path prefix that leaks the local username. */
const HOME_PATH_PREFIX = "/Users/yan/Projects/";

/** OpsContext heartbeat server — replace so the live URL doesn't appear in published rules. */
const SERVER_HOST = "api.compr.ch";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Public salt for Tier-A ID hashing. Deliberately a constant — the salt
 * being non-secret is what makes the hash deterministic for any verifier.
 * Versioned so we can rotate without colliding old/new IDs.
 */
const PUBLIC_ID_SALT = "opscontext-public-v1";

/**
 * Project hash prefix length. Short enough to drop the brand, long enough
 * to make collisions across a few hundred projects a non-issue.
 */
const PROJECT_HASH_LEN = 8;

/** Minimum length of a usable rule AFTER redaction. Anything shorter is noise. */
const MIN_RULE_LENGTH_AFTER_REDACT = 15;

/**
 * Tier-A allow-list of categories (general developer pain) — anything in a
 * sensitive category (security/deployment/infrastructure) is dropped from
 * Tier A by default, even if it would have passed the redactor.
 */
const TIER_A_ALLOWED_CATEGORIES = new Set([
  "debugging",
  "tooling",
  "git",
  "frontend",
  "testing",
  "dependencies",
  "performance",
  "other",
]);

/**
 * Tier-A default-deny categories. These are the most likely to embed IP
 * (e.g. "always restart nginx after edits" → fine; "rotate the OVH SSL cert
 * by editing /etc/letsencrypt/live/foo.com" → leaks customer infrastructure).
 */
const TIER_A_DENIED_CATEGORIES = new Set([
  "security",
  "deployment",
  "infrastructure",
  "devops",
]);

// ---------------------------------------------------------------------------
// redactRule — the public, testable redaction surface
// ---------------------------------------------------------------------------

/**
 * Run the full redaction pipeline on a single string.
 *
 * Returns the redacted text, or an empty string if the input is too short /
 * empty / one-word (callers should treat empty-return as "drop this rule").
 *
 * Deterministic: identical input → identical output, no timestamps, no
 * randomness.
 */
export function redactRule(text: string): string {
  if (typeof text !== "string") return "";
  let out = text;

  // 1. Hard secrets first — high-confidence patterns shouldn't be blocked by
  //    a lower-precedence path/contact replacement that could shorten them.
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, `[REDACTED:${p.id}]`);
  }

  // 2. PII: email + credit-card BEFORE phone, so 13+ digit runs aren't eaten
  //    by the phone matcher.
  for (const p of PII_PATTERNS) {
    if (p.id === "phone") {
      // Filtered: a 10-15-digit run is treated as a phone; outside that
      // range we keep the original text (avoids redacting timestamps).
      out = out.replace(p.re, (m) => {
        const digits = m.replace(/\D/g, "");
        if (digits.length < 7 || digits.length > 15) return m;
        return p.replacement;
      });
    } else {
      out = out.replace(p.re, p.replacement);
    }
  }

  // 3. Absolute path prefix → /workspace/<rest>
  //    MUST run BEFORE contact-identifier replacement; otherwise the bare
  //    "yan" inside "/Users/yan/" gets matched first and the path collapses
  //    to "/Users/[REDACTED:contact]/...".
  out = out.split(HOME_PATH_PREFIX).join("/workspace/");

  // 4. Heartbeat server host → [SERVER]. Same ordering reason — "compr.ch"
  //    is also a contact identifier, so we sub-out the host literal first.
  out = out.split(SERVER_HOST).join("[SERVER]");

  // 5. Personal identifiers — contact names + owned domains.
  //    Whole-word, case-insensitive. Escape regex metachars in domain names.
  for (const id of CONTACT_IDENTIFIERS) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // \b doesn't work around "." so we use a manual boundary that allows
    // domain-style identifiers like compr.ch to still match.
    const re = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gi");
    out = out.replace(re, "[REDACTED:contact]");
  }

  // 6. Project brand names → generic [project] token. Case-insensitive,
  //    whole-word so "COMPRehensive" doesn't get mangled.
  for (const brand of PROJECT_BRAND_NAMES) {
    const re = new RegExp(`\\b${brand}\\b`, "gi");
    out = out.replace(re, "[project]");
  }

  // 7. Reject empty / one-word / too-short. Empty return tells the caller
  //    to skip this rule entirely.
  const trimmed = out.trim();
  if (trimmed.length < MIN_RULE_LENGTH_AFTER_REDACT) return "";
  // One-word check after trimming — accounts for rules that became
  // "[REDACTED:contact]" after stripping.
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount < 2) return "";

  return trimmed;
}

// ---------------------------------------------------------------------------
// ID hashing
// ---------------------------------------------------------------------------

/**
 * Hash a local learning ID into a stable, public-safe Tier-A ID.
 *
 * Deterministic: same input → same hash → idempotent re-exports.
 * Doesn't reveal the local UUID format (e.g. timestamp-based prefix).
 */
function hashPublicId(localId: string): string {
  const h = createHash("sha256");
  h.update(PUBLIC_ID_SALT);
  h.update("\0");
  h.update(localId);
  return "pub_" + h.digest("hex").slice(0, 16);
}

/**
 * Hash a project name into a short prefix. Co-clustering survives (same
 * project name → same prefix) but the brand is gone.
 */
function hashProject(name: string): string {
  return createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, PROJECT_HASH_LEN);
}

// ---------------------------------------------------------------------------
// exportLearnings — orchestrates the redaction → write → audit pipeline
// ---------------------------------------------------------------------------

/**
 * Build the sanitized export for the given tier and write it to disk.
 *
 * Tier A: MIT-publishable. Filters to allow-list categories + 'safe' tag.
 *         IDs are sha256(localId)-derived (stable but not traceable).
 * Tier B: PRO-only. Full corpus (still redacted for secrets/PII). IDs are
 *         the original UUIDs (PRO users are authenticated).
 */
export function exportLearnings(opts: ExportOptions): ExportResult {
  const all = listLearnings();
  const rules: ExportedRule[] = [];
  let dropped = 0;

  for (const l of all) {
    const result = tryRedactLearning(l, opts.tier);
    if (result === null) {
      dropped++;
      continue;
    }
    rules.push(result);
  }

  // Stable sort by id so two runs over the same input produce byte-identical
  // output (modulo the generatedAt timestamp).
  rules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const payload = {
    version: 1,
    tier: opts.tier,
    generatedAt: new Date().toISOString(),
    count: rules.length,
    dropped,
    rules,
  };

  const outDir = dirname(opts.outputPath);
  if (outDir && !existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  writeFileSync(opts.outputPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");

  safeAppend(
    // The audit-event union doesn't yet enumerate 'learning.export'; the
    // append function accepts any string at runtime and the union is purely
    // a documentation aid. Casting keeps the existing strict shape happy
    // without forcing an unrelated edit to audit.ts.
    "learning.export" as Parameters<typeof safeAppend>[0],
    {
      tier: opts.tier,
      output: opts.outputPath,
      count: rules.length,
      dropped,
    },
  );

  return {
    tier: opts.tier,
    outputPath: opts.outputPath,
    count: rules.length,
    dropped,
    rules,
  };
}

/**
 * Run one learning through the redaction pipeline, returning the
 * sanitized ExportedRule or null if it should be dropped.
 */
function tryRedactLearning(l: Learning, tier: "A" | "B"): ExportedRule | null {
  // Tier-A category gate FIRST — cheap rejection before we spend cycles
  // running the redactor on entries we'd drop anyway.
  if (tier === "A") {
    const cat = l.category.toLowerCase();
    const tagsLower = (l.tags || []).map((t) => t.toLowerCase());
    const isSafeTagged = tagsLower.includes("safe");
    const isAllowedCategory = TIER_A_ALLOWED_CATEGORIES.has(cat);
    const isDeniedCategory = TIER_A_DENIED_CATEGORIES.has(cat);

    // Allow if explicitly safe-tagged OR in the allow-list AND not in the
    // deny-list. (A safe tag overrides the deny-list — the user has
    // manually vetted it.)
    if (!isSafeTagged) {
      if (isDeniedCategory) return null;
      if (!isAllowedCategory) return null;
    }
  }

  const redactedRule = redactRule(l.rule || "");
  if (redactedRule.length === 0) return null;

  // For context, allow empty strings — some learnings legitimately have no
  // context. But if the original was non-empty and redaction reduced it to
  // empty, that's a signal the context was almost entirely secret/PII —
  // keep it as an empty string (we don't drop the rule for that alone).
  const redactedContext = l.context ? redactRule(l.context) : "";

  const exportedId = tier === "A" ? hashPublicId(l.id) : l.id;
  const exportedProject = l.project ? hashProject(l.project) : undefined;

  return {
    id: exportedId,
    category: l.category,
    rule: redactedRule,
    context: redactedContext,
    project: exportedProject,
    tags: l.tags || [],
  };
}

// ---------------------------------------------------------------------------
// reviewLoop — opens $EDITOR for a final manual pass before publishing
// ---------------------------------------------------------------------------

/**
 * Open the export in $EDITOR (or vi) for a manual review pass. The user can
 * delete entries or hand-edit text; the parsed JSON is returned. In a
 * non-interactive shell (no TTY) the rules are returned unchanged.
 */
export async function reviewLoop(rules: ExportedRule[]): Promise<ExportedRule[]> {
  if (!process.stdin.isTTY) return rules;

  const editor = process.env.EDITOR || "vi";
  const tmpPath = join(tmpdir(), `opscontext-export-review-${process.pid}.json`);
  writeFileSync(tmpPath, JSON.stringify(rules, null, 2), "utf-8");

  const result = spawnSync(editor, [tmpPath], { stdio: "inherit" });
  if (result.status !== 0) {
    // Editor exited non-zero — keep the original list rather than risk a
    // half-edited file.
    return rules;
  }

  try {
    const edited = readFileSync(tmpPath, "utf-8");
    const parsed = JSON.parse(edited);
    if (Array.isArray(parsed)) return parsed as ExportedRule[];
    return rules;
  } catch {
    return rules;
  } finally {
    try {
      // Best-effort cleanup; not a correctness issue if it lingers in $TMPDIR.
      execSync(`rm -f ${JSON.stringify(tmpPath)}`);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Public utilities re-exported for tests
// ---------------------------------------------------------------------------

export const __testing = {
  hashPublicId,
  hashProject,
  PUBLIC_ID_SALT,
  TIER_A_ALLOWED_CATEGORIES,
  TIER_A_DENIED_CATEGORIES,
};

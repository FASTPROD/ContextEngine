/**
 * Tests for community-export.ts — Tier A (MIT public) + Tier B (PRO) sanitized
 * export of the user's personal learnings store.
 *
 * Verification axes:
 *   - redactRule strips every documented secret + PII + personal-identifier
 *     pattern (AWS, Stripe, Bearer sk-, email, phone, /Users/yan path,
 *     yannick@compr.ch, project brands like CROWLR).
 *   - Tier A: category allow-list + deny-list applied; entries that fall
 *     through the redactor as empty are dropped; IDs are deterministic
 *     across runs (same input → same hash → idempotent re-exports).
 *   - Tier B: full corpus passes; still redacted; original IDs preserved.
 *   - Round-trip: written JSON parses back into the same shape.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { redactRule, exportLearnings, __testing, type ExportedRule } from "../src/community-export.js";
import type { Learning } from "../src/learnings.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function L(partial: Partial<Learning>): Learning {
  return {
    id: partial.id ?? `id-${Math.random().toString(36).slice(2)}`,
    category: partial.category ?? "tooling",
    rule: partial.rule ?? "Always check the logs before restarting the service",
    context: partial.context ?? "Saves an hour of debugging downstream symptoms",
    project: partial.project,
    tags: partial.tags ?? [],
    created: partial.created ?? "2026-06-01T00:00:00.000Z",
    updated: partial.updated ?? "2026-06-01T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Vitest module mock — feed our own learnings into exportLearnings
// ---------------------------------------------------------------------------

let mockLearnings: Learning[] = [];

vi.mock("../src/learnings.js", async () => {
  // Pull in the real module so non-mocked exports (LEARNING_CATEGORIES, the
  // Learning interface) still work.
  const actual = await vi.importActual<typeof import("../src/learnings.js")>("../src/learnings.js");
  return {
    ...actual,
    listLearnings: (_category?: string, _projects?: string[]) => {
      // Tests fill mockLearnings directly; we ignore the filter args because
      // the export path passes neither.
      return mockLearnings;
    },
  };
});

// ---------------------------------------------------------------------------
// Per-test temp dir for audit log + output JSON
// ---------------------------------------------------------------------------

let tempHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "ce-community-export-"));
  originalHome = process.env.CONTEXTENGINE_HOME;
  process.env.CONTEXTENGINE_HOME = tempHome;
  mockLearnings = [];
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.CONTEXTENGINE_HOME;
  else process.env.CONTEXTENGINE_HOME = originalHome;
  rmSync(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// redactRule — pattern coverage
// ---------------------------------------------------------------------------

// All adversarial fixtures in this file are built via string
// concatenation so the local pre-commit secret-scanner does NOT match
// them as if they were real leaked secrets. The runtime regexes in
// community-export.ts still match the concatenated result.

describe("redactRule — secret patterns", () => {
  it("redacts an AWS access key", () => {
    const fixture = "AK" + "IA" + "IOSFODNN7EXAMPLE";
    const result = redactRule(`Rotate ${fixture} every 90 days for compliance`);
    expect(result).not.toContain(fixture);
    expect(result).toContain("[REDACTED:aws_access_key]");
  });

  it("redacts a Stripe live key", () => {
    const fixture = "sk" + "_live_" + "abcDEF1234567890XYZabcDEF";
    const result = redactRule(`Production Stripe key is ${fixture}, do not log`);
    expect(result).not.toMatch(/sk_live_[A-Za-z0-9]/);
    expect(result).toContain("[REDACTED:stripe_live_key]");
  });

  it("redacts a Bearer sk-... header value", () => {
    const fixture = "sk" + "-proj-" + "abc123def456ghi789jkl0";
    const result = redactRule(`Use Bearer ${fixture} for the OpenAI call`);
    expect(result).not.toContain(fixture);
    // Either bearer_sk OR openai_key OR loose_sk_token may catch it first — all correct.
    expect(result).toMatch(/\[REDACTED:(bearer_sk|openai_key|loose_sk_token)\]/);
  });

  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = redactRule(`Token leaked: ${jwt} from staging logs`);
    expect(result).not.toContain(jwt);
    expect(result).toContain("[REDACTED:jwt]");
  });

  it("redacts a GitHub PAT", () => {
    const pat = "gh" + "p_" + "aBcD1234EfGh5678IjKl9012MnOp3456QrSt";
    const result = redactRule(`The CI uses ${pat} for releases, never commit it`);
    expect(result).not.toContain(pat);
    expect(result).toContain("[REDACTED:github_pat]");
  });

  it("redacts an SSH private key block", () => {
    const block =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAABBBBCCCC\n-----END OPENSSH PRIVATE KEY-----";
    const result = redactRule(`Backup the key but never share it: ${block} keep offline`);
    expect(result).not.toContain("BEGIN OPENSSH");
    expect(result).toContain("[REDACTED:ssh_private_key]");
  });
});

describe("redactRule — PII patterns", () => {
  it("redacts a generic email address", () => {
    const result = redactRule("Contact someone-else@example.com for the production password rotation");
    expect(result).not.toContain("someone-else@example.com");
    expect(result).toContain("[EMAIL]");
  });

  it("redacts a phone-shaped number", () => {
    const result = redactRule("Call the on-call at +1 415 555 0199 when the alert fires");
    expect(result).not.toContain("415 555 0199");
    expect(result).toContain("[PHONE]");
  });

  it("redacts a credit-card-shape", () => {
    // 16-digit dummy — Luhn-invalid but shape-matching.
    const result = redactRule("Test card 4111 1111 1111 1111 should never be used in prod data");
    expect(result).not.toContain("4111 1111 1111 1111");
    expect(result).toContain("[CC]");
  });
});

describe("redactRule — personal identifiers", () => {
  it("redacts the user's email containing yannick + compr.ch", () => {
    const result = redactRule("Ping yannick@compr.ch when the build breaks at 3am please");
    // The whole shape gets caught by the email pattern first.
    expect(result).not.toContain("yannick");
    expect(result).not.toContain("compr.ch");
  });

  it("redacts the bare name 'yannick' even without an email", () => {
    const result = redactRule("Ask yannick directly about the staging cluster before pushing");
    expect(result).not.toContain("yannick");
    expect(result).toContain("[REDACTED:contact]");
  });

  it("redacts CROWLR project brand to [project]", () => {
    const result = redactRule("In CROWLR we always run the migration before the deploy step");
    expect(result).not.toContain("CROWLR");
    expect(result).toContain("[project]");
  });

  it("redacts KONIVE / PLANK / COMPR brand names", () => {
    const result = redactRule("KONIVE PLANK and COMPR all share the same lint rules everywhere");
    expect(result).not.toMatch(/\b(KONIVE|PLANK|COMPR)\b/);
  });

  it("rewrites /Users/yan/Projects/... to /workspace/...", () => {
    const result = redactRule("The script lives at /Users/yan/Projects/FooBar/scripts/run.sh on disk");
    expect(result).not.toContain("/Users/yan/");
    expect(result).toContain("/workspace/FooBar/scripts/run.sh");
  });

  it("rewrites api.compr.ch host to [SERVER]", () => {
    const result = redactRule("Heartbeat hits api.compr.ch every 24h for the license check call");
    expect(result).not.toContain("api.compr.ch");
    expect(result).toContain("[SERVER]");
  });
});

describe("redactRule — rejection logic", () => {
  it("returns empty string for empty input", () => {
    expect(redactRule("")).toBe("");
  });

  it("returns empty string for a one-word rule", () => {
    expect(redactRule("Always")).toBe("");
  });

  it("returns empty string when redaction empties the rule below threshold", () => {
    // A rule that is ONLY a personal identifier collapses below MIN_LENGTH.
    expect(redactRule("yannick")).toBe("");
  });

  it("returns empty string for null-ish / non-string input", () => {
    // @ts-expect-error — intentional bad input
    expect(redactRule(undefined)).toBe("");
    // @ts-expect-error — intentional bad input
    expect(redactRule(null)).toBe("");
  });

  it("is deterministic — same input → same output, run twice", () => {
    const pat = "gh" + "p_" + "aBcD1234EfGh5678IjKl9012MnOp3456QrSt";
    const input = `Deploy from /Users/yan/Projects/CROWLR with token ${pat} today`;
    const a = redactRule(input);
    const b = redactRule(input);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// exportLearnings — Tier A
// ---------------------------------------------------------------------------

describe("exportLearnings — Tier A", () => {
  it("rejects entries in the 'security' category by default", () => {
    mockLearnings = [
      L({
        id: "sec-1",
        category: "security",
        rule: "Rotate the SSH keys every 90 days for compliance posture",
        context: "Compliance audit failed when we missed a rotation",
      }),
    ];
    const out = join(tempHome, "tier-a.json");
    const result = exportLearnings({ tier: "A", outputPath: out });
    expect(result.count).toBe(0);
    expect(result.dropped).toBe(1);
    expect(result.rules).toHaveLength(0);
  });

  it("includes entries in tooling / debugging / git categories", () => {
    mockLearnings = [
      L({ id: "t1", category: "tooling", rule: "Run prettier before committing or the hook will fail" }),
      L({ id: "t2", category: "debugging", rule: "Check the stack trace before re-running the test suite" }),
      L({ id: "t3", category: "git", rule: "Squash before merging or the history becomes unreadable fast" }),
    ];
    const out = join(tempHome, "tier-a.json");
    const result = exportLearnings({ tier: "A", outputPath: out });
    expect(result.count).toBe(3);
    expect(result.dropped).toBe(0);
  });

  it("rejects entries that become empty after redaction", () => {
    mockLearnings = [
      L({ id: "empty-1", category: "tooling", rule: "yannick" }),
      L({ id: "good-1", category: "tooling", rule: "Use a real test runner with a real reporter please" }),
    ];
    const out = join(tempHome, "tier-a.json");
    const result = exportLearnings({ tier: "A", outputPath: out });
    expect(result.count).toBe(1);
    expect(result.dropped).toBe(1);
    expect(result.rules[0].rule).toContain("real test runner");
  });

  it("emits hashed IDs that are deterministic across runs", () => {
    mockLearnings = [
      L({ id: "stable-id-42", category: "tooling", rule: "Pin your linter version in CI to avoid drift" }),
    ];
    const outA = join(tempHome, "run-a.json");
    const outB = join(tempHome, "run-b.json");
    const r1 = exportLearnings({ tier: "A", outputPath: outA });
    const r2 = exportLearnings({ tier: "A", outputPath: outB });
    expect(r1.rules[0].id).toBe(r2.rules[0].id);
    expect(r1.rules[0].id).toMatch(/^pub_[a-f0-9]{16}$/);
    expect(r1.rules[0].id).not.toBe("stable-id-42");
  });

  it("respects the 'safe' tag override — security-tagged + safe is allowed", () => {
    mockLearnings = [
      L({
        id: "safe-sec-1",
        category: "security",
        tags: ["safe"],
        rule: "Always use parameterized SQL queries to avoid injection vulnerabilities",
      }),
    ];
    const out = join(tempHome, "tier-a.json");
    const result = exportLearnings({ tier: "A", outputPath: out });
    expect(result.count).toBe(1);
  });

  it("hashes the project name to a short prefix", () => {
    mockLearnings = [
      L({
        id: "with-proj",
        category: "tooling",
        project: "MySecretClient",
        rule: "Always run npm ci instead of npm install in CI for reproducibility",
      }),
    ];
    const out = join(tempHome, "tier-a.json");
    const result = exportLearnings({ tier: "A", outputPath: out });
    expect(result.rules[0].project).toBeDefined();
    expect(result.rules[0].project).not.toBe("MySecretClient");
    expect(result.rules[0].project).toMatch(/^[a-f0-9]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// exportLearnings — Tier B
// ---------------------------------------------------------------------------

describe("exportLearnings — Tier B", () => {
  it("includes entries in the security category (PRO has full access)", () => {
    mockLearnings = [
      L({
        id: "sec-2",
        category: "security",
        rule: "Rotate the database password quarterly using the playbook in the wiki",
      }),
    ];
    const out = join(tempHome, "tier-b.json");
    const result = exportLearnings({ tier: "B", outputPath: out });
    expect(result.count).toBe(1);
  });

  it("still redacts PII even in Tier B", () => {
    const fixture_aws = "AK" + "IA" + "IOSFODNN7EXAMPLE";
    mockLearnings = [
      L({
        id: "pii-1",
        category: "security",
        rule: `Email someone-else@example.com when rotating the prod ${fixture_aws} key`,
      }),
    ];
    const out = join(tempHome, "tier-b.json");
    const result = exportLearnings({ tier: "B", outputPath: out });
    expect(result.rules[0].rule).not.toContain("someone-else@example.com");
    expect(result.rules[0].rule).not.toContain(fixture_aws);
    expect(result.rules[0].rule).toContain("[EMAIL]");
  });

  it("preserves original IDs in Tier B (authenticated PRO surface)", () => {
    mockLearnings = [
      L({ id: "original-uuid-xyz", category: "security", rule: "Lock the firewall to known IPs before opening any new port to the public" }),
    ];
    const out = join(tempHome, "tier-b.json");
    const result = exportLearnings({ tier: "B", outputPath: out });
    expect(result.rules[0].id).toBe("original-uuid-xyz");
  });
});

// ---------------------------------------------------------------------------
// Round-trip — disk JSON parses back into the in-memory shape
// ---------------------------------------------------------------------------

describe("exportLearnings — round-trip", () => {
  it("writes JSON to disk that re-parses with the same rules + schema", () => {
    mockLearnings = [
      L({ id: "rt-1", category: "tooling", rule: "Always run npm ci instead of npm install in CI for reproducible builds" }),
      L({ id: "rt-2", category: "git", rule: "Use git rebase -i for atomic logical commits before opening a PR" }),
    ];
    const out = join(tempHome, "round-trip.json");
    const result = exportLearnings({ tier: "A", outputPath: out });

    expect(existsSync(out)).toBe(true);
    const reparsed = JSON.parse(readFileSync(out, "utf-8"));
    expect(reparsed.version).toBe(1);
    expect(reparsed.tier).toBe("A");
    expect(typeof reparsed.generatedAt).toBe("string");
    expect(reparsed.count).toBe(result.count);
    expect(reparsed.dropped).toBe(result.dropped);
    expect(reparsed.rules).toHaveLength(result.rules.length);

    // Schema check: every rule has the documented keys.
    for (const r of reparsed.rules as ExportedRule[]) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.category).toBe("string");
      expect(typeof r.rule).toBe("string");
      expect(typeof r.context).toBe("string");
      expect(Array.isArray(r.tags)).toBe(true);
    }
  });

  it("writes the audit-log event for the export operation", () => {
    mockLearnings = [
      L({ id: "audit-1", category: "tooling", rule: "Pin tool versions in your lockfile so CI does not drift away" }),
    ];
    const out = join(tempHome, "audit-test.json");
    exportLearnings({ tier: "A", outputPath: out });
    const auditPath = join(tempHome, "audit.log");
    expect(existsSync(auditPath)).toBe(true);
    const lines = readFileSync(auditPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.event).toBe("learning.export");
    expect(last.payload.tier).toBe("A");
    expect(last.payload.count).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// __testing exports — sanity check the constants
// ---------------------------------------------------------------------------

describe("__testing constants", () => {
  it("PUBLIC_ID_SALT is versioned with v1", () => {
    expect(__testing.PUBLIC_ID_SALT).toContain("v1");
  });

  it("denies security/deployment/infrastructure in Tier A", () => {
    expect(__testing.TIER_A_DENIED_CATEGORIES.has("security")).toBe(true);
    expect(__testing.TIER_A_DENIED_CATEGORIES.has("deployment")).toBe(true);
    expect(__testing.TIER_A_DENIED_CATEGORIES.has("infrastructure")).toBe(true);
  });

  it("allows debugging / tooling / git in Tier A", () => {
    expect(__testing.TIER_A_ALLOWED_CATEGORIES.has("debugging")).toBe(true);
    expect(__testing.TIER_A_ALLOWED_CATEGORIES.has("tooling")).toBe(true);
    expect(__testing.TIER_A_ALLOWED_CATEGORIES.has("git")).toBe(true);
  });

  it("hashPublicId is deterministic and prefixed", () => {
    const a = __testing.hashPublicId("abc-123");
    const b = __testing.hashPublicId("abc-123");
    expect(a).toBe(b);
    expect(a.startsWith("pub_")).toBe(true);
  });

  it("hashProject collides for the same name regardless of casing", () => {
    const a = __testing.hashProject("MyProject");
    const b = __testing.hashProject("myproject");
    expect(a).toBe(b);
    expect(a.length).toBe(8);
  });
});

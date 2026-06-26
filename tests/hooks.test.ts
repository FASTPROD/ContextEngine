import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import {
  globToRegExp,
  matchesAnyGlob,
  runSecretScan,
  runDocCoverage,
  runCommitMessageRequired,
  extractBypassReason,
  stripBypassBranchFromPattern,
  formatCommitMessageViolations,
  formatCommitMessageViolationsJson,
  hashDocSection,
  formatSecretViolations,
  formatDocCoverageViolations,
  formatSecretViolationsJson,
  type StagedFile,
} from "../src/hooks.js";
import { PolicySchema, type Policy } from "../src/policy.js";

// ---------------------------------------------------------------------------
// Glob matcher
// ---------------------------------------------------------------------------

describe("globToRegExp", () => {
  it("matches a simple file pattern", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.test("src/foo.ts")).toBe(true);
    expect(re.test("src/foo.js")).toBe(false);
    expect(re.test("src/sub/foo.ts")).toBe(false);
  });

  it("** matches across directories", () => {
    const re = globToRegExp("docs/**/*.md");
    expect(re.test("docs/foo.md")).toBe(true);
    expect(re.test("docs/sessions/SESSION_03.md")).toBe(true);
    expect(re.test("docs/a/b/c/d.md")).toBe(true);
    expect(re.test("src/foo.md")).toBe(false);
  });

  it("? matches a single non-slash char", () => {
    const re = globToRegExp("file?.ts");
    expect(re.test("file1.ts")).toBe(true);
    expect(re.test("file12.ts")).toBe(false);
    expect(re.test("file/ts")).toBe(false);
  });

  it("escapes regex meta characters in literal segments", () => {
    const re = globToRegExp("a.b+c");
    expect(re.test("a.b+c")).toBe(true);
    expect(re.test("aXbXc")).toBe(false);
  });

  it("anchors at both ends (no partial matches)", () => {
    const re = globToRegExp("src/foo.ts");
    expect(re.test("src/foo.ts")).toBe(true);
    expect(re.test("src/foo.ts.bak")).toBe(false);
    expect(re.test("xsrc/foo.ts")).toBe(false);
  });
});

describe("matchesAnyGlob", () => {
  it("returns true when at least one glob matches", () => {
    expect(matchesAnyGlob("src/foo.ts", ["lib/*.ts", "src/*.ts"])).toBe(true);
  });
  it("returns false when none match", () => {
    expect(matchesAnyGlob("docs/x.md", ["src/*.ts", "tests/*.ts"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runSecretScan
// ---------------------------------------------------------------------------

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return PolicySchema.parse({ version: 1, ...overrides });
}

function staged(path: string, lines: string[]): StagedFile {
  return {
    path,
    addedLines: lines.map((content, i) => ({ lineNumber: i + 1, content })),
  };
}

describe("runSecretScan", () => {
  it("returns no violations when there are no patterns", () => {
    const policy = makePolicy();
    const files = [staged("src/foo.ts", ["const x = 1;"])];
    expect(runSecretScan(policy, files)).toEqual([]);
  });

  it("matches a global pattern across all files", () => {
    const policy = makePolicy({
      secret_patterns: [{ id: "stripe_live", pattern: "sk_live_[A-Za-z0-9]{8,}", severity: "block" }],
    });
    const files = [
      staged("src/foo.ts", ["const k = 'sk_live_AAAAAAAA';"]),
      staged("docs/x.md", ["see sk_live_BBBBBBBB"]),
    ];
    const v = runSecretScan(policy, files);
    expect(v).toHaveLength(2);
    expect(v[0].patternId).toBe("stripe_live");
    expect(v[0].severity).toBe("block");
  });

  it("honors paths-scoping (pattern only fires in matching files)", () => {
    const policy = makePolicy({
      secret_patterns: [
        {
          id: "jwt_in_session",
          pattern: "eyJ[A-Za-z0-9_=-]{8,}\\.[A-Za-z0-9_=-]{8,}\\.[A-Za-z0-9_=-]{8,}",
          paths: ["docs/sessions/**/*.md"],
          severity: "block",
        },
      ],
    });
    const jwt = "eyJAAAAAAAA.eyJBBBBBBBB.signatureCCCCCCCC";
    const files = [
      staged("src/foo.ts", [`const t = "${jwt}";`]), // OUT of scope — should not fire
      staged("docs/sessions/SESSION_99.md", [`token: ${jwt}`]), // in scope — should fire
    ];
    const v = runSecretScan(policy, files);
    expect(v).toHaveLength(1);
    expect(v[0].file).toBe("docs/sessions/SESSION_99.md");
  });

  it("reports the matched line number from the staged diff", () => {
    const policy = makePolicy({
      secret_patterns: [{ id: "x", pattern: "SECRET" }],
    });
    const files = [
      {
        path: "a.txt",
        addedLines: [
          { lineNumber: 10, content: "harmless" },
          { lineNumber: 11, content: "SECRET goes here" },
          { lineNumber: 12, content: "more harmless" },
        ],
      },
    ];
    const v = runSecretScan(policy, files);
    expect(v).toHaveLength(1);
    expect(v[0].lineNumber).toBe(11);
  });

  it("NEVER returns the matched value (redaction contract)", () => {
    const policy = makePolicy({
      secret_patterns: [{ id: "p", pattern: "VERY_SECRET_[A-Z]{6}" }],
    });
    const files = [staged("a.txt", ["here is VERY_SECRET_ABCDEF"])];
    const v = runSecretScan(policy, files);
    // The violation object must not carry the matched substring anywhere
    const serialized = JSON.stringify(v);
    expect(serialized).not.toContain("ABCDEF");
    expect(serialized).not.toContain("VERY_SECRET_ABCDEF");
  });
});

// ---------------------------------------------------------------------------
// runDocCoverage
// ---------------------------------------------------------------------------

let tempRepo: string;
beforeEach(() => {
  tempRepo = mkdtempSync(join(tmpdir(), "ce-hooks-test-"));
});
afterEach(() => {
  rmSync(tempRepo, { recursive: true, force: true });
});

describe("runDocCoverage", () => {
  it("no violations when no source files staged match any rule", () => {
    const policy = makePolicy({
      doc_coverage: [{ paths: ["src/firewall.ts"], requires_section: "DOC.md#x" }],
    });
    const files = [staged("README.md", ["nothing"])];
    expect(runDocCoverage(policy, files, tempRepo)).toEqual([]);
  });

  it("fires doc-section-not-found when the doc file is missing", () => {
    const policy = makePolicy({
      doc_coverage: [
        { paths: ["src/firewall.ts"], requires_section: "MISSING.md#x", severity: "block" },
      ],
    });
    const files = [staged("src/firewall.ts", ["+ added a thing"])];
    const v = runDocCoverage(policy, files, tempRepo);
    expect(v).toHaveLength(1);
    expect(v[0].reason).toBe("doc-section-not-found");
  });

  it("passes when the doc file is in the staged set (author IS updating it)", () => {
    writeFileSync(join(tempRepo, "DOC.md"), "# header\n\n## section\nbody\n");
    const policy = makePolicy({
      doc_coverage: [{ paths: ["src/firewall.ts"], requires_section: "DOC.md#section" }],
    });
    const files = [
      staged("src/firewall.ts", ["+changed"]),
      staged("DOC.md", ["+ also updated the doc"]),
    ];
    expect(runDocCoverage(policy, files, tempRepo)).toEqual([]);
  });

  it("fires doc-not-staged when the doc exists but isn't in this commit", () => {
    writeFileSync(join(tempRepo, "DOC.md"), "# header\n\n## section\nbody\n");
    const policy = makePolicy({
      doc_coverage: [
        { paths: ["src/firewall.ts"], requires_section: "DOC.md#section", severity: "block" },
      ],
    });
    const files = [staged("src/firewall.ts", ["+changed"])];
    const v = runDocCoverage(policy, files, tempRepo);
    expect(v).toHaveLength(1);
    expect(v[0].reason).toBe("doc-not-staged-and-section-unchanged");
    expect(v[0].matchedFiles).toEqual(["src/firewall.ts"]);
  });

  it("collects multiple violations across multiple rules in one pass", () => {
    writeFileSync(join(tempRepo, "DOC.md"), "# header");
    const policy = makePolicy({
      doc_coverage: [
        { paths: ["src/firewall.ts"], requires_section: "DOC.md#a", severity: "block" },
        { paths: ["src/activation.ts"], requires_section: "DOC.md#b", severity: "warn" },
      ],
    });
    const files = [
      staged("src/firewall.ts", ["+f"]),
      staged("src/activation.ts", ["+a"]),
    ];
    const v = runDocCoverage(policy, files, tempRepo);
    expect(v).toHaveLength(2);
    expect(v.find((x) => x.severity === "block")).toBeDefined();
    expect(v.find((x) => x.severity === "warn")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// hashDocSection
// ---------------------------------------------------------------------------

describe("hashDocSection", () => {
  it("returns null when the file doesn't exist", () => {
    expect(hashDocSection(join(tempRepo, "nope.md"), "section")).toBeNull();
  });

  it("hashes the lines under the matching anchor up to the next sibling", () => {
    writeFileSync(
      join(tempRepo, "DOC.md"),
      `# intro\n\n## section-a\nfirst line\nsecond line\n\n## section-b\nother\n`,
    );
    const h = hashDocSection(join(tempRepo, "DOC.md"), "section-a");
    expect(h).not.toBeNull();
    expect(h).toHaveLength(64);

    // Mutating the section content changes the hash
    writeFileSync(
      join(tempRepo, "DOC.md"),
      `# intro\n\n## section-a\nfirst line MUTATED\nsecond line\n\n## section-b\nother\n`,
    );
    const h2 = hashDocSection(join(tempRepo, "DOC.md"), "section-a");
    expect(h2).not.toBe(h);

    // Mutating a DIFFERENT section leaves section-a's hash stable
    writeFileSync(
      join(tempRepo, "DOC.md"),
      `# intro\n\n## section-a\nfirst line\nsecond line\n\n## section-b\nOTHER MUTATED\n`,
    );
    const h3 = hashDocSection(join(tempRepo, "DOC.md"), "section-a");
    expect(h3).toBe(h);
  });

  it("returns null for an anchor that doesn't exist in the doc", () => {
    writeFileSync(join(tempRepo, "DOC.md"), "# only-this");
    expect(hashDocSection(join(tempRepo, "DOC.md"), "missing-anchor")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

describe("formatters", () => {
  it("formatSecretViolations prints the clean-state line on empty input", () => {
    expect(formatSecretViolations([])).toMatch(/No policy secret patterns matched/);
  });

  it("formatDocCoverageViolations prints the clean-state line on empty input", () => {
    expect(formatDocCoverageViolations([])).toMatch(/All doc-coverage rules satisfied/);
  });

  it("formatSecretViolationsJson emits a parseable JSON object with counts", () => {
    const json = formatSecretViolationsJson([
      { patternId: "p", severity: "block", file: "a.ts", lineNumber: 1, patternSource: "x" },
      { patternId: "q", severity: "warn", file: "b.ts", lineNumber: 2, patternSource: "y" },
    ]);
    const parsed = JSON.parse(json);
    expect(parsed.check).toBe("secret-scan");
    expect(parsed.violations_total).toBe(2);
    expect(parsed.blocking).toBe(1);
    expect(parsed.warnings).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Smoke integration — exercise the real CE policy via getStagedFiles
// ---------------------------------------------------------------------------
// (Sanity: tests above are pure unit. This one verifies the live diff parser
// against a tiny ephemeral git repo so we know git output parsing works.)

describe("getStagedFiles integration", () => {
  it("parses a real staged diff into added-line records", async () => {
    const { getStagedFiles } = await import("../src/hooks.js");
    const repo = mkdtempSync(join(tmpdir(), "ce-hooks-git-"));
    try {
      execSync("git init -q", { cwd: repo });
      execSync('git config user.email "test@test.local"', { cwd: repo });
      execSync('git config user.name "test"', { cwd: repo });
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src/a.ts"), "line one\nline two\nline three\n");
      execSync("git add src/a.ts", { cwd: repo });

      const files = getStagedFiles(repo);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("src/a.ts");
      expect(files[0].addedLines.length).toBeGreaterThanOrEqual(3);
      expect(files[0].addedLines.map((l) => l.content)).toContain("line two");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns empty list when nothing is staged", async () => {
    const { getStagedFiles } = await import("../src/hooks.js");
    const repo = mkdtempSync(join(tmpdir(), "ce-hooks-empty-"));
    try {
      execSync("git init -q", { cwd: repo });
      expect(getStagedFiles(repo)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runCommitMessageRequired (Agent B — commit_message_required consumer)
// ---------------------------------------------------------------------------

const MULTI_AGENT_RULE = {
  id: "multi-agent-for-shared-infra",
  paths: [
    "server/deploy.sh",
    "server/ecosystem.config.*",
    "**/nginx*.conf",
    "compR.fr/deploy*.sh",
    "compR.fr/setup-symlink-deploy.sh",
  ],
  pattern: "Multi-agent: wf_[a-z0-9-]+|--skip-multi-agent-reason: .+",
  severity: "block" as const,
  description:
    "Multi-agent diagnostic required before changes to shared-infra files (per Session 15 lesson).",
};

describe("extractBypassReason", () => {
  it("returns null when no bypass marker is present", () => {
    expect(extractBypassReason("fix: ordinary commit")).toBeNull();
    expect(extractBypassReason("")).toBeNull();
  });

  it("extracts the trimmed reason after the marker", () => {
    const msg = "fix: deploy hotfix\n\n--skip-multi-agent-reason: prod outage, no time for diagnostic";
    expect(extractBypassReason(msg)).toBe("prod outage, no time for diagnostic");
  });

  it("ignores marker-too-short reasons", () => {
    // 1 char — both pre-fix (5) and post-fix (20) min length reject it.
    expect(extractBypassReason("--skip-multi-agent-reason: x")).toBeNull();
  });

  // Verifier Bypass #11: reason must be ≥ 20 chars AND contain whitespace.
  describe("Bypass #11 — reason content quality", () => {
    it("rejects reasons shorter than 20 chars (old 5-char floor was too lax)", () => {
      expect(extractBypassReason("--skip-multi-agent-reason: 12345")).toBeNull();
      expect(extractBypassReason("--skip-multi-agent-reason: short msg")).toBeNull();
    });

    it("rejects 20+ char reasons with no whitespace (alphanumeric defeat)", () => {
      // 30 alphanumeric chars, no spaces — clearly not prose.
      expect(
        extractBypassReason("--skip-multi-agent-reason: abcdef1234567890ABCDEFGHIJKLMN"),
      ).toBeNull();
    });

    it("accepts a real prose reason ≥ 20 chars with whitespace", () => {
      expect(
        extractBypassReason("--skip-multi-agent-reason: prod outage, no time"),
      ).toBe("prod outage, no time");
    });
  });

  // Verifier Bypass #5: bypass marker must be at the start of its own line
  // (only leading whitespace allowed before the prefix). A mid-line or
  // commented-out mention must NOT be treated as a valid bypass.
  describe("Bypass #5 — line-anchored bypass", () => {
    it("rejects a commented-out mention of the bypass marker", () => {
      const msg =
        "fix: deploy hotfix\n\n# Note: do NOT use --skip-multi-agent-reason: ever for this repo";
      expect(extractBypassReason(msg)).toBeNull();
    });

    it("rejects a mid-line mention of the bypass marker", () => {
      const msg =
        "fix: deploy hotfix\n\nsee README for --skip-multi-agent-reason: usage details only";
      expect(extractBypassReason(msg)).toBeNull();
    });

    it("rejects a quoted mention of the bypass marker", () => {
      const msg =
        "fix: deploy hotfix\n\n> --skip-multi-agent-reason: cited from old PR";
      expect(extractBypassReason(msg)).toBeNull();
    });

    it("accepts leading whitespace before the marker (real reason)", () => {
      const msg =
        "fix: deploy hotfix\n\n   --skip-multi-agent-reason: indented but legit reason for bypass";
      expect(extractBypassReason(msg)).toBe(
        "indented but legit reason for bypass",
      );
    });
  });
});

// Verifier Bypass #3: the policy pattern's bypass-marker branch must be
// stripped before the pattern is tested — the bypass path is owned by
// extractBypassReason ONLY (which is line-anchored + length-validated).
describe("stripBypassBranchFromPattern", () => {
  it("returns the pattern unchanged when no bypass branch is present", () => {
    expect(stripBypassBranchFromPattern("Multi-agent: wf_[a-z0-9-]+")).toBe(
      "Multi-agent: wf_[a-z0-9-]+",
    );
  });

  it("strips the bypass branch from the canonical policy pattern", () => {
    const input = "Multi-agent: wf_[a-z0-9-]+|--skip-multi-agent-reason: .+";
    expect(stripBypassBranchFromPattern(input)).toBe(
      "Multi-agent: wf_[a-z0-9-]+",
    );
  });

  it("returns null when every branch is a bypass branch", () => {
    expect(
      stripBypassBranchFromPattern("--skip-multi-agent-reason: .+"),
    ).toBeNull();
  });

  it("preserves multiple non-bypass branches", () => {
    const input = "Multi-agent: wf_[a-z0-9-]+|--skip-multi-agent-reason: .+|RELEASE-[0-9]+";
    expect(stripBypassBranchFromPattern(input)).toBe(
      "Multi-agent: wf_[a-z0-9-]+|RELEASE-[0-9]+",
    );
  });
});

describe("runCommitMessageRequired", () => {
  it("returns no violations when no staged file matches the rule", () => {
    const policy = PolicySchema.parse({
      version: 1,
      commit_message_required: [MULTI_AGENT_RULE],
    });
    const files = [staged("src/unrelated.ts", ["+harmless"])];
    expect(runCommitMessageRequired(policy, files, "fix: anything")).toEqual([]);
  });

  // Task #3 case 1: shared-infra file + no required pattern → BLOCK
  it("BLOCKS when a shared-infra file is staged without the required pattern", () => {
    const policy = PolicySchema.parse({
      version: 1,
      commit_message_required: [MULTI_AGENT_RULE],
    });
    const files = [staged("server/deploy.sh", ["+touched"])];
    const v = runCommitMessageRequired(policy, files, "fix: deploy patch");
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("missing-pattern");
    expect(v[0].severity).toBe("block");
    expect(v[0].ruleId).toBe("multi-agent-for-shared-infra");
    expect(v[0].matchedFiles).toEqual(["server/deploy.sh"]);
    expect(v[0].description).toMatch(/Session 15/);
  });

  // Task #3 case 2: shared-infra file + workflow ID cited → PASS
  it("PASSES when the commit body cites a Multi-agent workflow ID", () => {
    const policy = PolicySchema.parse({
      version: 1,
      commit_message_required: [MULTI_AGENT_RULE],
    });
    const files = [staged("server/deploy.sh", ["+touched"])];
    const msg =
      "feat(deploy): blue/green rollout\n\nMulti-agent: wf_wdcraou93-shared-infra\n\nVerified by Agent A + Agent B.";
    expect(runCommitMessageRequired(policy, files, msg)).toEqual([]);
  });

  // Task #3 case 3: bypass token → PASS + violation kind "bypass" so CLI
  // can append a policy.skipped audit event with the reason.
  it("BYPASSES with --skip-multi-agent-reason: marker and surfaces the reason", () => {
    const policy = PolicySchema.parse({
      version: 1,
      commit_message_required: [MULTI_AGENT_RULE],
    });
    const files = [staged("server/deploy.sh", ["+touched"])];
    const msg = "fix: prod hotfix\n\n--skip-multi-agent-reason: emergency rollback at 03:00 UTC";
    const v = runCommitMessageRequired(policy, files, msg);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("bypass");
    expect(v[0].bypassReason).toBe("emergency rollback at 03:00 UTC");
    expect(v[0].ruleId).toBe("multi-agent-for-shared-infra");
    expect(v[0].matchedFiles).toEqual(["server/deploy.sh"]);
  });

  it("matches the **/nginx*.conf glob (recursive)", () => {
    const policy = PolicySchema.parse({
      version: 1,
      commit_message_required: [MULTI_AGENT_RULE],
    });
    const files = [staged("etc/nginx/sites-enabled/nginx-app.conf", ["+x"])];
    const v = runCommitMessageRequired(policy, files, "fix: tweak nginx");
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("missing-pattern");
  });

  // Verifier Bypass #3: a commented-out bypass marker matched the policy
  // pattern's `--skip-multi-agent-reason: .+` branch and let the commit
  // through. After the fix, the pattern's bypass branch is stripped and
  // the mention is no longer a satisfying match — the rule fires.
  it("BLOCKS when only a commented-out bypass marker is present (verifier Bypass #3)", () => {
    const policy = PolicySchema.parse({
      version: 1,
      commit_message_required: [MULTI_AGENT_RULE],
    });
    const files = [staged("server/deploy.sh", ["+touched"])];
    const msg =
      "fix: deploy hotfix\n\n# Note: do NOT use --skip-multi-agent-reason: ever for this repo\n";
    const v = runCommitMessageRequired(policy, files, msg);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("missing-pattern");
    expect(v[0].severity).toBe("block");
  });

  it("BLOCKS when a mid-line bypass marker is present without real bypass", () => {
    const policy = PolicySchema.parse({
      version: 1,
      commit_message_required: [MULTI_AGENT_RULE],
    });
    const files = [staged("server/deploy.sh", ["+touched"])];
    const msg = "fix: see --skip-multi-agent-reason: docs for details on bypass";
    const v = runCommitMessageRequired(policy, files, msg);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("missing-pattern");
  });

  it("BLOCKS when bypass reason is too short (< 20 chars)", () => {
    const policy = PolicySchema.parse({
      version: 1,
      commit_message_required: [MULTI_AGENT_RULE],
    });
    const files = [staged("server/deploy.sh", ["+touched"])];
    // 12345 is exactly the verifier Bypass #11 attack input.
    const msg = "fix: hotfix\n\n--skip-multi-agent-reason: 12345";
    const v = runCommitMessageRequired(policy, files, msg);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("missing-pattern");
  });

  it("BLOCKS when bypass reason has no whitespace (alphanumeric defeat)", () => {
    const policy = PolicySchema.parse({
      version: 1,
      commit_message_required: [MULTI_AGENT_RULE],
    });
    const files = [staged("server/deploy.sh", ["+touched"])];
    const msg =
      "fix: hotfix\n\n--skip-multi-agent-reason: abcdef1234567890ABCDEFGHIJ";
    const v = runCommitMessageRequired(policy, files, msg);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("missing-pattern");
  });

  it("survives a malformed pattern in policy.json by surfacing as missing-pattern", () => {
    // Note: zod accepts any non-empty string for `pattern`; runtime
    // RegExp() may throw. Verify we don't crash.
    const policy = {
      version: 1 as const,
      secret_patterns: [],
      doc_coverage: [],
      deploy_verify_hosts: [],
      bypass_tokens: [],
      commit_message_required: [
        {
          id: "broken",
          paths: ["x/y.sh"],
          pattern: "([unclosed",
          severity: "block" as const,
        },
      ],
    };
    const files = [staged("x/y.sh", ["+x"])];
    const v = runCommitMessageRequired(policy, files, "any message");
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("missing-pattern");
  });
});

describe("formatCommitMessageViolations", () => {
  it("prints the clean-state line on empty input", () => {
    expect(formatCommitMessageViolations([])).toMatch(
      /All commit-message-required rules satisfied/,
    );
  });

  it("calls out the bypass reason for the audit reader", () => {
    const out = formatCommitMessageViolations([
      {
        kind: "bypass",
        severity: "block",
        ruleId: "multi-agent-for-shared-infra",
        matchedFiles: ["server/deploy.sh"],
        pattern: "x",
        bypassReason: "emergency",
      },
    ]);
    expect(out).toMatch(/\[bypass\]/);
    expect(out).toMatch(/emergency/);
    expect(out).toMatch(/logged to audit/);
  });

  it("formats JSON output with counts", () => {
    const json = formatCommitMessageViolationsJson([
      {
        kind: "missing-pattern",
        severity: "block",
        ruleId: "r1",
        matchedFiles: ["a.sh"],
        pattern: "p",
      },
      {
        kind: "bypass",
        severity: "block",
        ruleId: "r1",
        matchedFiles: ["b.sh"],
        pattern: "p",
        bypassReason: "ok",
      },
    ]);
    const parsed = JSON.parse(json);
    expect(parsed.check).toBe("commit-message-required");
    expect(parsed.violations_total).toBe(2);
    expect(parsed.blocking).toBe(1);
    expect(parsed.bypasses).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CLI integration — end-to-end behavior of `contextengine hook
// commit-message-required` against a real git repo, an explicit
// message-file path (the way the commit-msg hook invokes it), and the
// audit log. Verifies:
//   (1) shared-infra file + missing pattern → exit 1 + audit hook.block
//   (2) shared-infra file + workflow ID    → exit 0
//   (3) shared-infra file + bypass marker  → exit 0 + audit policy.skipped
//
// 2026-06-26 (verifier P0 fix): the previous version pre-wrote
// .git/COMMIT_EDITMSG and relied on the CLI reading it back. That hid the
// real bug — pre-commit fires BEFORE git writes COMMIT_EDITMSG, so in
// production the read was either empty (first commit) or stale (previous
// commit). The check now runs from the commit-msg hook, which receives
// the message file path as $1; tests mirror that shape by writing the
// message to a tmp file and passing the path as a positional arg.
// ---------------------------------------------------------------------------

describe("CLI: hook commit-message-required (integration)", () => {
  function setupRepo(opts: { commitMsg: string; touchFile?: string }): {
    repoRoot: string;
    auditHome: string;
    cliPath: string;
    commitMsgFile: string;
  } {
    const repoRoot = mkdtempSync(join(tmpdir(), "ce-cmr-repo-"));
    const auditHome = mkdtempSync(join(tmpdir(), "ce-cmr-audit-"));

    execSync("git init -q", { cwd: repoRoot });
    execSync('git config user.email "test@test.local"', { cwd: repoRoot });
    execSync('git config user.name "test"', { cwd: repoRoot });

    // Write policy.json with the canonical rule
    mkdirSync(join(repoRoot, ".contextengine"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".contextengine", "policy.json"),
      JSON.stringify(
        {
          version: 1,
          commit_message_required: [MULTI_AGENT_RULE],
        },
        null,
        2,
      ),
    );

    // Optionally stage a shared-infra file
    if (opts.touchFile) {
      const fullPath = join(repoRoot, opts.touchFile);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, "#!/bin/sh\necho hello\n");
      execSync(`git add "${opts.touchFile}"`, { cwd: repoRoot });
    }

    // Write the commit message to a discrete tmp file (mirrors the
    // commit-msg hook lifecycle: git writes the message, then passes
    // the path to the hook as $1). Crucially we do NOT pre-write
    // .git/COMMIT_EDITMSG — the new invocation shape relies on the
    // positional arg, and tests must exercise that path.
    const commitMsgFile = join(repoRoot, "COMMIT_MSG_TEST");
    writeFileSync(commitMsgFile, opts.commitMsg);

    // Resolve CLI from dist
    const cliPath = join(process.cwd(), "dist", "cli.js");
    return { repoRoot, auditHome, cliPath, commitMsgFile };
  }

  function runHook(
    repoRoot: string,
    auditHome: string,
    cliPath: string,
    commitMsgFile: string,
  ): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execSync(
        `node "${cliPath}" hook commit-message-required "${commitMsgFile}"`,
        {
          cwd: repoRoot,
          encoding: "utf-8",
          env: {
            ...process.env,
            CONTEXTENGINE_HOME: auditHome,
          },
        },
      );
      return { code: 0, stdout, stderr: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      return {
        code: err.status ?? -1,
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
      };
    }
  }

  function readAudit(auditHome: string): unknown[] {
    const auditPath = join(auditHome, "audit.log");
    if (!existsSync(auditPath)) return [];
    const raw = readFileSync(auditPath, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  it("BLOCKS commit touching server/deploy.sh without required pattern", () => {
    const ctx = setupRepo({
      commitMsg: "fix: small deploy tweak\n",
      touchFile: "server/deploy.sh",
    });
    try {
      const r = runHook(ctx.repoRoot, ctx.auditHome, ctx.cliPath, ctx.commitMsgFile);
      expect(r.code).toBe(1);
      expect(r.stdout + r.stderr).toMatch(/multi-agent-for-shared-infra/);
      const audit = readAudit(ctx.auditHome);
      const blockEvents = audit.filter(
        (e) => (e as { event: string }).event === "hook.block",
      );
      expect(blockEvents.length).toBeGreaterThanOrEqual(1);
      const blk = blockEvents[0] as { payload: Record<string, unknown> };
      expect(blk.payload.check).toBe("commit-message-required");
      expect(blk.payload.rule_id).toBe("multi-agent-for-shared-infra");
    } finally {
      rmSync(ctx.repoRoot, { recursive: true, force: true });
      rmSync(ctx.auditHome, { recursive: true, force: true });
    }
  });

  it("PASSES commit touching server/deploy.sh WITH Multi-agent: wf_… pattern", () => {
    const ctx = setupRepo({
      commitMsg:
        "feat(deploy): blue/green rollout\n\nMulti-agent: wf_wdcraou93-shared-infra\n",
      touchFile: "server/deploy.sh",
    });
    try {
      const r = runHook(ctx.repoRoot, ctx.auditHome, ctx.cliPath, ctx.commitMsgFile);
      expect(r.code).toBe(0);
      const audit = readAudit(ctx.auditHome);
      const blocks = audit.filter(
        (e) => (e as { event: string }).event === "hook.block",
      );
      expect(blocks).toHaveLength(0);
    } finally {
      rmSync(ctx.repoRoot, { recursive: true, force: true });
      rmSync(ctx.auditHome, { recursive: true, force: true });
    }
  });

  it("PASSES with --skip-multi-agent-reason: bypass AND logs policy.skipped", () => {
    const ctx = setupRepo({
      commitMsg:
        "fix: prod rollback\n\n--skip-multi-agent-reason: ssh outage, multi-agent unavailable\n",
      touchFile: "server/deploy.sh",
    });
    try {
      const r = runHook(ctx.repoRoot, ctx.auditHome, ctx.cliPath, ctx.commitMsgFile);
      expect(r.code).toBe(0);
      const audit = readAudit(ctx.auditHome);
      const skipped = audit.filter(
        (e) => (e as { event: string }).event === "policy.skipped",
      );
      expect(skipped).toHaveLength(1);
      const evt = skipped[0] as { payload: Record<string, unknown> };
      expect(evt.payload.check).toBe("commit-message-required");
      expect(evt.payload.rule_id).toBe("multi-agent-for-shared-infra");
      expect(evt.payload.bypass_reason).toBe(
        "ssh outage, multi-agent unavailable",
      );
      // No hook.block when bypassed
      const blocks = audit.filter(
        (e) => (e as { event: string }).event === "hook.block",
      );
      expect(blocks).toHaveLength(0);
    } finally {
      rmSync(ctx.repoRoot, { recursive: true, force: true });
      rmSync(ctx.auditHome, { recursive: true, force: true });
    }
  });

  // Verifier Bypass #3 closed: a commented-out mention of the bypass
  // marker no longer satisfies the policy pattern's stripped form.
  it("BLOCKS when commit body has a commented-out bypass marker only", () => {
    const ctx = setupRepo({
      commitMsg:
        "fix: deploy tweak\n\n# Note: do NOT use --skip-multi-agent-reason: ever for this repo\n",
      touchFile: "server/deploy.sh",
    });
    try {
      const r = runHook(ctx.repoRoot, ctx.auditHome, ctx.cliPath, ctx.commitMsgFile);
      expect(r.code).toBe(1);
      const audit = readAudit(ctx.auditHome);
      const blocks = audit.filter(
        (e) => (e as { event: string }).event === "hook.block",
      );
      expect(blocks.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(ctx.repoRoot, { recursive: true, force: true });
      rmSync(ctx.auditHome, { recursive: true, force: true });
    }
  });

  // Verifier Bypass #11 closed: bypass reason "12345" no longer satisfies
  // the bypass — 20-char floor + whitespace requirement reject it.
  it("BLOCKS when bypass reason is short alphanumeric (verifier Bypass #11)", () => {
    const ctx = setupRepo({
      commitMsg: "fix: hotfix\n\n--skip-multi-agent-reason: 12345\n",
      touchFile: "server/deploy.sh",
    });
    try {
      const r = runHook(ctx.repoRoot, ctx.auditHome, ctx.cliPath, ctx.commitMsgFile);
      expect(r.code).toBe(1);
    } finally {
      rmSync(ctx.repoRoot, { recursive: true, force: true });
      rmSync(ctx.auditHome, { recursive: true, force: true });
    }
  });
});

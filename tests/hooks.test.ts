import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import {
  globToRegExp,
  matchesAnyGlob,
  runSecretScan,
  runDocCoverage,
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

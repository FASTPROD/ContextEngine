import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  installSkill,
  locateBundledSkill,
  buildManagedBlock,
  syncClaudeMd,
  discoverClaudeMemory,
  decodeClaudeProjectSlug,
  _markers,
} from "../src/claude-integration.js";

// ---------------------------------------------------------------------------
// A. installSkill
// ---------------------------------------------------------------------------

let bundledDir: string;
let homeDir: string;

beforeEach(() => {
  bundledDir = mkdtempSync(join(tmpdir(), "ce-skill-src-"));
  homeDir = mkdtempSync(join(tmpdir(), "ce-skill-home-"));
});

afterEach(() => {
  rmSync(bundledDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe("installSkill", () => {
  it("fails clearly when the bundled SKILL.md is missing", () => {
    const r = installSkill(bundledDir, { scope: "global", cwd: homeDir });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Bundled skill not found/);
  });

  it("installs a fresh skill to a project .claude/skills/opscontext/", () => {
    writeFileSync(join(bundledDir, "SKILL.md"), "---\nname: opscontext\n---\nbody");
    const projectDir = mkdtempSync(join(tmpdir(), "ce-skill-proj-"));
    try {
      const r = installSkill(bundledDir, { scope: "project", cwd: projectDir, force: false });
      expect(r.ok).toBe(true);
      const installed = join(projectDir, ".claude", "skills", "opscontext", "SKILL.md");
      expect(existsSync(installed)).toBe(true);
      expect(readFileSync(installed, "utf-8")).toContain("name: opscontext");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("reports alreadyInstalled when target exists without --force", () => {
    writeFileSync(join(bundledDir, "SKILL.md"), "v1");
    const projectDir = mkdtempSync(join(tmpdir(), "ce-skill-proj-"));
    try {
      mkdirSync(join(projectDir, ".claude", "skills", "opscontext"), { recursive: true });
      writeFileSync(join(projectDir, ".claude", "skills", "opscontext", "SKILL.md"), "existing");
      const r = installSkill(bundledDir, { scope: "project", cwd: projectDir, force: false });
      expect(r.ok).toBe(true);
      expect(r.alreadyInstalled).toBe(true);
      // Existing file untouched
      expect(readFileSync(join(projectDir, ".claude", "skills", "opscontext", "SKILL.md"), "utf-8"))
        .toBe("existing");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("overwrites when --force is set", () => {
    writeFileSync(join(bundledDir, "SKILL.md"), "v2");
    const projectDir = mkdtempSync(join(tmpdir(), "ce-skill-proj-"));
    try {
      mkdirSync(join(projectDir, ".claude", "skills", "opscontext"), { recursive: true });
      writeFileSync(join(projectDir, ".claude", "skills", "opscontext", "SKILL.md"), "old");
      const r = installSkill(bundledDir, { scope: "project", cwd: projectDir, force: true });
      expect(r.ok).toBe(true);
      expect(r.alreadyInstalled).toBeUndefined();
      expect(readFileSync(join(projectDir, ".claude", "skills", "opscontext", "SKILL.md"), "utf-8"))
        .toBe("v2");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("locateBundledSkill walks ../skills/opscontext from the cli dist dir", () => {
    // dist/cli.js → ../skills/opscontext/
    const distDir = "/some/path/dist";
    const located = locateBundledSkill(distDir);
    expect(located).toBe("/some/path/skills/opscontext");
  });
});

// ---------------------------------------------------------------------------
// B. CLAUDE.md managed block — pure function
// ---------------------------------------------------------------------------

describe("buildManagedBlock", () => {
  const baseInput = {
    projectName: "test-proj",
    topLearnings: [],
    policySummary: null,
    recentBlocks: [],
    generatedAt: "2026-06-11T12:00:00Z",
  };

  it("wraps content in the canonical BEGIN/END markers", () => {
    const block = buildManagedBlock(baseInput);
    expect(block).toContain(_markers.BEGIN_MARKER);
    expect(block).toContain(_markers.END_MARKER);
    expect(block.indexOf(_markers.BEGIN_MARKER)).toBeLessThan(block.indexOf(_markers.END_MARKER));
  });

  it("includes the project name in the heading", () => {
    const block = buildManagedBlock({ ...baseInput, projectName: "my-cool-repo" });
    expect(block).toContain("my-cool-repo");
  });

  it("renders top learnings as a bulleted list with id + category", () => {
    const block = buildManagedBlock({
      ...baseInput,
      topLearnings: [
        { id: "L1", category: "deployment", rule: "Never use bare node in mcp.json" },
        { id: "L2", category: "security", rule: "Parameterize SQL queries" },
      ],
    });
    expect(block).toContain("L1");
    expect(block).toContain("deployment");
    expect(block).toContain("Never use bare node in mcp.json");
    expect(block).toContain("L2");
  });

  it("truncates long rules to fit token budget", () => {
    const longRule = "x".repeat(500);
    const block = buildManagedBlock({
      ...baseInput,
      topLearnings: [{ id: "L1", category: "other", rule: longRule }],
    });
    // 180-char cap per buildManagedBlock impl
    const ruleLine = block.split("\n").find((l) => l.includes("L1")) || "";
    expect(ruleLine.length).toBeLessThan(longRule.length);
  });

  it("renders policy summary counts when policy is present", () => {
    const block = buildManagedBlock({
      ...baseInput,
      policySummary: {
        secretPatternCount: 3,
        secretPatternIds: ["jwt", "openai", "anthropic"],
        docCoverageCount: 4,
        deployVerifyHostCount: 1,
        bypassTokenCount: 1,
      },
    });
    expect(block).toMatch(/3 secret pattern/);
    expect(block).toMatch(/4 doc-coverage/);
    expect(block).toMatch(/1 deploy-verify/);
    expect(block).toMatch(/1 bypass/);
    expect(block).toContain("jwt");
  });

  it("hints at policy authoring when no policy exists", () => {
    const block = buildManagedBlock({ ...baseInput, policySummary: null });
    expect(block).toMatch(/No `\.contextengine\/policy\.json`/);
  });

  it("renders recent hook blocks with a date prefix", () => {
    const block = buildManagedBlock({
      ...baseInput,
      recentBlocks: [
        { ts: "2026-06-10T12:00:00.000Z", check: "secret-scan", reason: "stripe live key in src/x.ts:42" },
      ],
    });
    expect(block).toContain("2026-06-10");
    expect(block).toContain("secret-scan");
    expect(block).toContain("stripe live key");
  });
});

// ---------------------------------------------------------------------------
// B. syncClaudeMd — disk integration
// ---------------------------------------------------------------------------

describe("syncClaudeMd", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ce-sync-test-"));
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("creates CLAUDE.md when missing", () => {
    const filePath = join(projectDir, "CLAUDE.md");
    const block = `${_markers.BEGIN_MARKER}\nbody\n${_markers.END_MARKER}`;
    const r = syncClaudeMd(filePath, block);
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("created-new-file");
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# CLAUDE.md");
    expect(content).toContain("body");
  });

  it("appends a new block when CLAUDE.md exists but has no markers", () => {
    const filePath = join(projectDir, "CLAUDE.md");
    writeFileSync(filePath, "# my own claude.md\n\nuser content here\n");
    const block = `${_markers.BEGIN_MARKER}\nbody\n${_markers.END_MARKER}`;
    const r = syncClaudeMd(filePath, block);
    expect(r.mode).toBe("appended-new-block");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# my own claude.md");
    expect(content).toContain("user content here");
    expect(content).toContain("body");
  });

  it("replaces the existing block in place (idempotent re-sync)", () => {
    const filePath = join(projectDir, "CLAUDE.md");
    const oldBlock = `${_markers.BEGIN_MARKER}\nOLD content\n${_markers.END_MARKER}`;
    writeFileSync(filePath, `# top\n\n${oldBlock}\n\n# bottom\n`);

    const newBlock = `${_markers.BEGIN_MARKER}\nNEW content\n${_markers.END_MARKER}`;
    const r = syncClaudeMd(filePath, newBlock);
    expect(r.mode).toBe("replaced-existing-block");

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# top");
    expect(content).toContain("# bottom");
    expect(content).toContain("NEW content");
    expect(content).not.toContain("OLD content");
    // Markers must still be unique (no doubling)
    expect(content.match(new RegExp(_markers.BEGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);
  });

  it("is idempotent — running twice with the same input is a no-op", () => {
    const filePath = join(projectDir, "CLAUDE.md");
    const block = `${_markers.BEGIN_MARKER}\nsame content\n${_markers.END_MARKER}`;
    syncClaudeMd(filePath, block);
    const after1 = readFileSync(filePath, "utf-8");
    syncClaudeMd(filePath, block);
    const after2 = readFileSync(filePath, "utf-8");
    expect(after2).toBe(after1);
  });
});

// ---------------------------------------------------------------------------
// C. Claude memory discovery
// ---------------------------------------------------------------------------

describe("discoverClaudeMemory", () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "ce-claude-home-"));
  });
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("returns empty when ~/.claude/projects doesn't exist", () => {
    expect(discoverClaudeMemory({ home: fakeHome })).toEqual([]);
  });

  it("discovers all .md files under <slug>/memory/ across multiple projects", () => {
    const projectA = join(fakeHome, ".claude", "projects", "-Users-yan-Projects-Foo");
    const projectB = join(fakeHome, ".claude", "projects", "-Users-yan-Projects-Bar");
    mkdirSync(join(projectA, "memory"), { recursive: true });
    mkdirSync(join(projectB, "memory"), { recursive: true });
    writeFileSync(join(projectA, "memory", "MEMORY.md"), "# memory index");
    writeFileSync(join(projectA, "memory", "feedback_x.md"), "feedback");
    writeFileSync(join(projectB, "memory", "MEMORY.md"), "# bar memory");

    const result = discoverClaudeMemory({ home: fakeHome });
    expect(result).toHaveLength(3);
    expect(result.every((s) => s.type === "markdown")).toBe(true);
    expect(result.map((s) => s.name).some((n) => n.includes("Foo"))).toBe(true);
    expect(result.map((s) => s.name).some((n) => n.includes("Bar"))).toBe(true);
  });

  it("skips non-.md files (sidecar metadata, etc.)", () => {
    const projectDir = join(fakeHome, ".claude", "projects", "-test", "memory");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "MEMORY.md"), "indexed");
    writeFileSync(join(projectDir, "index.json"), "{}");
    writeFileSync(join(projectDir, "notes.txt"), "ignored");

    const result = discoverClaudeMemory({ home: fakeHome });
    expect(result).toHaveLength(1);
    expect(result[0].name).toContain("MEMORY.md");
  });

  it("skips project dirs without a memory/ subdir", () => {
    const projectDir = join(fakeHome, ".claude", "projects", "-empty");
    mkdirSync(projectDir, { recursive: true });
    expect(discoverClaudeMemory({ home: fakeHome })).toEqual([]);
  });
});

describe("decodeClaudeProjectSlug", () => {
  it("turns a leading hyphen back into a slash", () => {
    expect(decodeClaudeProjectSlug("-Users-yan-Projects-Foo")).toBe("/Users-yan-Projects-Foo");
  });

  it("leaves non-prefixed names alone", () => {
    expect(decodeClaudeProjectSlug("ordinary-name")).toBe("ordinary-name");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scoreProject } from "../src/agents.js";

let tempRepo: string;

beforeEach(() => {
  tempRepo = mkdtempSync(join(tmpdir(), "ce-scoring-test-"));
});

afterEach(() => {
  rmSync(tempRepo, { recursive: true, force: true });
});

/** Write a markdown file with `lines` newline-separated lines. */
function writeDoc(path: string, lines: number): void {
  writeFileSync(path, Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n"), "utf-8");
}

/** Pull a single named check out of a score result. */
function check(name: string, path: string) {
  const score = scoreProject({ name: "fixture", path } as never);
  const found = score.checks.find(c => c.name === name);
  if (!found) throw new Error(`check "${name}" not present in score result`);
  return found;
}

// 🔒 [DOC-PATH-DUAL] — these tests exist to stop a regression to `.github/`-only
// path resolution in scoreProject(). See the LOCK block on resolveDocPath in src/agents.ts.
describe("scoreProject — agent docs resolve at .github/ OR repo root", () => {
  it("scores copilot-instructions.md in .github/", () => {
    mkdirSync(join(tempRepo, ".github"));
    writeDoc(join(tempRepo, ".github", "copilot-instructions.md"), 60);

    const c = check("copilot-instructions.md", tempRepo);
    expect(c.points).toBe(10);
    expect(c.status).toBe("pass");
    expect(c.detail).toContain(".github/copilot-instructions.md");
  });

  it("scores copilot-instructions.md at the repo root", () => {
    writeDoc(join(tempRepo, "copilot-instructions.md"), 60);

    const c = check("copilot-instructions.md", tempRepo);
    expect(c.points).toBe(10);
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("copilot-instructions.md");
    expect(c.detail).not.toContain(".github/");
  });

  it("scores SKILLS.md in .github/", () => {
    mkdirSync(join(tempRepo, ".github"));
    writeDoc(join(tempRepo, ".github", "SKILLS.md"), 20);

    const c = check("SKILLS.md", tempRepo);
    expect(c.points).toBe(3);
    expect(c.status).toBe("pass");
    expect(c.detail).toContain(".github/SKILLS.md");
  });

  it("scores SKILLS.md at the repo root — where `contextengine init` writes it", () => {
    writeDoc(join(tempRepo, "SKILLS.md"), 20);

    const c = check("SKILLS.md", tempRepo);
    expect(c.points).toBe(3);
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("SKILLS.md");
    expect(c.detail).not.toContain(".github/");
  });

  it("prefers .github/ when the doc exists in both locations", () => {
    mkdirSync(join(tempRepo, ".github"));
    writeDoc(join(tempRepo, ".github", "SKILLS.md"), 20);
    writeDoc(join(tempRepo, "SKILLS.md"), 40);

    const c = check("SKILLS.md", tempRepo);
    expect(c.detail).toContain(".github/SKILLS.md");
    expect(c.detail).toContain("20 lines"); // the .github/ copy, not the 40-line root one
  });

  it("fails both checks when neither location has the doc, and says so", () => {
    const copilot = check("copilot-instructions.md", tempRepo);
    expect(copilot.points).toBe(0);
    expect(copilot.status).toBe("fail");
    expect(copilot.detail).toContain(".github/");
    expect(copilot.detail).toContain("repo root");

    const skills = check("SKILLS.md", tempRepo);
    expect(skills.points).toBe(0);
    expect(skills.status).toBe("fail");
    expect(skills.detail).toContain("repo root");
  });

  it("still penalizes a root-located symlink the same as a .github/ one", () => {
    writeDoc(join(tempRepo, "real-instructions.md"), 60);
    symlinkSync(join(tempRepo, "real-instructions.md"), join(tempRepo, "copilot-instructions.md"));

    const c = check("copilot-instructions.md", tempRepo);
    expect(c.points).toBe(4);
    expect(c.status).toBe("partial");
    expect(c.detail).toContain("Symlink");
  });
});

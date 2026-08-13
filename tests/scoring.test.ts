import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scoreProject, runScoreCanary } from "../src/agents.js";

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

  it("reports a DANGLING post-commit symlink as broken, not as 'no hooks'", () => {
    // The 2026-06-10 incident: .git/hooks/post-commit -> ../../hooks/post-commit, target deleted.
    // existsSync() follows symlinks, so this used to be indistinguishable from "never configured".
    mkdirSync(join(tempRepo, ".git", "hooks"), { recursive: true });
    symlinkSync(join(tempRepo, "hooks", "post-commit"), join(tempRepo, ".git", "hooks", "post-commit"));

    const c = check("Git hooks", tempRepo);
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("BROKEN");
    expect(c.detail).toContain("dangling symlink");
    // Must NOT tell the user to set up a hook they already have
    expect(c.detail).not.toContain("No post-commit hook");
  });

  it("reports a working post-commit hook as pass, naming where it found it", () => {
    mkdirSync(join(tempRepo, ".git", "hooks"), { recursive: true });
    writeFileSync(join(tempRepo, ".git", "hooks", "post-commit"), "#!/bin/sh\ntrue\n", "utf-8");

    const c = check("Git hooks", tempRepo);
    expect(c.status).toBe("pass");
    expect(c.detail).toContain(".git/hooks/post-commit");
  });

  it("distinguishes 'no hook' from 'broken hook'", () => {
    const c = check("Git hooks", tempRepo);
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("No post-commit hook");
    expect(c.detail).not.toContain("BROKEN");
  });
});

describe("scoreProject — absence is not a verdict", () => {
  it("marks .env-without-git as unknown instead of awarding a 6/6 pass", () => {
    writeFileSync(join(tempRepo, ".env"), "SECRET=x\n", "utf-8"); // no .git/ anywhere

    const c = check("Secrets exposure", tempRepo);
    expect(c.status).toBe("unknown");
    expect(c.points).toBe(0);
    expect(c.detail).toContain("cannot verify");
  });

  it("still passes cleanly when there is genuinely no .env", () => {
    const c = check("Secrets exposure", tempRepo);
    expect(c.status).toBe("pass");
    expect(c.points).toBe(6);
    expect(c.detail).toContain("No .env");
  });

  it("pins the denominator to 100 and surfaces skipped checks as a visible gap", () => {
    // A project with no .gitignore never emits the "Deps gitignored" check, which used to
    // shrink maxScore to 97 and silently rescale the percentage.
    const score = scoreProject({ name: "fixture", path: tempRepo } as never);
    expect(score.maxScore).toBe(100);

    const gap = score.checks.find(c => c.name === "Scoring completeness");
    expect(gap).toBeDefined();
    expect(gap!.status).toBe("unknown");
    expect(gap!.points).toBe(0);
    expect(score.checks.reduce((s, c) => s + c.maxPoints, 0)).toBe(100);
  });

  it("emits no completeness gap when every check can run", () => {
    // Every conditionally-emitted check needs its precondition: .gitignore gates "Deps gitignored",
    // package.json gates "npm scripts", and a lockfile gates "Lockfile".
    writeFileSync(join(tempRepo, ".gitignore"), ".env\nnode_modules\ndist\n", "utf-8");
    writeFileSync(join(tempRepo, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }), "utf-8");
    writeFileSync(join(tempRepo, "package-lock.json"), "{}", "utf-8");

    const score = scoreProject({ name: "fixture", path: tempRepo } as never);

    expect(score.checks.find(c => c.name === "Scoring completeness")).toBeUndefined();
    expect(score.checks.reduce((s, c) => s + c.maxPoints, 0)).toBe(100);
    expect(score.maxScore).toBe(100);
  });

  it("names the unassessable points rather than shrinking the denominator", () => {
    // A non-JS project cannot be scored on npm scripts or a lockfile. The old behaviour scored it
    // out of 94 and printed a percentage as if it were out of 100.
    const score = scoreProject({ name: "fixture", path: tempRepo } as never);
    const gap = score.checks.find(c => c.name === "Scoring completeness")!;

    expect(gap.maxPoints).toBe(9); // npm scripts (3) + Lockfile (3) + Deps gitignored (3)
    expect(score.maxScore).toBe(100);
    expect(score.percentage).toBe(Math.round((score.score / 100) * 100));
  });
});

describe("runScoreCanary", () => {
  it("passes against the current scorer", () => {
    const r = runScoreCanary();
    expect(r.inconclusive).toBe(false);
    expect(r.deviations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("cleans up its temp fixture", () => {
    // Two consecutive runs must not accumulate state or interfere.
    expect(runScoreCanary().ok).toBe(true);
    expect(runScoreCanary().ok).toBe(true);
  });
});

describe("scoreProject — doc path resolution, continued", () => {
  it("still penalizes a root-located symlink the same as a .github/ one", () => {
    writeDoc(join(tempRepo, "real-instructions.md"), 60);
    symlinkSync(join(tempRepo, "real-instructions.md"), join(tempRepo, "copilot-instructions.md"));

    const c = check("copilot-instructions.md", tempRepo);
    expect(c.points).toBe(4);
    expect(c.status).toBe("partial");
    expect(c.detail).toContain("Symlink");
  });
});

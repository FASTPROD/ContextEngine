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

/** An agent doc covering every required topic — full content marks regardless of length. */
function writeAgentDoc(path: string): void {
  writeFileSync(path, [
    "# P", "## Architecture", "Modules and entry point.",
    "## Commands", "`npm run build`.",
    "## Rules", "Never commit secrets.",
    "## Key files", "`src/index.ts`.",
  ].join("\n"), "utf-8");
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
    writeAgentDoc(join(tempRepo, ".github", "copilot-instructions.md"));

    const c = check("copilot-instructions.md", tempRepo);
    expect(c.points).toBe(6);
    expect(c.status).toBe("pass");
    expect(c.detail).toContain(".github/copilot-instructions.md");
  });

  it("scores copilot-instructions.md at the repo root", () => {
    writeAgentDoc(join(tempRepo, "copilot-instructions.md"));

    const c = check("copilot-instructions.md", tempRepo);
    expect(c.points).toBe(6);
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
    expect(c.points).toBe(10);
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

    expect(gap.maxPoints).toBe(13); // npm scripts (3) + Lockfile (5) + Deps gitignored (5)
    expect(score.maxScore).toBe(100);
    expect(score.percentage).toBe(Math.round((score.score / 100) * 100));
  });
});

// 🔒 [SCORE-CONTENT-NOT-LENGTH] + [SECURITY-IS-DISQUALIFYING] + [SCORE-DOC-FRESHNESS]
describe("scoreProject — the 2026-08-14 rubric rework", () => {
  it("a short doc covering every topic beats a long one covering none", () => {
    const short = mkdtempSync(join(tmpdir(), "ce-short-"));
    const long = mkdtempSync(join(tmpdir(), "ce-long-"));
    try {
      writeAgentDoc(join(short, "copilot-instructions.md"));   // 9 lines, all 4 topics
      writeDoc(join(long, "copilot-instructions.md"), 500);     // 500 lines of "line N"

      const shortScore = check("copilot-instructions.md", short);
      const longScore = check("copilot-instructions.md", long);

      expect(shortScore.points).toBe(6);
      expect(shortScore.points).toBeGreaterThan(longScore.points);
      expect(longScore.detail).toContain("length without structure");
    } finally {
      rmSync(short, { recursive: true, force: true });
      rmSync(long, { recursive: true, force: true });
    }
  });

  it("gives partial credit for partial topic coverage and names what is missing", () => {
    writeFileSync(
      join(tempRepo, "copilot-instructions.md"),
      ["# P", "## Architecture", "Modules.", ...Array.from({ length: 20 }, (_, i) => `x ${i}`)].join("\n"),
      "utf-8"
    );
    const c = check("copilot-instructions.md", tempRepo);
    expect(c.status).toBe("partial");
    expect(c.detail).toContain("missing");
    expect(c.detail).toContain("key files");
  });

  it("caps the grade at C when .env is not gitignored, however good everything else is", () => {
    // .gitignore exists but omits .env — the disqualifying condition.
    writeFileSync(join(tempRepo, ".gitignore"), "node_modules\ndist\n", "utf-8");
    writeAgentDoc(join(tempRepo, "copilot-instructions.md"));
    writeDoc(join(tempRepo, "README.md"), 100);
    writeFileSync(join(tempRepo, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }), "utf-8");
    writeFileSync(join(tempRepo, "package-lock.json"), "{}", "utf-8");

    const score = scoreProject({ name: "fixture", path: tempRepo } as never);
    const envCheck = score.checks.find(c => c.name === ".env in .gitignore")!;

    expect(envCheck.status).toBe("fail");
    expect(envCheck.disqualifying).toBe(true);
    expect(envCheck.detail).toContain("Caps this project's grade at C");
    expect(["C", "D", "F"]).toContain(score.grade);
    // The percentage stays honest — only the GRADE is capped.
    expect(score.score).toBeGreaterThan(0);
  });

  it("does not let a missing lockfile disqualify anything — hygiene is not exposure", () => {
    writeFileSync(join(tempRepo, ".gitignore"), ".env\nnode_modules\n", "utf-8");
    writeFileSync(join(tempRepo, "package.json"), "{}", "utf-8");

    const score = scoreProject({ name: "fixture", path: tempRepo } as never);
    const lock = score.checks.find(c => c.name === "Lockfile");

    expect(lock?.status).toBe("fail");
    expect(lock?.disqualifying).toBeUndefined();
  });

  it("reports doc freshness as unknown outside a git repo, never as current", () => {
    // Regression guard: `git log ... | wc -l` reports wc's exit status, so a failed git log
    // returned "0" and read as "0 commits since the doc changed — fully current".
    writeAgentDoc(join(tempRepo, "copilot-instructions.md"));

    const c = check("Doc freshness", tempRepo);
    expect(c.status).toBe("unknown");
    expect(c.points).toBe(0);
  });

  it("keeps the four category weights at 25/25/20/30", () => {
    writeFileSync(join(tempRepo, ".gitignore"), ".env\nnode_modules\ndist\n", "utf-8");
    writeFileSync(join(tempRepo, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }), "utf-8");
    writeFileSync(join(tempRepo, "package-lock.json"), "{}", "utf-8");

    const score = scoreProject({ name: "fixture", path: tempRepo } as never);
    const byCat: Record<string, number> = {};
    for (const c of score.checks) byCat[c.category] = (byCat[c.category] ?? 0) + c.maxPoints;

    expect(byCat["Documentation"]).toBe(25);
    expect(byCat["Infrastructure"]).toBe(25);
    expect(byCat["Code Quality"]).toBe(20);
    expect(byCat["Security"]).toBe(30);
  });
});

// 🔒 [SCORE-LANGUAGE-AWARE] — reported from the Odoo connector: a Python addon with 15 passing
// tests scored "No test directory", "No tsconfig/jsconfig" and "No lint config".
describe("scoreProject — nested tests and non-JS projects", () => {
  it("finds tests one level down, where Odoo addons and src-layouts keep them", () => {
    mkdirSync(join(tempRepo, "my_module", "tests"), { recursive: true });
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(tempRepo, "my_module", "tests", `test_thing_${i}.py`), "def test_x(): pass\n", "utf-8");
    }

    const c = check("Tests", tempRepo);
    expect(c.status).toBe("pass");
    expect(c.points).toBe(8);
    expect(c.detail).toContain("my_module/tests/");
  });

  it("does not descend into node_modules or vendor looking for tests", () => {
    mkdirSync(join(tempRepo, "node_modules", "somepkg", "tests"), { recursive: true });
    writeFileSync(join(tempRepo, "node_modules", "somepkg", "tests", "test_a.js"), "", "utf-8");

    const c = check("Tests", tempRepo);
    expect(c.status).toBe("fail");
  });

  it("judges a Python project on mypy/pyright, not tsconfig", () => {
    writeFileSync(join(tempRepo, "pyproject.toml"), "[tool.poetry]\nname='x'\n", "utf-8");

    const c = check("Type checking", tempRepo);
    // Names the tools that actually apply to this stack, and never demands a tsconfig.
    expect(c.detail).toContain("mypy/pyright");
    expect(c.detail).not.toContain("tsconfig");
  });

  it("passes a Python project that configures mypy via pyproject", () => {
    writeFileSync(join(tempRepo, "pyproject.toml"), "[tool.mypy]\nstrict = true\n", "utf-8");

    const c = check("Type checking", tempRepo);
    expect(c.status).toBe("pass");
    expect(c.points).toBe(5);
  });

  it("judges Python linting on ruff/flake8, not eslint", () => {
    writeFileSync(join(tempRepo, "setup.py"), "from setuptools import setup\n", "utf-8");
    writeFileSync(join(tempRepo, ".flake8"), "[flake8]\nmax-line-length = 100\n", "utf-8");

    const c = check("Linting", tempRepo);
    expect(c.status).toBe("pass");
    expect(c.detail).toContain(".flake8");
  });

  it("returns unknown — not fail — when no tooling convention is known for the project type", () => {
    // No package.json, no python markers, no composer.json: the scorer has no basis for a verdict.
    writeFileSync(join(tempRepo, "main.rs"), "fn main() {}\n", "utf-8");

    const typeCheck = check("Type checking", tempRepo);
    expect(typeCheck.status).toBe("unknown");
    expect(typeCheck.detail).toContain("not assessed");

    const lint = check("Linting", tempRepo);
    expect(lint.status).toBe("unknown");
  });
});

// 🔒 [SCORE-LANGUAGE-AWARE] — reported from PLANK.io: a Flutter app with a Node backend.
describe("scoreProject — polyglot repos", () => {
  it("counts test files across EVERY test directory, not just the first", () => {
    mkdirSync(join(tempRepo, "backend", "__tests__"), { recursive: true });
    mkdirSync(join(tempRepo, "app", "test"), { recursive: true });
    for (let i = 0; i < 3; i++) writeFileSync(join(tempRepo, "backend", "__tests__", `a${i}.test.js`), "", "utf-8");
    for (let i = 0; i < 4; i++) writeFileSync(join(tempRepo, "app", "test", `w${i}_test.dart`), "", "utf-8");

    const c = check("Tests", tempRepo);
    expect(c.detail).toContain("7 test files");
    expect(c.detail).toContain("2 dir(s)");
  });

  it("counts .dart tests — a suite that runs on every build must not read as zero", () => {
    mkdirSync(join(tempRepo, "test"), { recursive: true });
    for (let i = 0; i < 6; i++) writeFileSync(join(tempRepo, "test", `widget${i}_test.dart`), "", "utf-8");

    const c = check("Tests", tempRepo);
    expect(c.status).toBe("pass");
    expect(c.points).toBe(8);
  });

  it("credits a Flutter app's analyzer config instead of demanding a tsconfig", () => {
    // The exact PLANK.io shape: Node backend at root, Flutter app one level down.
    writeFileSync(join(tempRepo, "package.json"), "{}", "utf-8");
    mkdirSync(join(tempRepo, "app"), { recursive: true });
    writeFileSync(join(tempRepo, "app", "pubspec.yaml"), "name: app\n", "utf-8");
    writeFileSync(join(tempRepo, "app", "analysis_options.yaml"), "include: package:flutter_lints/flutter.yaml\n", "utf-8");

    const c = check("Type checking", tempRepo);
    expect(c.status).toBe("pass");
    expect(c.points).toBe(5);
    expect(c.detail).toContain("analysis_options.yaml");
    expect(c.detail).not.toContain("tsconfig");
  });

  it("still asks a Node-only project for a tsconfig", () => {
    writeFileSync(join(tempRepo, "package.json"), "{}", "utf-8");

    const c = check("Type checking", tempRepo);
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("tsconfig.json");
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
    writeAgentDoc(join(tempRepo, "real-instructions.md"));
    symlinkSync(join(tempRepo, "real-instructions.md"), join(tempRepo, "copilot-instructions.md"));

    const c = check("copilot-instructions.md", tempRepo);
    expect(c.points).toBe(2);
    expect(c.status).toBe("partial");
    expect(c.detail).toContain("Symlink");
  });
});

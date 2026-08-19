import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runRuleParity, type RuleParityViolation } from "../src/hooks.js";
import { PolicySchema } from "../src/policy.js";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-parity-"));
  mkdirSync(join(repo, ".github"), { recursive: true });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const FILES = ["CLAUDE.md", ".github/copilot-instructions.md", "SKILLS.md"];

function policy(overrides: Record<string, unknown> = {}) {
  return PolicySchema.parse({
    version: 1,
    rule_parity: [
      { id: "r1", marker: "MULTI-AGENT COST", required_in: FILES, severity: "block", ...overrides },
    ],
  });
}
function staged(paths: string[]) {
  return paths.map((p) => ({ path: p, addedLines: [] })) as never[];
}
function put(rel: string, body: string) {
  writeFileSync(join(repo, rel), body, "utf-8");
}
function writeAll(marked: string[]) {
  for (const f of FILES) put(f, marked.includes(f) ? "# doc\nMULTI-AGENT COST rule here\n" : "# doc\nnothing\n");
}

// 🔒 [RULE-PARITY-IS-DOC-TO-DOC] — the incident: a rule lived in CLAUDE.md and the global
// config but never reached .github/copilot-instructions.md, so Cursor/Windsurf/Copilot —
// which read only that file — never saw it. No source file changed, so doc_coverage
// could never fire.
describe("runRuleParity", () => {
  it("catches the real incident: marker in one doc, missing from the others", () => {
    writeAll(["CLAUDE.md"]);
    const v = runRuleParity(policy(), staged(["CLAUDE.md"]), repo);
    expect(v).toHaveLength(1);
    expect(v[0].reason).toBe("marker-missing-from-some-files");
    expect(v[0].presentIn).toEqual(["CLAUDE.md"]);
    expect(v[0].missingFrom).toEqual([".github/copilot-instructions.md", "SKILLS.md"]);
    expect(v[0].severity).toBe("block");
  });

  it("passes when the marker is in every listed doc", () => {
    writeAll(FILES);
    expect(runRuleParity(policy(), staged(["CLAUDE.md"]), repo)).toEqual([]);
  });

  it("passes when the marker is in NONE of them (rule not adopted yet)", () => {
    writeAll([]);
    expect(runRuleParity(policy(), staged(["CLAUDE.md"]), repo)).toEqual([]);
  });

  it("fails an unadopted rule when always_required is set", () => {
    writeAll([]);
    const v = runRuleParity(policy({ always_required: true }), staged(["CLAUDE.md"]), repo);
    expect(v).toHaveLength(1);
    expect(v[0].reason).toBe("marker-required-but-absent-everywhere");
  });

  // 🔒 [RULE-PARITY-IS-DIFF-AWARE] — a gate that blocks unrelated commits gets disabled.
  it("does NOT fire on a commit that touches none of the governed docs", () => {
    writeAll(["CLAUDE.md"]); // drift exists...
    const v = runRuleParity(policy(), staged(["src/unrelated.ts"]), repo);
    expect(v).toEqual([]); // ...but this commit is not the moment to raise it
  });

  it("--all surfaces pre-existing drift regardless of the diff", () => {
    writeAll(["CLAUDE.md"]);
    const v = runRuleParity(policy(), staged(["src/unrelated.ts"]), repo, { all: true });
    expect(v).toHaveLength(1);
    expect(v[0].reason).toBe("marker-missing-from-some-files");
  });

  it("reports a listed file that does not exist, rather than silently passing", () => {
    put("CLAUDE.md", "MULTI-AGENT COST\n");
    put("SKILLS.md", "MULTI-AGENT COST\n");
    // .github/copilot-instructions.md deliberately absent
    const v = runRuleParity(policy(), staged(["CLAUDE.md"]), repo);
    expect(v).toHaveLength(1);
    expect(v[0].reason).toBe("file-not-found");
    expect(v[0].missingFiles).toEqual([".github/copilot-instructions.md"]);
  });

  it("honours warn severity without blocking", () => {
    writeAll(["CLAUDE.md"]);
    const v = runRuleParity(policy({ severity: "warn" }), staged(["CLAUDE.md"]), repo);
    expect(v[0].severity).toBe("warn");
  });

  it("matches the marker as a literal substring, not a regex", () => {
    // A marker containing regex metacharacters must not be interpreted.
    const p = PolicySchema.parse({
      version: 1,
      rule_parity: [{ id: "r2", marker: "COST (a|b)", required_in: FILES }],
    });
    put("CLAUDE.md", "COST (a|b)\n");
    put(".github/copilot-instructions.md", "COST a\n"); // would match as regex, must NOT count
    put("SKILLS.md", "COST (a|b)\n");
    const v = runRuleParity(p, staged(["CLAUDE.md"]), repo);
    expect(v).toHaveLength(1);
    expect(v[0].missingFrom).toEqual([".github/copilot-instructions.md"]);
  });

  // 🔒 [RULE-PARITY-READS-THE-INDEX] — the first cut read the working tree, so staging the
  // REMOVAL of a marker while the worktree still held it passed the gate, and the commit
  // that deleted the rule from the file agents read went through clean.
  it("reads the staged blob, so staging a removal is caught even if the worktree still has it", () => {
    const { execSync } = require("child_process") as typeof import("child_process");
    execSync("git init -q .", { cwd: repo });
    writeAll(FILES);
    execSync("git add -A", { cwd: repo });
    execSync('git -c user.email=a@b -c user.name=c commit -qm base', { cwd: repo });

    put("CLAUDE.md", "# doc\nnothing\n");        // remove marker
    execSync("git add CLAUDE.md", { cwd: repo });   // stage the removal
    put("CLAUDE.md", "# doc\nMULTI-AGENT COST\n"); // restore in worktree ONLY

    const v = runRuleParity(policy(), staged(["CLAUDE.md"]), repo);
    expect(v).toHaveLength(1);
    expect(v[0].missingFrom).toEqual(["CLAUDE.md"]);
  });

  it("--all deliberately audits the WORKING TREE, not the index", () => {
    const { execSync } = require("child_process") as typeof import("child_process");
    execSync("git init -q .", { cwd: repo });
    writeAll(FILES);
    execSync("git add -A", { cwd: repo });
    put("SKILLS.md", "# doc\nnothing\n"); // worktree-only regression
    // --all answers "is the repo consistent right now" → it must see the worktree.
    const v = runRuleParity(policy(), staged([]), repo, { all: true });
    expect(v).toHaveLength(1);
    expect(v[0].missingFrom).toEqual(["SKILLS.md"]);
  });

  it("rejects a rule listing fewer than two files — parity needs two sides", () => {
    expect(() =>
      PolicySchema.parse({ version: 1, rule_parity: [{ id: "r3", marker: "X-MARK", required_in: ["CLAUDE.md"] }] }),
    ).toThrow();
  });
});

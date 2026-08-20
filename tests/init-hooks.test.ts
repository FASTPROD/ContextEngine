import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

let repo: string;

function runInit(): string {
  try {
    return execFileSync("node", [join(process.cwd(), "dist/cli.js"), "init", "--yes"], {
      cwd: repo,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CONTEXTENGINE_WORKSPACES: repo },
      timeout: 120_000,
    });
  } catch (e: any) {
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

function writeHook(name: string, body: string): void {
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  writeFileSync(join(repo, ".git", "hooks", name), body, { mode: 0o755 });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-init-hooks-"));
  execFileSync("git", ["init", "-q", "."], { cwd: repo });
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("[SKIPPING-A-HOOK-MUST-NAME-WHAT-IS-UNENFORCED]", () => {
  it("names the unenforced gates when a foreign pre-commit is skipped", () => {
    // The invocme-odoo-connector shape: a hand-written hook that never calls CE.
    writeHook("pre-commit", "#!/bin/zsh\n# hand written scanner\nexit 0\n");
    const out = runInit();
    expect(out).toMatch(/pre-commit already exists/);
    expect(out).toMatch(/enforce NOTHING here/);
    expect(out).toMatch(/secret-scan, doc-coverage, rule-parity/);
    // And it must say how to fix it, not just that it is broken.
    expect(out).toMatch(/contextengine hook secret-scan/);
  });

  it("names commit-message-required when a foreign commit-msg is skipped", () => {
    writeHook("commit-msg", "#!/bin/zsh\nexit 0\n");
    const out = runInit();
    expect(out).toMatch(/commit-message-required/);
    expect(out).toMatch(/enforce NOTHING here/);
  });

  it("stays quiet when the existing hook already invokes CE", () => {
    writeHook("pre-commit", "#!/bin/zsh\ncontextengine hook secret-scan || exit 1\n");
    const out = runInit();
    expect(out).toMatch(/pre-commit already exists/);
    expect(out).not.toMatch(/enforce NOTHING here/);
  });

  it("never overwrites a foreign hook", () => {
    const body = "#!/bin/zsh\n# do not touch me\nexit 0\n";
    writeHook("pre-commit", body);
    runInit();
    expect(readFileSync(join(repo, ".git", "hooks", "pre-commit"), "utf-8")).toBe(body);
  });

  it("installs all three hooks in a repo that has none", () => {
    const out = runInit();
    expect(out).not.toMatch(/enforce NOTHING here/);
    for (const h of ["pre-commit", "commit-msg", "post-commit"]) {
      expect(existsSync(join(repo, ".git", "hooks", h)), `${h} missing`).toBe(true);
    }
  });
});

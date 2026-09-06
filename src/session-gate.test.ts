// [LOCK] [SESSION-SAVE-IS-A-GATE]: a turn may not end while the repo's CE session is older than
// HEAD; never outside git, never twice. Throwaway HOME via src/test-setup.ts.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

let G: typeof import("./session-gate.js");
const sessions = join(process.env.CONTEXTENGINE_HOME as string, "sessions");

function repo(name: string, commit = true): string {
  const root = mkdtempSync(join(tmpdir(), "gate-"));
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
  if (commit) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "1");
    g(["add", "."]); g(["commit", "-q", "-m", "one"]);
  }
  return dir;
}
function session(name: string, ageSeconds: number): string {
  mkdirSync(sessions, { recursive: true });
  const f = join(sessions, `${name}.json`);
  writeFileSync(f, "{}");
  const t = Date.now() / 1000 - ageSeconds;
  utimesSync(f, t, t);
  return f;
}

beforeAll(async () => { G = await import("./session-gate.js"); });

describe("evaluateSessionGate", () => {
  it("blocks when the repo has no session at all, naming the session to save", () => {
    const r = G.evaluateSessionGate({ repo: repo("Nosession"), sessionsDir: sessions });
    expect(r.block).toBe(true);
    expect(r.reason).toBe("stale");
    expect(r.message).toMatch(/session 'Nosession' \(never saved\)/);
    expect(r.message).toMatch(/save_session \(MCP\) session='Nosession'/);
  });
  it("passes when the session is newer than HEAD, blocks when older", () => {
    const d = repo("Fresh");
    session("Fresh", -60); // a minute in the future: certainly newer than the commit
    expect(G.evaluateSessionGate({ repo: d, sessionsDir: sessions }).reason).toBe("fresh");
    session("Fresh", 3600);
    const r = G.evaluateSessionGate({ repo: d, sessionsDir: sessions });
    expect(r.block).toBe(true);
    expect(r.message).toMatch(/older than the last commit/);
  });
  it("matches a session by normalized prefix: admin-CROWLR counts for admin.CROWLR, the newest wins", () => {
    const d = repo("admin.CROWLR");
    session("admin-CROWLR", -120);
    session("admin.CROWLR", 7200);
    const r = G.evaluateSessionGate({ repo: d, sessionsDir: sessions });
    expect(r.reason).toBe("fresh");
    expect(r.sessionName).toBe("admin-CROWLR");
  });
  it("never blocks outside git, before the first commit, or when the hook is already active", () => {
    const plain = mkdtempSync(join(tmpdir(), "notgit-"));
    expect(G.evaluateSessionGate({ repo: plain, sessionsDir: sessions }).reason).toBe("not_git");
    expect(G.evaluateSessionGate({ repo: repo("Empty", false), sessionsDir: sessions }).reason).toBe("no_commits");
    expect(G.evaluateSessionGate({ repo: repo("Loop"), sessionsDir: sessions, stopHookActive: true }).reason).toBe("loop_guard");
  });
  it("reports how far copilot-instructions.md is behind src, and names the newest session doc", () => {
    const d = repo("Docs");
    const g = (args: string[]) => execFileSync("git", args, { cwd: d, stdio: "ignore" });
    mkdirSync(join(d, ".github"), { recursive: true });
    writeFileSync(join(d, ".github", "copilot-instructions.md"), "# docs");
    g(["add", "."]); g(["commit", "-q", "-m", "docs"]);
    writeFileSync(join(d, "src", "b.ts"), "2"); g(["add", "."]); g(["commit", "-q", "-m", "src 1"]);
    writeFileSync(join(d, "src", "c.ts"), "3"); g(["add", "."]); g(["commit", "-q", "-m", "src 2"]);
    mkdirSync(join(d, "docs", "sessions"), { recursive: true });
    writeFileSync(join(d, "docs", "sessions", "SESSION_9.md"), "x");
    const r = G.evaluateSessionGate({ repo: d, sessionsDir: sessions });
    expect(r.docsBehind).toBe(2);
    expect(r.sessionDoc).toBe("docs/sessions/SESSION_9.md");
    expect(r.message).toMatch(/2 src commit\(s\) behind/);
    expect(r.message).toMatch(/SESSION_9\.md/);
  });
});

describe("normalizeName", () => {
  it("drops case and punctuation", () => {
    expect(G.normalizeName("admin.CROWLR")).toBe("admincrowlr");
    expect(G.normalizeName("GOOGLE Analytics")).toBe("googleanalytics");
  });
});

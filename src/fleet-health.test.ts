// [LOCK] [HEALTH-IS-MEASURED-NEVER-ESTIMATED]: every number from the audit log, the registry or
// a file; warnings only on measured problems. Throwaway HOME via src/test-setup.ts.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let H: typeof import("./fleet-health.js");
const home = () => process.env.CONTEXTENGINE_HOME as string;
const now = new Date("2026-09-06T10:00:00.000Z");
const rec = (ts: string, event: string, payload: Record<string, unknown> = {}) => JSON.stringify({ ts, event, actor: "t", payload, prev_hash: "x", hash: "y" });

function report(servers: Array<{ pid: number; role?: "indexer" | "reader"; staleBuild: boolean }>) {
  return {
    servers: servers.map((s) => ({ pid: s.pid, ppid: 1, parent: "t", started: "2026-09-06T09:00:00.000Z", heartbeat: "", version: "2.8.0", script: "x", build: s.staleBuild ? "old" : "new", cwd: "/r", node: "v", role: s.role, corpus: "c", alive: true as const, currentBuild: "new", staleBuild: s.staleBuild })),
    removed: 0,
    warnings: [] as string[],
  };
}

beforeAll(async () => { H = await import("./fleet-health.js"); mkdirSync(home(), { recursive: true }); });

describe("computeFleetHealth", () => {
  it("counts today's blocks, refusals and saves, last-hour index writes, and stale servers; warns only on measured problems", () => {
    const audit = join(home(), "audit.log");
    const midnightLocal = new Date(now); midnightLocal.setHours(0, 0, 0, 0);
    const yesterday = new Date(midnightLocal.getTime() - 3600_000).toISOString();
    writeFileSync(audit, [
      rec(yesterday, "hook.block", { check: "secret-scan", file: "old.md", line: 1 }),         // yesterday: not counted
      rec("2026-09-06T08:30:00.000Z", "index.write", { corpus: "c" }),                          // 90 min ago: not last hour
      rec("2026-09-06T09:30:00.000Z", "index.write", { corpus: "c" }),
      rec("2026-09-06T09:40:00.000Z", "index.write", { corpus: "d" }),
      rec("2026-09-06T09:45:00.000Z", "hook.block", { check: "secret-scan", file: "docs/x.md", line: 12, pattern_id: "jwt" }),
      rec("2026-09-06T09:46:00.000Z", "hook.block", { check: "doc-coverage", requires_section: "SKILLS.md#audit-log" }),
      rec("2026-09-06T09:47:00.000Z", "learning.store_growth_refused", { growth: 1535 }),
      rec("2026-09-06T09:48:00.000Z", "learning.save", { id: "a", mode: "create" }),
      rec("2026-09-06T09:49:00.000Z", "learning.save", { id: "b" }),
      rec("2026-09-06T09:49:30.000Z", "learning.save", { id: "c", mode: "update" }),                // an import sweep's update: not a save
      "{not json",
    ].join("\n") + "\n");
    writeFileSync(join(home(), "verified-2.7.1"), "x");
    writeFileSync(join(home(), "verified-2.6.0"), "x");
    const h = H.computeFleetHealth({ now, version: "2.8.0", auditPath: audit, settingsPath: join(home(), "no-such-settings.json"), report: report([{ pid: 1, role: "indexer", staleBuild: false }, { pid: 2, role: "reader", staleBuild: true }, { pid: 3, role: "reader", staleBuild: false }]) });
    expect(h.today).toMatchObject({ blocks: 2, refusals: 1, learningsSaved: 2 });
    expect(h.today.lastBlocks.map((b) => b.detail)).toEqual(["secret-scan: docs/x.md:12 (jwt)", "doc-coverage: SKILLS.md#audit-log", "growth refused"]);
    expect(h.reindex.lastHourWrites).toBe(2);
    expect(h.reindex.perCorpus).toEqual({ c: 1, d: 1 });
    expect(h.servers).toMatchObject({ total: 3, indexers: 1, readers: 2 });
    expect(h.servers.stale.map((s) => s.pid)).toEqual([2]);
    expect(h.lastVerifiedRelease).toBe("2.7.1");
    expect(h.warnings).toHaveLength(2); // the stale server and the refusal: both measured
    expect(h.warnings[0]).toMatch(/1 server\(s\) on an old build \(pid 2\)/);
    expect(h.warnings[1]).toMatch(/1 learnings-store refusal\(s\) today/);
  });
  it("is green with nothing measured, and raises the reindex warning above the ceiling", () => {
    const audit = join(home(), "audit2.log");
    const lines: string[] = [];
    for (let i = 0; i < H.REINDEX_PER_HOUR_WARN + 1; i++) lines.push(rec(`2026-09-06T09:${String(i % 60).padStart(2, "0")}:00.000Z`, "index.write", { corpus: "c" }));
    writeFileSync(audit, lines.join("\n") + "\n");
    const green = H.computeFleetHealth({ now, auditPath: join(home(), "missing.log"), report: report([{ pid: 1, role: "indexer", staleBuild: false }]) });
    expect(green.warnings).toEqual([]);
    expect(green.today).toMatchObject({ blocks: 0, refusals: 0, learningsSaved: 0 });
    const storm = H.computeFleetHealth({ now, auditPath: audit, report: report([{ pid: 1, role: "indexer", staleBuild: false }]) });
    expect(storm.warnings.some((w) => /writes in the last hour/.test(w))).toBe(true);
  });
  it("counts Claude Code hook registrations per event from settings.json and warns on a doubled or partial install", () => {
    const settings = join(home(), "settings-doubled.json");
    const HOME = process.env.HOME as string;
    const emit = `${HOME}/.claude/hooks/opscontext-emit.sh`;
    const hook = (command: string) => ({ type: "command", command, timeout: 5 });
    writeFileSync(settings, JSON.stringify({ hooks: {
      UserPromptSubmit: [{ hooks: [hook(`$HOME/.claude/hooks/opscontext-emit.sh UserPromptSubmit`)] }, { hooks: [hook(`${emit} UserPromptSubmit`)] }],
      PostToolUse: [{ matcher: ".*", hooks: [hook(`${emit} PostToolUse`)] }, { matcher: "Edit|Write|MultiEdit", hooks: [hook(`${HOME}/.claude/hooks/opscontext-simplicity-gate.py`)] }],
      SessionStart: [{ hooks: [hook(`${emit} SessionStart`)] }],
      Stop: [{ hooks: [hook(`${HOME}/.claude/hooks/opscontext-session-gate.sh`)] }],
    } }));
    const missing = join(home(), "missing.log");
    const rep = report([{ pid: 1, role: "indexer", staleBuild: false }]);
    const h = H.computeFleetHealth({ now, auditPath: missing, report: rep, settingsPath: settings });
    expect(h.claudeHooks).toEqual({ UserPromptSubmit: 2, PostToolUse: 1, SessionStart: 1, Stop: 1, "PostToolUse(simplicity)": 1 });
    expect(h.warnings).toEqual([expect.stringMatching(/runs an OpsContext hook more than once \(UserPromptSubmit=2\).*run install-claude-hook/)]);
    expect(H.formatFleetHealth(h)).toMatch(/registrations UserPromptSubmit=2 PostToolUse=1/);

    const partial = join(home(), "settings-partial.json");
    writeFileSync(partial, JSON.stringify({ hooks: { Stop: [{ hooks: [hook(`${HOME}/.claude/hooks/opscontext-session-gate.sh`)] }] } }));
    const p = H.computeFleetHealth({ now, auditPath: missing, report: rep, settingsPath: partial });
    expect(p.warnings).toEqual([expect.stringMatching(/installed for Stop but not UserPromptSubmit, PostToolUse, SessionStart/)]);

    const none = H.computeFleetHealth({ now, auditPath: missing, report: rep, settingsPath: join(home(), "no-such-settings.json") });
    expect(none.claudeHooks).toBeNull();
    expect(none.warnings).toEqual([]);
    const empty = join(home(), "settings-empty.json");
    writeFileSync(empty, JSON.stringify({ model: "x" }));
    expect(H.computeFleetHealth({ now, auditPath: missing, report: rep, settingsPath: empty }).warnings).toEqual([]); // not installed is not a problem
  });
  it("counts today's Claude Code hook events and the ones that arrived twice, and warns above the share", () => {
    const audit = join(home(), "audit-doubled.log");
    const call = (i: number) => ({ surface: "claude-code", tool: "Bash", args_preview: `cmd ${i}`, session: "s" });
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) {
      const ts = `2026-09-06T09:${String(10 + i).padStart(2, "0")}:00.000Z`;
      lines.push(rec(ts, "vscode.tool_call", call(i)));
      if (i < 3) lines.push(rec(ts.replace(":00.000Z", ":00.400Z"), "vscode.tool_call", call(i))); // the same record again 400 ms later
    }
    lines.push(rec("2026-09-06T09:30:00.000Z", "vscode.tool_call", call(99)));
    lines.push(rec("2026-09-06T09:30:05.000Z", "vscode.tool_call", call(99))); // same call 5 s later: Claude repeated itself, not a doubled hook
    lines.push(rec("2026-09-06T09:31:00.000Z", "vscode.prompt_submit", { text: "a" }));
    lines.push(rec("2026-09-06T09:31:00.100Z", "vscode.tool_call", { text: "a" })); // different event: not doubled
    writeFileSync(audit, lines.join("\n") + "\n");
    const rep = report([{ pid: 1, role: "indexer", staleBuild: false }]);
    const h = H.computeFleetHealth({ now, auditPath: audit, report: rep, settingsPath: join(home(), "no-such-settings.json") });
    expect(h.today.hookEvents).toBe(19);
    expect(h.today.doubledHookEvents).toBe(3);
    expect(h.warnings).toEqual([expect.stringMatching(/3 of 19 Claude Code hook events today arrived twice within 2 s/)]);
    expect(H.formatFleetHealth(h)).toMatch(/claude code: 19 hook event\(s\) today, 3 doubled/);

    const few = join(home(), "audit-few.log");
    writeFileSync(few, [rec("2026-09-06T09:10:00.000Z", "vscode.tool_call", call(1)), rec("2026-09-06T09:10:00.400Z", "vscode.tool_call", call(1))].join("\n") + "\n");
    const f = H.computeFleetHealth({ now, auditPath: few, report: rep, settingsPath: join(home(), "no-such-settings.json") });
    expect(f.today).toMatchObject({ hookEvents: 2, doubledHookEvents: 1 });
    expect(f.warnings).toEqual([]); // below DOUBLED_MIN_EVENTS: one repeat is not evidence
  });
  it("writes the file atomically and formats it for the CLI", () => {
    const h = H.computeFleetHealth({ now, version: "2.8.0", auditPath: join(home(), "missing.log"), report: report([{ pid: 1, role: "indexer", staleBuild: false }]) });
    const p = H.writeFleetHealth(h);
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8")).version).toBe("2.8.0");
    const text = H.formatFleetHealth(h);
    expect(text).toMatch(/^health: green/);
    expect(text).toMatch(/servers 1: 1 indexing, 0 reading, 0 on an old build/);
  });
});

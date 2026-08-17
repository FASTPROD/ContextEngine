import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";

let home: string;
let logPath: string;
const GENESIS = "0".repeat(64);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ce-audit-fork-"));
  process.env.CONTEXTENGINE_HOME = home;
  logPath = join(home, "audit.log");
});

afterEach(() => {
  delete process.env.CONTEXTENGINE_HOME;
  rmSync(home, { recursive: true, force: true });
});

/** Build a record exactly as audit.ts does, so fixtures are chain-valid. */
function rec(prev: string, event: string, payload: Record<string, unknown>, actor = "system") {
  const ts = new Date(Date.now()).toISOString();
  const canonical = JSON.stringify({ prev_hash: prev, ts, event, actor, payload });
  const hash = createHash("sha256").update(canonical).digest("hex");
  return { ts, event, actor, payload, prev_hash: prev, hash };
}

function write(records: ReturnType<typeof rec>[]) {
  writeFileSync(logPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
}

async function verify() {
  const mod = await import("../src/audit.js");
  return mod.verifyChain();
}

// 🔒 [VERIFY-FORK-IS-NOT-TAMPER] — the verifier used to return on the FIRST prev_hash
// mismatch and tell the user the log "was either edited after the fact, or partially
// written during a crash". On the author's real log that declared 316,000 records
// unverifiable — for a condition it had never tested. Measured truth: 0 altered records,
// 0 orphans, 66 concurrent-append forks.
describe("verifyChain — tampering vs concurrency are different findings", () => {
  it("passes a clean linear chain with no forks", async () => {
    const a = rec(GENESIS, "learning.save", { i: 1 });
    const b = rec(a.hash, "learning.save", { i: 2 });
    write([a, b]);

    const r = await verify();
    expect(r.ok).toBe(true);
    expect(r.tamperedIndices).toEqual([]);
    expect(r.orphanIndices).toEqual([]);
    expect(r.forkIndices).toEqual([]);
  });

  it("reports a FORK — two writers on the same head — as ok, not tampering", async () => {
    const a = rec(GENESIS, "learning.save", { i: 1 });
    const b = rec(a.hash, "learning.save", { i: 2 });
    const forked = rec(a.hash, "vscode.tool_call", { i: 3 }); // same parent as b
    write([a, b, forked]);

    const r = await verify();
    expect(r.forkIndices).toEqual([2]);
    expect(r.tamperedIndices).toEqual([]);
    expect(r.orphanIndices).toEqual([]);
    // The whole point: a fork must NOT fail the chain.
    expect(r.ok).toBe(true);
    expect(r.breakReason).toBeNull();
  });

  it("a fork does not cascade into false tamper reports for later records", async () => {
    const a = rec(GENESIS, "learning.save", { i: 1 });
    const b = rec(a.hash, "learning.save", { i: 2 });
    const forked = rec(a.hash, "vscode.tool_call", { i: 3 });
    const after = rec(forked.hash, "learning.save", { i: 4 });
    write([a, b, forked, after]);

    const r = await verify();
    expect(r.tamperedIndices).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("detects TAMPERING — altered content fails the chain", async () => {
    const a = rec(GENESIS, "learning.save", { i: 1 });
    const b = rec(a.hash, "learning.save", { i: 2 });
    write([a, b]);
    // Rewrite record b's payload, leaving its hash untouched.
    const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    const edited = JSON.parse(lines[1]);
    edited.payload = { i: 999 };
    writeFileSync(logPath, [lines[0], JSON.stringify(edited)].join("\n") + "\n", "utf-8");

    const r = await verify();
    expect(r.ok).toBe(false);
    expect(r.tamperedIndices).toContain(1);
    expect(r.breakReason).toMatch(/altered content/);
  });

  it("detects an ORPHAN — a parent hash that never existed — as failure", async () => {
    const a = rec(GENESIS, "learning.save", { i: 1 });
    const orphan = rec("f".repeat(64), "learning.save", { i: 2 }); // parent never in log
    write([a, orphan]);

    const r = await verify();
    expect(r.ok).toBe(false);
    expect(r.orphanIndices).toContain(1);
    expect(r.forkIndices).toEqual([]); // must NOT be misfiled as a benign fork
    expect(r.breakReason).toMatch(/parent is absent|deleted or truncated/);
  });

  it("distinguishes an orphan from a fork even when both are present", async () => {
    const a = rec(GENESIS, "learning.save", { i: 1 });
    const b = rec(a.hash, "learning.save", { i: 2 });
    const forked = rec(a.hash, "vscode.tool_call", { i: 3 });
    const orphan = rec("e".repeat(64), "learning.save", { i: 4 });
    write([a, b, forked, orphan]);

    const r = await verify();
    expect(r.forkIndices).toEqual([2]);
    expect(r.orphanIndices).toEqual([3]);
    expect(r.ok).toBe(false); // the orphan fails it; the fork alone would not
  });
});

// 🔒 [AUDIT-TAIL-READ-IS-O1] + [AUDIT-HEAD-FROM-DISK]
describe("appendAudit — head comes from disk, not from a cache", () => {
  it("chains onto a record written by a DIFFERENT process mid-run", async () => {
    const mod = await import("../src/audit.js");
    mod.resetCacheForTest();

    const first = mod.appendAudit("learning.save", { i: 1 });

    // Simulate another process appending behind our back.
    const external = rec(first.hash, "vscode.tool_call", { external: true }, "other-proc");
    appendFileSync(logPath, JSON.stringify(external) + "\n");

    // Our next append must chain onto the EXTERNAL record, not onto our own last write.
    const third = mod.appendAudit("learning.save", { i: 3 });
    expect(third.prev_hash).toBe(external.hash);

    const r = mod.verifyChain();
    expect(r.ok).toBe(true);
    expect(r.forkIndices).toEqual([]);
  });

  it("reads the head correctly when the log exceeds the tail window", async () => {
    const mod = await import("../src/audit.js");
    mod.resetCacheForTest();
    // A payload large enough that many records blow past the 64KB tail read.
    const big = "x".repeat(4096);
    let last = "";
    for (let i = 0; i < 40; i++) last = mod.appendAudit("learning.save", { big, i }).hash;

    const next = mod.appendAudit("learning.save", { i: "after" });
    expect(next.prev_hash).toBe(last);
    expect(mod.verifyChain().ok).toBe(true);
  });
});

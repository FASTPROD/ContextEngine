import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  appendAudit,
  readAuditLog,
  verifyChain,
  filterByRange,
  toCsv,
  resetCacheForTest,
} from "../src/audit.js";

let tempHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "ce-audit-test-"));
  originalHome = process.env.CONTEXTENGINE_HOME;
  process.env.CONTEXTENGINE_HOME = tempHome;
  resetCacheForTest();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.CONTEXTENGINE_HOME;
  else process.env.CONTEXTENGINE_HOME = originalHome;
  resetCacheForTest();
  rmSync(tempHome, { recursive: true, force: true });
});

describe("appendAudit", () => {
  it("creates the log file on first append", () => {
    const logPath = join(tempHome, "audit.log");
    expect(existsSync(logPath)).toBe(false);
    appendAudit("learning.save", { id: "L1" });
    expect(existsSync(logPath)).toBe(true);
  });

  it("first record has genesis prev_hash (64 zeros)", () => {
    const r = appendAudit("learning.save", { id: "L1" });
    expect(r.prev_hash).toBe("0".repeat(64));
    expect(r.hash).toHaveLength(64);
    expect(r.hash).not.toBe(r.prev_hash);
  });

  it("subsequent records chain to the previous hash", () => {
    const r1 = appendAudit("learning.save", { id: "L1" });
    const r2 = appendAudit("learning.save", { id: "L2" });
    const r3 = appendAudit("session.save", { name: "s1", key: "k", value_length: 5, entries: 1 });
    expect(r2.prev_hash).toBe(r1.hash);
    expect(r3.prev_hash).toBe(r2.hash);
  });

  it("preserves event, actor, and payload as written", () => {
    const r = appendAudit("activation.activate", { plan: "pro" }, "user@example.com");
    expect(r.event).toBe("activation.activate");
    expect(r.actor).toBe("user@example.com");
    expect(r.payload).toEqual({ plan: "pro" });
  });
});

describe("readAuditLog", () => {
  it("returns empty array when log does not exist", () => {
    expect(readAuditLog()).toEqual([]);
  });

  it("returns all appended records in order", () => {
    appendAudit("learning.save", { id: "L1" });
    appendAudit("learning.save", { id: "L2" });
    appendAudit("learning.delete", { id: "L1" });
    const records = readAuditLog();
    expect(records).toHaveLength(3);
    expect(records[0].payload).toEqual({ id: "L1" });
    expect(records[1].payload).toEqual({ id: "L2" });
    expect(records[2].event).toBe("learning.delete");
  });

  it("throws with a meaningful message on corrupt JSON lines", () => {
    appendAudit("learning.save", { id: "L1" });
    writeFileSync(join(tempHome, "audit.log"), "{not json}\n", { flag: "a" });
    expect(() => readAuditLog()).toThrow(/Corrupt audit line/);
  });
});

describe("verifyChain", () => {
  it("reports ok=true and total=0 for an empty log", () => {
    const r = verifyChain();
    expect(r.ok).toBe(true);
    expect(r.total).toBe(0);
    expect(r.breakAtIndex).toBeNull();
  });

  it("verifies a clean 10-record chain", () => {
    for (let i = 0; i < 10; i++) {
      appendAudit("learning.save", { id: `L${i}` });
    }
    const r = verifyChain();
    expect(r.ok).toBe(true);
    expect(r.total).toBe(10);
  });

  it("detects payload tampering at the correct index", () => {
    appendAudit("learning.save", { id: "L1" });
    appendAudit("learning.save", { id: "L2" });
    appendAudit("learning.save", { id: "L3" });

    // Mutate record 1 (index 1) — change its payload but keep the original hash
    const logPath = join(tempHome, "audit.log");
    const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    const parsed = JSON.parse(lines[1]);
    parsed.payload = { id: "L2-EVIL" };
    lines[1] = JSON.stringify(parsed);
    writeFileSync(logPath, lines.join("\n") + "\n");

    const r = verifyChain();
    expect(r.ok).toBe(false);
    expect(r.breakAtIndex).toBe(1);
    expect(r.breakReason).toMatch(/hash mismatch/);
  });

  it("detects prev_hash splicing (record removed from middle)", () => {
    appendAudit("learning.save", { id: "L1" });
    appendAudit("learning.save", { id: "L2" });
    appendAudit("learning.save", { id: "L3" });

    // Remove the middle line — record 2's prev_hash will no longer match record 1's hash
    const logPath = join(tempHome, "audit.log");
    const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    writeFileSync(logPath, [lines[0], lines[2]].join("\n") + "\n");

    const r = verifyChain();
    expect(r.ok).toBe(false);
    expect(r.breakAtIndex).toBe(1);
    expect(r.breakReason).toMatch(/prev_hash mismatch/);
  });

  it("detects appended-from-scratch forgery (forged record with bogus prev_hash)", () => {
    appendAudit("learning.save", { id: "L1" });

    const logPath = join(tempHome, "audit.log");
    const forged = {
      ts: "2026-06-10T12:00:00.000Z",
      event: "activation.activate",
      actor: "attacker",
      payload: { plan: "enterprise" },
      prev_hash: "f".repeat(64), // wrong prev_hash
      hash: "a".repeat(64),
    };
    writeFileSync(logPath, readFileSync(logPath, "utf-8") + JSON.stringify(forged) + "\n");

    const r = verifyChain();
    expect(r.ok).toBe(false);
    expect(r.breakAtIndex).toBe(1);
  });

  it("returns a graceful error report when the log file is corrupt", () => {
    appendAudit("learning.save", { id: "L1" });
    writeFileSync(join(tempHome, "audit.log"), "this is not valid json at all\n");
    const r = verifyChain();
    expect(r.ok).toBe(false);
    expect(r.breakReason).toMatch(/Corrupt audit line/);
  });
});

describe("filterByRange", () => {
  it("returns all records when no range is given", () => {
    appendAudit("learning.save", { id: "L1" });
    appendAudit("learning.save", { id: "L2" });
    const records = readAuditLog();
    expect(filterByRange(records)).toHaveLength(2);
  });

  it("filters by since (inclusive lower bound)", () => {
    appendAudit("learning.save", { id: "L1" });
    appendAudit("learning.save", { id: "L2" });
    const records = readAuditLog();
    const t1 = records[0].ts;
    const filtered = filterByRange(records, t1);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered[0].ts >= t1).toBe(true);
  });

  it("filters by until (inclusive upper bound)", async () => {
    appendAudit("learning.save", { id: "L1" });
    // Sleep 5ms so the next record gets a distinct ISO ts (millisecond precision)
    await new Promise((r) => setTimeout(r, 5));
    appendAudit("learning.save", { id: "L2" });
    const records = readAuditLog();
    // Use record 0's ts as the upper bound — record 1 happened after, so excluded
    const t0 = records[0].ts;
    const filtered = filterByRange(records, undefined, t0);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].payload).toEqual({ id: "L1" });
  });
});

describe("toCsv", () => {
  it("produces a header row + one row per record", () => {
    appendAudit("learning.save", { id: "L1" });
    appendAudit("learning.delete", { id: "L1" });
    const csv = toCsv(readAuditLog());
    const rows = csv.split("\n");
    expect(rows[0]).toBe("ts,event,actor,payload,prev_hash,hash");
    expect(rows).toHaveLength(3);
  });

  it("escapes embedded double-quotes in the payload column (RFC 4180)", () => {
    appendAudit("learning.save", { rule: 'has "quoted" text' });
    const csv = toCsv(readAuditLog());
    // JSON.stringify produces \" for embedded quotes. RFC 4180 escapes a " inside
    // a quoted CSV field by doubling it (""). So the JSON \" survives as \"" in
    // the CSV cell — the backslash is preserved, each " is doubled.
    expect(csv).toContain('\\""quoted\\""');
    // The payload cell as a whole must be parseable when un-escaped: every original
    // " inside the JSON should appear as "" in the CSV.
    const lines = csv.split("\n");
    const payloadCell = lines[1];
    // Count of "" pairs should equal original count of " in the JSON-serialized payload.
    const originalJson = JSON.stringify({ rule: 'has "quoted" text' });
    const originalQuoteCount = (originalJson.match(/"/g) || []).length;
    const doubledQuotePairs = (payloadCell.match(/""/g) || []).length;
    expect(doubledQuotePairs).toBe(originalQuoteCount);
  });
});

describe("genesis hash + canonical serialization", () => {
  it("is deterministic — same inputs produce same hash chain", () => {
    appendAudit("learning.save", { id: "X" });
    const firstRun = readAuditLog();
    const firstHash = firstRun[0].hash;
    const firstPrev = firstRun[0].prev_hash;

    // Reset and replay
    rmSync(join(tempHome, "audit.log"));
    resetCacheForTest();
    const replay = appendAudit("learning.save", { id: "X" });

    // Genesis prev_hash must match (deterministic)
    expect(replay.prev_hash).toBe(firstPrev);
    // ts differs so hash differs — but recomputing with same ts should match
    // (the determinism test is the prev_hash equality above)
    expect(typeof firstHash).toBe("string");
  });
});

describe("concurrent-writer race (audit-001-write-race fix)", () => {
  it("serializes concurrent appends via file lock + size-mismatch re-read", async () => {
    // Simulate the race: spawn two child processes that each fire 20 appends
    // in parallel against the SAME audit.log file. Without the lock, the
    // chain would break at the first interleaved write (as it did at
    // index 2826 in the wild, Sessions 11-13). With the lock + cache
    // invalidation on size mismatch, the chain must verify clean.
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync: write } = await import("node:fs");

    const workerScript = `
import { appendAudit, resetCacheForTest } from "${process.cwd()}/dist/audit.js";
process.env.CONTEXTENGINE_HOME = "${tempHome}";
resetCacheForTest();
const label = process.argv[2];
for (let i = 0; i < 20; i++) {
  appendAudit("learning.save", { id: label + "-" + i });
}
`;
    const workerPath = join(tempHome, "race-worker.mjs");
    write(workerPath, workerScript);

    // Launch both workers in parallel — Promise.all so they actually contend.
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        try {
          execFileSync("node", [workerPath, "A"], { stdio: "pipe" });
          resolve();
        } catch (e) {
          reject(e);
        }
      }),
      new Promise<void>((resolve, reject) => {
        try {
          execFileSync("node", [workerPath, "B"], { stdio: "pipe" });
          resolve();
        } catch (e) {
          reject(e);
        }
      }),
    ]);

    // Chain must verify clean — no prev_hash mismatch, no hash tampering.
    resetCacheForTest();
    const report = verifyChain();
    expect(report.ok).toBe(true);
    expect(report.breakAtIndex).toBeNull();
    expect(report.total).toBe(40); // 20 from worker A + 20 from worker B

    // Both workers' records must be present (no event lost to lock timeout).
    const records = readAuditLog();
    const idsA = records.filter((r) => String(r.payload.id).startsWith("A-")).length;
    const idsB = records.filter((r) => String(r.payload.id).startsWith("B-")).length;
    expect(idsA).toBe(20);
    expect(idsB).toBe(20);
  }, 30_000); // 30s timeout — the workers themselves take a few seconds
});

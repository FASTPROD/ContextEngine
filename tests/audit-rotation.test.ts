import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  appendAudit,
  readAuditLog,
  verifyChain,
  rotateAuditLog,
  planRotation,
  listSegments,
  resetCacheForTest,
  type AuditRecord,
} from "../src/audit.js";

let tempHome: string;
let originalHome: string | undefined;

const DAY = 86_400_000;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "ce-rotate-test-"));
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

const logPath = () => join(tempHome, "audit.log");
const segPath = (f: string) => join(tempHome, "audit-archive", f);

/** Write a chain by hand with controlled timestamps — appendAudit always stamps "now". */
function seedChain(count: number, oldestDaysAgo: number, newestDaysAgo = 0): AuditRecord[] {
  const { createHash } = require("crypto") as typeof import("crypto");
  const recs: AuditRecord[] = [];
  let prev = "0".repeat(64);
  for (let i = 0; i < count; i++) {
    const frac = count === 1 ? 0 : i / (count - 1);
    const daysAgo = oldestDaysAgo - frac * (oldestDaysAgo - newestDaysAgo);
    const ts = new Date(Date.now() - daysAgo * DAY).toISOString();
    const event = "learning.save";
    const actor = "system";
    const payload = { id: `L${i}` };
    const canonical = JSON.stringify({ prev_hash: prev, ts, event, actor, payload });
    const hash = createHash("sha256").update(canonical).digest("hex");
    recs.push({ ts, event, actor, payload, prev_hash: prev, hash } as AuditRecord);
    prev = hash;
  }
  writeFileSync(logPath(), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return recs;
}

describe("planRotation", () => {
  it("plans nothing when every record is inside the retention window", () => {
    seedChain(10, 2, 0);
    const plan = planRotation({ keepDays: 30 });
    expect(plan.archiveCount).toBe(0);
    expect(plan.segmentFile).toBeNull();
  });

  it("keeps the most recent records even when all of them are older than the cutoff", () => {
    seedChain(2500, 400, 300);
    const plan = planRotation({ keepDays: 30 });
    // MIN_LIVE_RECORDS floor is 2000 — never archive below it, whatever the dates say.
    expect(plan.keepCount).toBe(2000);
    expect(plan.archiveCount).toBe(500);
  });
});

describe("rotateAuditLog", () => {
  it("writes nothing on a dry run", () => {
    seedChain(2500, 400, 300);
    const before = readFileSync(logPath(), "utf-8");
    const r = rotateAuditLog({ keepDays: 30, dryRun: true });
    expect(r.rotated).toBe(false);
    expect(r.archiveCount).toBe(500);
    expect(readFileSync(logPath(), "utf-8")).toBe(before);
    expect(listSegments()).toEqual([]);
  });

  it("moves the old prefix into a segment and shrinks the live log", () => {
    seedChain(2500, 400, 300);
    const sizeBefore = statSync(logPath()).size;
    const r = rotateAuditLog({ keepDays: 30 });
    expect(r.rotated).toBe(true);
    expect(listSegments()).toEqual(["audit-0001.jsonl"]);
    expect(statSync(logPath()).size).toBeLessThan(sizeBefore);
    const seg = readFileSync(segPath("audit-0001.jsonl"), "utf-8").trim().split("\n");
    expect(seg).toHaveLength(500);
  });

  // The whole point of the feature.
  it("leaves the chain verifying with ZERO orphans after rotation", () => {
    seedChain(2500, 400, 300);
    expect(verifyChain().ok).toBe(true);
    rotateAuditLog({ keepDays: 30 });
    const after = verifyChain();
    expect(after.ok).toBe(true);
    expect(after.orphanIndices).toEqual([]);
    expect(after.tamperedIndices).toEqual([]);
  });

  it("preserves the full history, in order, across the seam", () => {
    const seeded = seedChain(2500, 400, 300);
    rotateAuditLog({ keepDays: 30 });
    const history = readAuditLog();
    // +1 for the audit.rotate record the rotation appends about itself.
    expect(history).toHaveLength(seeded.length + 1);
    expect(history.slice(0, seeded.length).map((r) => r.hash)).toEqual(seeded.map((r) => r.hash));
    expect(history[history.length - 1].event).toBe("audit.rotate");
  });

  it("records the rotation as an audited event naming the segment", () => {
    seedChain(2500, 400, 300);
    rotateAuditLog({ keepDays: 30 });
    const last = readAuditLog().pop()!;
    expect(last.event).toBe("audit.rotate");
    expect(last.payload.segment).toBe("audit-0001.jsonl");
    expect(last.payload.archived_records).toBe(500);
  });

  it("keeps appending on a linear chain after rotation", () => {
    seedChain(2500, 400, 300);
    rotateAuditLog({ keepDays: 30 });
    appendAudit("learning.save", { id: "after-1" });
    appendAudit("learning.save", { id: "after-2" });
    const v = verifyChain();
    expect(v.ok).toBe(true);
    expect(v.forkIndices).toEqual([]);
  });

  it("excludes archived segments when the caller asks for the live log only", () => {
    seedChain(2500, 400, 300);
    rotateAuditLog({ keepDays: 30 });
    const live = readAuditLog({ includeArchives: false });
    expect(live).toHaveLength(2001); // 2000 kept + the audit.rotate record
    expect(readAuditLog().length).toBe(2501);
  });

  it("refuses to archive a chain that does not verify", () => {
    const recs = seedChain(2500, 400, 300);
    recs[10].payload = { id: "TAMPERED" };
    writeFileSync(logPath(), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = rotateAuditLog({ keepDays: 30 });
    expect(r.rotated).toBe(false);
    expect(r.refusedReason).toMatch(/does not verify/);
    expect(listSegments()).toEqual([]);
  });

  it("numbers a second segment after the first", () => {
    seedChain(2500, 400, 300);
    rotateAuditLog({ keepDays: 30 });
    seedChain(2500, 400, 300); // fresh live log, archive already holds segment 1
    rotateAuditLog({ keepDays: 30 });
    expect(listSegments()).toEqual(["audit-0001.jsonl", "audit-0002.jsonl"]);
  });
});

describe("crash between archiving and truncating", () => {
  // [ROTATE-ARCHIVE-BEFORE-TRUNCATE]: the segment lands first, so the only reachable
  // failure state is a duplicated prefix. It must read as history exactly once.
  it("de-dups a prefix present in both the segment and the live log", () => {
    const seeded = seedChain(2500, 400, 300);
    mkdirSync(join(tempHome, "audit-archive"), { recursive: true });
    writeFileSync(
      segPath("audit-0001.jsonl"),
      seeded.slice(0, 500).map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    // Live log deliberately left untruncated — exactly the crash window.
    const history = readAuditLog();
    expect(history).toHaveLength(seeded.length);
    expect(history.map((r) => r.hash)).toEqual(seeded.map((r) => r.hash));
    expect(verifyChain().ok).toBe(true);
  });

  it("never drops live records that merely appear later in a segment", () => {
    const seeded = seedChain(100, 400, 300);
    mkdirSync(join(tempHome, "audit-archive"), { recursive: true });
    // A segment whose hashes include records that are NOT a leading run of the live log.
    writeFileSync(
      segPath("audit-0001.jsonl"),
      seeded.slice(50, 60).map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    const history = readAuditLog();
    // 10 archived + all 100 live: nothing silently vanishes, because only a LEADING
    // duplicate run is dropped.
    expect(history).toHaveLength(110);
  });
});

describe("[UNREADABLE-HEAD-IS-NOT-GENESIS]", () => {
  it("throws rather than chaining onto genesis when the tail is corrupt", () => {
    appendAudit("learning.save", { id: "L1" });
    writeFileSync(logPath(), readFileSync(logPath(), "utf-8") + '{"ts":"broken\n');
    expect(() => appendAudit("learning.save", { id: "L2" })).toThrow(/unknown head/i);
  });

  it("does not create an orphan record when the tail is corrupt", () => {
    appendAudit("learning.save", { id: "L1" });
    const good = readFileSync(logPath(), "utf-8");
    writeFileSync(logPath(), good + '{"ts":"broken\n');
    try {
      appendAudit("learning.save", { id: "L2" });
    } catch {
      /* expected */
    }
    const lines = readFileSync(logPath(), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2); // the corrupt line, and nothing appended after it
  });
});

describe("[DATE-RETENTION-DOES-NOT-BOUND-SIZE]", () => {
  it("archives on the size ceiling even when every record is inside the date window", () => {
    // The real-log shape: everything recent, but far too much of it.
    seedChain(6000, 1, 0);
    const plan = planRotation({ keepDays: 30, maxRecords: 3000 });
    expect(plan.archiveCount).toBe(3000);
    expect(plan.keepCount).toBe(3000);
  });

  it("takes whichever rule archives more, under the live-record floor", () => {
    // 10,000 records spread over 90 days: the 30-day window alone archives about 2/3.
    seedChain(10_000, 90, 0);
    const dateOnly = planRotation({ keepDays: 30, maxRecords: 999_999 }).archiveCount;
    expect(dateOnly).toBeGreaterThan(6000);
    expect(dateOnly).toBeLessThan(7000);

    // A tighter ceiling archives more than the date rule, up to the 2000-record floor.
    expect(planRotation({ keepDays: 30, maxRecords: 1000 }).archiveCount).toBe(8000);
    // A looser ceiling never archives LESS than the date rule already would.
    expect(planRotation({ keepDays: 30, maxRecords: 9000 }).archiveCount).toBe(dateOnly);
  });

  it("bounds the live log after a real rotation", () => {
    seedChain(6000, 1, 0);
    rotateAuditLog({ keepDays: 30, maxRecords: 3000 });
    // 3000 kept + the audit.rotate record.
    expect(readAuditLog({ includeArchives: false })).toHaveLength(3001);
    expect(verifyChain().ok).toBe(true);
    expect(verifyChain().orphanIndices).toEqual([]);
  });

  it("still honours the MIN_LIVE_RECORDS floor against an aggressive ceiling", () => {
    seedChain(2500, 1, 0);
    const plan = planRotation({ keepDays: 30, maxRecords: 1 });
    expect(plan.keepCount).toBe(2000);
  });
});

describe("[NO-SPREAD-OVER-A-SEGMENT]", () => {
  // Found by running the real rotation, not by any unit test: every test above uses a
  // few thousand records, and push(...records) only blows the stack past ~100k.
  it("reads a segment far larger than the JS argument limit", () => {
    const N = 200_000;
    mkdirSync(join(tempHome, "audit-archive"), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < N; i++) {
      lines.push(
        JSON.stringify({
          ts: new Date(Date.now() - (N - i) * 1000).toISOString(),
          event: "learning.save",
          actor: "system",
          payload: { id: `L${i}` },
          prev_hash: "0".repeat(64),
          hash: String(i).padStart(64, "0"),
        }),
      );
    }
    writeFileSync(segPath("audit-0001.jsonl"), lines.join("\n") + "\n");
    expect(() => readAuditLog()).not.toThrow();
    expect(readAuditLog()).toHaveLength(N);
  });
});

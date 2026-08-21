import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { appendAudit, verifyChain, acknowledgeRedaction, rotateAuditLog, resetCacheForTest } from "../src/audit.js";

let tempHome: string;
let originalHome: string | undefined;
beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "ce-redact-"));
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
function seed(n: number) { for (let i = 0; i < n; i++) appendAudit("learning.save", { i, note: `entry-${i}` }, "test"); }
function redactLine(path: string, idx: number) {
  const lines = readFileSync(path, "utf-8").split("\n");
  const r = JSON.parse(lines[idx]); r.payload.note = "[REDACTED]"; lines[idx] = JSON.stringify(r);
  writeFileSync(path, lines.join("\n"));
}

// [LOCK] [REDACTION-IS-A-CHAINED-RECORD]
describe("acknowledged redactions", () => {
  it("an altered record is tampering until acknowledged, then redacted, and ok flips", () => {
    seed(20);
    redactLine(logPath(), 5);
    let v = verifyChain();
    expect(v.ok).toBe(false);
    expect(v.tamperedIndices).toEqual([5]);
    const r = acknowledgeRedaction([5], "password literal removed");
    expect(r.acknowledged).toEqual([5]);
    expect(r.record?.event).toBe("audit.redact");
    v = verifyChain();
    expect(v.ok).toBe(true);
    expect(v.tamperedIndices).toEqual([]);
    expect(v.redactedIndices).toEqual([5]);
    expect(v.orphanIndices).toEqual([]);
  });

  it("refuses to acknowledge an intact record, a missing one, or an acknowledgement", () => {
    seed(10);
    const r = acknowledgeRedaction([3, 99], "x");
    expect(r.record).toBeNull();
    expect(r.rejected.map((x) => x.why)).toEqual(["content is intact, nothing to acknowledge", "no such record"]);
    redactLine(logPath(), 2);
    const ok = acknowledgeRedaction([2], "y");
    expect(ok.acknowledged).toEqual([2]);
    // the acknowledgement record is index 10; alter it, then try to acknowledge it
    redactLine(logPath(), 10);
    // with its ack record broken, record 2 is tampered again too
    expect(verifyChain().tamperedIndices).toEqual([2, 10]);
    expect(acknowledgeRedaction([10], "z").rejected[0].why).toContain("cannot itself be redacted");
  });

  it("a second edit after the acknowledgement is tampering again", () => {
    seed(10);
    redactLine(logPath(), 4);
    acknowledgeRedaction([4], "first redaction");
    expect(verifyChain().ok).toBe(true);
    const lines = readFileSync(logPath(), "utf-8").split("\n");
    const r = JSON.parse(lines[4]); r.payload.i = 999; lines[4] = JSON.stringify(r);
    writeFileSync(logPath(), lines.join("\n"));
    const v = verifyChain();
    expect(v.ok).toBe(false);
    expect(v.tamperedIndices).toEqual([4]);
    expect(v.redactedIndices).toEqual([]);
  });

  it("requires a reason", () => {
    seed(3);
    expect(() => acknowledgeRedaction([0], "  ")).toThrow(/reason/);
  });

  it("an acknowledged redaction inside the live log no longer blocks rotation", () => {
    seed(2_300);
    redactLine(logPath(), 7);
    expect(rotateAuditLog({ maxRecords: 2_100 }).rotated).toBe(false);
    acknowledgeRedaction([7], "secret removed");
    const r = rotateAuditLog({ maxRecords: 2_100 });
    expect(r.rotated).toBe(true);
    const v = verifyChain();
    expect(v.ok).toBe(true);
    expect(v.redactedIndices).toEqual([7]);
  });
});

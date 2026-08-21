import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  appendAudit,
  autoRotateAuditLog,
  countLiveRecords,
  listSegments,
  verifyChain,
  resetCacheForTest,
} from "../src/audit.js";

let tempHome: string;
let originalHome: string | undefined;
let originalFlag: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "ce-autorotate-"));
  originalHome = process.env.CONTEXTENGINE_HOME;
  originalFlag = process.env.CONTEXTENGINE_AUTO_ROTATE;
  process.env.CONTEXTENGINE_HOME = tempHome;
  delete process.env.CONTEXTENGINE_AUTO_ROTATE;
  resetCacheForTest();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.CONTEXTENGINE_HOME;
  else process.env.CONTEXTENGINE_HOME = originalHome;
  if (originalFlag === undefined) delete process.env.CONTEXTENGINE_AUTO_ROTATE;
  else process.env.CONTEXTENGINE_AUTO_ROTATE = originalFlag;
  resetCacheForTest();
  rmSync(tempHome, { recursive: true, force: true });
});

function seed(n: number) {
  for (let i = 0; i < n; i++) appendAudit("learning.save", { i }, "test");
}

// [LOCK] [AUTO-ROTATE-HYSTERESIS-AND-ONE-RUNNER]
describe("audit auto-rotation at MCP startup", () => {
  it("does nothing with no log on disk", () => {
    const o = autoRotateAuditLog({ trigger: 10, maxRecords: 5 });
    expect(o.action).toBe("below_trigger");
    expect(o.liveRecords).toBe(0);
  });

  it("stays quiet at or below the trigger", () => {
    seed(10);
    expect(countLiveRecords()).toBe(10);
    const o = autoRotateAuditLog({ trigger: 10, maxRecords: 5 });
    expect(o.action).toBe("below_trigger");
    expect(listSegments().length).toBe(0);
  });

  it("rotates down to the ceiling once above the trigger, chain intact, lock released", () => {
    // MIN_LIVE_RECORDS (2000) is the floor, so seed past it to see the ceiling bite.
    seed(2_300);
    const o = autoRotateAuditLog({ trigger: 2_200, maxRecords: 2_100 });
    expect(o.action).toBe("rotated");
    expect(o.result?.archiveCount).toBe(200);
    expect(listSegments().length).toBe(1);
    expect(countLiveRecords()).toBe(2_101); // remainder + the audit.rotate record
    expect(verifyChain().ok).toBe(true);
    expect(existsSync(join(tempHome, "audit.rotate.lock"))).toBe(false);
    // Hysteresis: a second start right after does not rotate again.
    expect(autoRotateAuditLog({ trigger: 2_200, maxRecords: 2_100 }).action).toBe("below_trigger");
  });

  it("a late starter sees the fresh lock and backs off without touching the log", () => {
    seed(2_300);
    writeFileSync(join(tempHome, "audit.rotate.lock"), "1\n");
    const o = autoRotateAuditLog({ trigger: 2_200, maxRecords: 2_100 });
    expect(o.action).toBe("in_progress");
    expect(listSegments().length).toBe(0);
    expect(countLiveRecords()).toBe(2_300);
  });

  it("breaks a stale lock left by a crashed rotation", () => {
    seed(2_300);
    const lock = join(tempHome, "audit.rotate.lock");
    writeFileSync(lock, "1\n");
    const old = (Date.now() - 11 * 60_000) / 1000;
    utimesSync(lock, old, old);
    const o = autoRotateAuditLog({ trigger: 2_200, maxRecords: 2_100 });
    expect(o.action).toBe("rotated");
    expect(existsSync(lock)).toBe(false);
  });

  it("honours CONTEXTENGINE_AUTO_ROTATE=0", () => {
    seed(2_300);
    process.env.CONTEXTENGINE_AUTO_ROTATE = "0";
    expect(autoRotateAuditLog({ trigger: 10, maxRecords: 5 }).action).toBe("disabled");
    expect(listSegments().length).toBe(0);
  });

  it("refuses, and says so, on a chain that does not verify", () => {
    seed(2_300);
    const path = join(tempHome, "audit.log");
    const lines = require("fs").readFileSync(path, "utf-8").split("\n");
    const r = JSON.parse(lines[5]); r.payload = { i: "TAMPERED" }; lines[5] = JSON.stringify(r);
    writeFileSync(path, lines.join("\n"));
    const o = autoRotateAuditLog({ trigger: 2_200, maxRecords: 2_100 });
    expect(o.action).toBe("refused");
    expect(o.detail).toContain("does not verify");
    expect(listSegments().length).toBe(0);
  });

  // [LOCK] [ROTATE-REFUSES-LIVE-DAMAGE-ONLY]
  it("rotates past damage confined to an archived segment, still refuses damage in the live log", () => {
    seed(2_300);
    expect(autoRotateAuditLog({ trigger: 2_200, maxRecords: 2_100 }).action).toBe("rotated");
    const seg = join(tempHome, "audit-archive", "audit-0001.jsonl");
    const fs = require("fs");
    const lines = fs.readFileSync(seg, "utf-8").split("\n");
    const r = JSON.parse(lines[3]); r.payload = { i: "[REDACTED_SECRET]" }; lines[3] = JSON.stringify(r);
    fs.writeFileSync(seg, lines.join("\n"));
    expect(verifyChain().ok).toBe(false);
    seed(300);
    const o = autoRotateAuditLog({ trigger: 2_300, maxRecords: 2_100 });
    expect(o.action).toBe("rotated");
    expect(listSegments().length).toBe(2);
    const live = join(tempHome, "audit.log");
    const ll = fs.readFileSync(live, "utf-8").split("\n");
    const q = JSON.parse(ll[10]); q.payload = { i: "TAMPERED" }; ll[10] = JSON.stringify(q);
    fs.writeFileSync(live, ll.join("\n"));
    seed(300);
    const o2 = autoRotateAuditLog({ trigger: 2_300, maxRecords: 2_100 });
    expect(o2.action).toBe("refused");
    expect(o2.detail).toContain("in the live log");
  });
});

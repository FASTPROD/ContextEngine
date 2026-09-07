// [LOCK] [PUSHED-MEANS-CI-READ]: a red run for HEAD is a FAIL; no runs or no gh is "not checked".
import { describe, it, expect, beforeAll } from "vitest";

let C: typeof import("./ci-status.js");
beforeAll(async () => { C = await import("./ci-status.js"); });

const sha = "52f6be0cef170000000000000000000000000000";
const runner = (runs: unknown, ghFails = false, gitFails = false) => (cmd: string, args: string[]) => {
  if (cmd === "git") { if (gitFails) throw new Error("no git"); return sha; }
  if (ghFails) throw new Error("gh: not logged in");
  expect(args).toEqual(["run", "list", "--limit", "40", "--json", "name,status,conclusion,url,headSha"]);
  return JSON.stringify(runs);
};

describe("ciStatusForHead", () => {
  it("reports failed when any run for HEAD failed, and ignores runs of other commits", () => {
    const s = C.ciStatusForHead("/r", runner([
      { name: "CI", status: "completed", conclusion: "failure", url: "u1", headSha: sha },
      { name: "CodeQL", status: "completed", conclusion: "success", url: "u2", headSha: sha },
      { name: "CI", status: "completed", conclusion: "success", url: "u3", headSha: "other" },
    ]));
    expect(s.state).toBe("failed");
    expect(s.runs.map((r) => r.name)).toEqual(["CI", "CodeQL"]);
    const text = C.formatCiStatus(s).join("\n");
    expect(text).toMatch(/❌ FAIL CI: failure  u1/);
    expect(text).toMatch(/✅ CodeQL: success/);
  });
  it("is pending while a run is still going, ok when all completed green", () => {
    expect(C.ciStatusForHead("/r", runner([{ name: "CI", status: "in_progress", conclusion: null, url: "u", headSha: sha }])).state).toBe("pending");
    expect(C.ciStatusForHead("/r", runner([{ name: "CI", status: "completed", conclusion: "success", url: "u", headSha: sha }, { name: "Telegram alert", status: "completed", conclusion: "skipped", url: "u", headSha: sha }])).state).toBe("ok");
  });
  it("never reads absence as green: no runs, no gh, no git are all 'not checked'", () => {
    expect(C.ciStatusForHead("/r", runner([])).state).toBe("no-runs");
    expect(C.ciStatusForHead("/r", runner([], true)).state).toBe("unavailable");
    expect(C.ciStatusForHead("/r", runner([], false, true)).state).toBe("unavailable");
    expect(C.formatCiStatus(C.ciStatusForHead("/r", runner([])))[0]).toMatch(/not checked/);
  });
});

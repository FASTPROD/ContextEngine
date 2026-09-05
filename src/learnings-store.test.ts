// [LOCK] [STORE-NEVER-STARTS-FRESH-OVER-DATA]: the failure paths of the learnings store,
// each one the shape of the 2026-09-05 loss. Runs against a throwaway HOME, so the real
// ~/.contextengine is never touched. HOME must be set BEFORE the module is imported:
// LEARNINGS_PATH is computed at import time.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "ce-store-test-"));
const dir = join(home, ".contextengine");
const storePath = join(dir, "learnings.json");
const lockDir = storePath + ".lock";
let L: typeof import("./learnings.js");

function writeStore(n: number, prefix = "seed"): void {
  mkdirSync(dir, { recursive: true });
  const learnings = Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`, category: "other", rule: `${prefix} rule number ${i} long enough`, context: "",
    tags: [], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z",
  }));
  writeFileSync(storePath, JSON.stringify({ version: 1, count: n, learnings }));
}
function readStore(): any { return JSON.parse(readFileSync(storePath, "utf-8")); }
// First load merges the bundled defaults into a fresh file, so counts are relative to this baseline.
function seed(n: number, prefix = "seed"): number { writeStore(n, prefix); L.listLearnings(); return readStore().learnings.length; }
function tmpFiles(): string[] { return readdirSync(dir).filter((f) => f.startsWith("learnings.json.tmp-")); }

beforeAll(async () => {
  process.env.HOME = home;
  process.env.CONTEXTENGINE_HOME = dir; // learnings.ts honours it at import, like audit.ts
  process.env.CONTEXTENGINE_LOCK_TIMEOUT_MS = "300";
  delete process.env.CONTEXTENGINE_ALLOW_SHRINK;
  L = await import("./learnings.js");
});
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

describe("atomic writes", () => {
  it("a save leaves a parseable file and no temp file behind", () => {
    const base = seed(5);
    const saved = L.saveLearning("testing", "atomic write test rule that is long enough", "ctx");
    expect(saved.id).toBeTruthy();
    expect(readStore().learnings.length).toBe(base + 1);
    expect(tmpFiles()).toEqual([]);
    expect(existsSync(lockDir)).toBe(false);
  });
});

describe("an unreadable existing store never becomes an empty one", () => {
  it("throws, keeps a .corrupt copy, and leaves the original untouched", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(storePath, '{"version":1,"count":3,"learnings":[{"id":"a","category":"other","rule":"half written');
    expect(() => L.listLearnings()).toThrow(/unreadable|refusing to start fresh/);
    expect(readFileSync(storePath, "utf-8")).toContain("half written");
    expect(readdirSync(dir).some((f) => f.startsWith("learnings.json.corrupt-"))).toBe(true);
  });
  it("a save on top of an unreadable store is refused too, so nothing overwrites it", () => {
    expect(() => L.saveLearning("testing", "must not be written over garbage at all", "ctx")).toThrow(/unreadable/);
    expect(readFileSync(storePath, "utf-8")).toContain("half written");
  });
});

describe("shrink tripwire", () => {
  it("refuses to write a store less than half the size of the one on disk", () => {
    writeStore(200);
    // Simulate what the race produced: an in-memory store rebuilt from almost nothing.
    expect(() => L.withStoreLock(() => {
      // reach the writer through the public API: delete 150 records one by one would be
      // 150 saves; instead import into a batch that ends up small is not possible, so use
      // the internal path via saveLearning after truncating the file it will read.
      writeFileSync(storePath, JSON.stringify({ version: 1, count: 1, learnings: [] }));
      return L.saveLearning("testing", "single rule in a nearly empty store", "ctx");
    })).not.toThrow(); // disk had 0 (< 100) at write time: allowed, first-run shape
    writeStore(200);
    const store = JSON.stringify({ version: 1, count: 3, learnings: readStore().learnings.slice(0, 3) });
    // Now the disk holds 200 and a writer tries to put 3 over it.
    expect(() => L.__writeStoreForTests(JSON.parse(store))).toThrow(/refusing to write 3 learnings over a store of 200/);
    expect(readStore().learnings.length).toBe(200);
  });
  it("CONTEXTENGINE_ALLOW_SHRINK=1 is the deliberate override", () => {
    writeStore(200);
    process.env.CONTEXTENGINE_ALLOW_SHRINK = "1";
    try {
      L.__writeStoreForTests({ version: 1, count: 3, learnings: readStore().learnings.slice(0, 3) });
      expect(readStore().learnings.length).toBe(3);
    } finally { delete process.env.CONTEXTENGINE_ALLOW_SHRINK; }
  });
});

describe("cross-process lock", () => {
  it("a fresh lock held by another process makes the writer wait, then refuse", () => {
    writeStore(5);
    mkdirSync(lockDir);
    const t0 = Date.now();
    expect(() => L.saveLearning("testing", "blocked by a live lock held elsewhere", "ctx")).toThrow(/locked by another process/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    rmSync(lockDir, { recursive: true, force: true });
  });
  it("a stale lock (older than 30s) is taken over", () => {
    writeStore(5);
    mkdirSync(lockDir);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);
    const saved = L.saveLearning("testing", "stale lock taken over, write proceeds", "ctx");
    expect(saved.id).toBeTruthy();
    expect(existsSync(lockDir)).toBe(false);
  });
});

describe("imports are one batch", () => {
  it("a markdown import of many rules writes the file once and preserves existing ids", () => {
    writeStore(3, "keep");
    const md = join(home, "rules.md");
    // Importer shape: "## <category>" then one "### <rule>" per rule, context lines below.
    const lines = ["# Learnings", "", "## testing", ""];
    for (let i = 0; i < 40; i++) lines.push(`### imported rule number ${i} that is long enough to count`, `context ${i}`, "");
    lines.push("## other", "", "### keep rule number 1 long enough", "refreshed context", ""); // matches an existing record: update, not duplicate
    writeFileSync(md, lines.join("\n"));
    const before = readStore();
    const result = L.importLearningsFromFile(md, "other", "TestProj");
    const after = readStore();
    expect(result.imported).toBeGreaterThanOrEqual(40);
    expect(after.learnings.find((l: any) => l.id === "keep1")).toBeTruthy();
    expect(after.learnings.find((l: any) => l.id === "keep1").created).toBe(before.learnings[1].created);
    expect(tmpFiles()).toEqual([]);
    expect(existsSync(lockDir)).toBe(false);
  });
  it("autoImportFromSources over several files is one batch too", () => {
    const base = seed(2, "base");
    const paths: Array<{ path: string; name: string }> = [];
    for (let f = 0; f < 3; f++) {
      const p = join(home, `src${f}.md`);
      // "## Lessons learned" puts the section in the learnings scope; a plain "## testing" no longer
      // does ([LOCK] [AUTO-IMPORT-ONLY-MARKED-LEARNINGS]).
      writeFileSync(p, `# Notes\n\n## Lessons learned\n\n### auto rule ${f} alpha long enough\nctx\n\n### auto rule ${f} beta long enough\nctx\n`);
      paths.push({ path: p, name: `Proj${f} — src${f}.md` });
    }
    const r = L.autoImportFromSources(paths);
    expect(r.imported).toBe(6);
    expect(readStore().learnings.length).toBe(base + 6);
    expect(tmpFiles()).toEqual([]);
  });
});

describe("daily backup", () => {
  it("the first write of the day copies the previous file to learnings.json.bak-YYYYMMDD", () => {
    writeStore(4);
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const bak = `${storePath}.bak-${day}`;
    rmSync(bak, { force: true });
    L.saveLearning("testing", "daily backup trigger rule long enough", "ctx");
    expect(existsSync(bak)).toBe(true);
    expect(JSON.parse(readFileSync(bak, "utf-8")).learnings.length).toBe(4);
  });
});

describe("robustness against old records", () => {
  it("a record without a category is listed under other and never crashes a category filter", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(storePath, JSON.stringify({ version: 1, count: 1, learnings: [
      { id: "L0192", rule: "legacy record without a category field", context: "", tags: [], created: "2026-05-01T00:00:00.000Z", updated: "2026-05-01T00:00:00.000Z" },
    ] }));
    expect(() => L.listLearnings("architecture")).not.toThrow();
    expect(L.listLearnings("other").some((l) => l.id === "L0192")).toBe(true);
  });
  it("re-saving an identical rule changes nothing: same updated stamp, no write", () => {
    const base = seed(3);
    const first = L.saveLearning("testing", "identical re-save leaves no trace at all", "same ctx");
    const stampBefore = readFileSync(storePath, "utf-8");
    const again = L.saveLearning("testing", "identical re-save leaves no trace at all", "same ctx");
    expect(again.id).toBe(first.id);
    expect(again.updated).toBe(first.updated);
    expect(readFileSync(storePath, "utf-8")).toBe(stampBefore);
    expect(readStore().learnings.length).toBe(base + 1);
  });
});

describe("[STORE-GROWTH-IS-A-TRIPWIRE-TOO]", () => {
  it("refuses one write that adds more than MAX_GROWTH_PER_WRITE records, and leaves the file as it was", () => {
    const base = seed(10);
    const before = readFileSync(storePath, "utf-8");
    const many = Array.from({ length: L.MAX_GROWTH_PER_WRITE + 1 }, (_, i) => ({ id: `g${i}`, category: "other", rule: `runaway import rule number ${i} long enough`, context: "", tags: [], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" }));
    const store = JSON.parse(before);
    store.learnings.push(...many);
    expect(() => L.__writeStoreForTests(store)).toThrow(/runaway import/);
    expect(readFileSync(storePath, "utf-8")).toBe(before);
    expect(readStore().learnings.length).toBe(base);
  });
  it("accepts a write of exactly MAX_GROWTH_PER_WRITE new records", () => {
    const base = seed(10);
    const store = readStore();
    for (let i = 0; i < L.MAX_GROWTH_PER_WRITE; i++) store.learnings.push({ id: `ok${i}`, category: "other", rule: `bulk but allowed rule number ${i} long enough`, context: "", tags: [], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" });
    L.__writeStoreForTests(store);
    expect(readStore().learnings.length).toBe(base + L.MAX_GROWTH_PER_WRITE);
  });
  it("CONTEXTENGINE_ALLOW_BULK=1 lets one deliberate bulk write through", () => {
    seed(10);
    const store = readStore();
    for (let i = 0; i < L.MAX_GROWTH_PER_WRITE + 50; i++) store.learnings.push({ id: `b${i}`, category: "other", rule: `deliberate bulk rule number ${i} long enough`, context: "", tags: [], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" });
    process.env.CONTEXTENGINE_ALLOW_BULK = "1";
    try { L.__writeStoreForTests(store); } finally { delete process.env.CONTEXTENGINE_ALLOW_BULK; }
    expect(readStore().learnings.length).toBe(store.learnings.length);
  });
  it("a runaway auto-import is refused, reported, and does not throw out of the sweep", () => {
    const base = seed(5);
    const p = join(home, "AGENT-LEARNINGS.md"); // learnings file: every H3 is a rule, on purpose
    const lines = ["# Learnings", ""];
    for (let i = 0; i < L.MAX_GROWTH_PER_WRITE + 5; i++) lines.push(`### runaway rule ${i} that is long enough to count`, "");
    writeFileSync(p, lines.join("\n"));
    const r = L.autoImportFromSources([{ path: p, name: "Proj — AGENT-LEARNINGS.md" }]);
    expect(r.refused).toMatch(/runaway import/);
    expect(r.imported).toBe(0);
    expect(readStore().learnings.length).toBe(base);
  });
});

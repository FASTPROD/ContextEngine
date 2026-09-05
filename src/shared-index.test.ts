// [LOCK] [ONE-INDEXER-MANY-READERS]: one writer per corpus, chosen current-build-first then
// oldest; readers load what it wrote and nothing half-written. Throwaway HOME via test-setup.
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let X: typeof import("./shared-index.js");
const home = () => process.env.CONTEXTENGINE_HOME as string;

type S = import("./server-registry.js").ServerReport["servers"][number];
const srv = (pid: number, started: string, staleBuild: boolean, corpus = "c1"): S => ({
  pid, ppid: 1, parent: "test", started, heartbeat: started, version: "0", script: "x", build: "b",
  cwd: "/", node: "v", corpus, alive: true, currentBuild: "b", staleBuild,
});

beforeAll(async () => {
  X = await import("./shared-index.js");
  mkdirSync(home(), { recursive: true });
});

describe("sharedIndexEnabled", () => {
  it("is off unless CONTEXTENGINE_SHARED_INDEX=1", () => {
    const prev = process.env.CONTEXTENGINE_SHARED_INDEX;
    delete process.env.CONTEXTENGINE_SHARED_INDEX;
    expect(X.sharedIndexEnabled()).toBe(false);
    process.env.CONTEXTENGINE_SHARED_INDEX = "1";
    expect(X.sharedIndexEnabled()).toBe(true);
    if (prev === undefined) delete process.env.CONTEXTENGINE_SHARED_INDEX; else process.env.CONTEXTENGINE_SHARED_INDEX = prev;
  });
});

describe("corpusId", () => {
  it("is stable for the same discovery inputs and changes with them", () => {
    const a = X.corpusId();
    expect(a).toBe(X.corpusId());
    expect(a).toHaveLength(12);
    const prev = process.env.OPSCONTEXT_SKIP_CLAUDE_MEMORY;
    process.env.OPSCONTEXT_SKIP_CLAUDE_MEMORY = process.env.OPSCONTEXT_SKIP_CLAUDE_MEMORY === "1" ? "0" : "1";
    expect(X.corpusId()).not.toBe(a);
    if (prev === undefined) delete process.env.OPSCONTEXT_SKIP_CLAUDE_MEMORY; else process.env.OPSCONTEXT_SKIP_CLAUDE_MEMORY = prev;
    const prevWs = process.env.CONTEXTENGINE_WORKSPACES;
    process.env.CONTEXTENGINE_WORKSPACES = join(home(), "elsewhere");
    expect(X.corpusId()).not.toBe(a);
    if (prevWs === undefined) delete process.env.CONTEXTENGINE_WORKSPACES; else process.env.CONTEXTENGINE_WORKSPACES = prevWs;
  });
});

describe("electIndexer", () => {
  it("prefers a current build over an older one, then the earliest start, then the lowest pid", () => {
    const servers = [
      srv(300, "2026-09-05T10:00:00.000Z", true),   // oldest but stale
      srv(200, "2026-09-05T10:00:05.000Z", false),
      srv(100, "2026-09-05T10:00:05.000Z", false),  // same start as 200, lower pid
      srv(400, "2026-09-05T09:00:00.000Z", false, "other"), // another corpus, ignored
    ];
    expect(X.electIndexer("c1", servers, 100)).toEqual({ indexer: 100, role: "indexer" });
    expect(X.electIndexer("c1", servers, 200)).toEqual({ indexer: 100, role: "reader" });
    expect(X.electIndexer("c1", servers, 300)).toEqual({ indexer: 100, role: "reader" });
    expect(X.electIndexer("other", servers, 400)).toEqual({ indexer: 400, role: "indexer" });
  });
  it("a stale build leads only when no current one is alive", () => {
    const servers = [srv(300, "2026-09-05T10:00:00.000Z", true), srv(301, "2026-09-05T10:00:01.000Z", true)];
    expect(X.electIndexer("c1", servers, 301)).toEqual({ indexer: 300, role: "reader" });
  });
  it("a server missing from the registry indexes on its own rather than waiting on nobody", () => {
    expect(X.electIndexer("c1", [srv(1, "2026-09-05T10:00:00.000Z", false)], 999)).toEqual({ indexer: null, role: "indexer" });
    expect(X.electIndexer("c1", [], 999)).toEqual({ indexer: null, role: "indexer" });
  });
});

describe("shared index file", () => {
  const chunk = (content: string) => ({ source: "s", section: "sec", content, lineStart: 1, lineEnd: 2 });
  it("round-trips through a temp file and rename, and reports its mtime", () => {
    const data = {
      corpus: "abc123abc123", seq: 3, writer: process.pid,
      sources: [{ name: "S", path: join(home(), "S.md"), type: "markdown" as const }],
      activeProjectNames: ["P"], chunks: [chunk("one"), chunk("two")], keys: ["k1", "k2"],
    };
    const w = X.writeSharedIndex(data);
    expect(existsSync(w.path)).toBe(true);
    expect(readdirSync(join(home(), "index")).filter((f) => f.includes(".tmp-"))).toEqual([]);
    const r = X.readSharedIndex("abc123abc123")!;
    expect(r.seq).toBe(3);
    expect(r.chunks.map((c) => c.content)).toEqual(["one", "two"]);
    expect(r.keys).toEqual(["k1", "k2"]);
    expect(r.version).toBe(X.SHARED_INDEX_VERSION);
    expect(typeof r.stamp).toBe("string");
    expect(X.sharedIndexMtime("abc123abc123")).not.toBeNull();
    expect(X.sharedIndexMtime("nope")).toBeNull();
  });
  it("returns null for a missing, foreign, or inconsistent file instead of half an index", () => {
    expect(X.readSharedIndex("missing")).toBeNull();
    mkdirSync(join(home(), "index"), { recursive: true });
    writeFileSync(X.sharedIndexPath("junk"), "{not json");
    expect(X.readSharedIndex("junk")).toBeNull();
    writeFileSync(X.sharedIndexPath("mismatch"), JSON.stringify({ version: X.SHARED_INDEX_VERSION, corpus: "mismatch", seq: 1, stamp: "", writer: 1, sources: [], activeProjectNames: [], chunks: [chunk("x")], keys: [] }));
    expect(X.readSharedIndex("mismatch")).toBeNull();
    writeFileSync(X.sharedIndexPath("wrongcorpus"), JSON.stringify({ version: X.SHARED_INDEX_VERSION, corpus: "other", seq: 1, stamp: "", writer: 1, sources: [], activeProjectNames: [], chunks: [], keys: [] }));
    expect(X.readSharedIndex("wrongcorpus")).toBeNull();
  });
});

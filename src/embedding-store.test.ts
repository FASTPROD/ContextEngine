// [LOCK] [EMBEDDINGS-ARE-CONTENT-ADDRESSED]: one vector per distinct text, shared by every
// server, only missing texts embedded. Throwaway HOME via src/test-setup.ts.
import { describe, it, expect, beforeAll } from "vitest";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let S: typeof import("./embedding-store.js");
let E: typeof import("./embeddings.js");
const home = () => process.env.CONTEXTENGINE_HOME as string;

const vec = (seed: number) => {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = Math.sin(seed * 1000 + i);
  return v;
};

beforeAll(async () => {
  S = await import("./embedding-store.js");
  E = await import("./embeddings.js");
  mkdirSync(home(), { recursive: true });
});

describe("embedKey", () => {
  it("is stable for the same model and text and differs when either changes", () => {
    expect(S.embedKey("m", "hello")).toBe(S.embedKey("m", "hello"));
    expect(S.embedKey("m", "hello")).not.toBe(S.embedKey("m", "hello!"));
    expect(S.embedKey("m", "hello")).not.toBe(S.embedKey("m2", "hello"));
    expect(S.embedKey("m", "hello")).toHaveLength(32);
  });
});

describe("store round trip", () => {
  it("returns an empty store when the file is missing", () => {
    const l = S.loadEmbeddingStore(join(home(), "nope.bin"));
    expect(l.vectors.size).toBe(0);
    expect(l.foreign).toBe(false);
  });
  it("appends in batches and reads every vector back, byte-exact", () => {
    const p = join(home(), "rt.bin");
    const a = S.embedKey("m", "a"), b = S.embedKey("m", "b"), c = S.embedKey("m", "c");
    S.appendEmbeddings([[a, vec(1)], [b, vec(2)]], p);
    S.appendEmbeddings([[c, vec(3)]], p);
    const l = S.loadEmbeddingStore(p);
    expect(l.records).toBe(3);
    expect(l.partialBytes).toBe(0);
    expect(Array.from(l.vectors.get(c)!)).toEqual(Array.from(vec(3)));
    expect(Array.from(l.vectors.get(a)!)).toEqual(Array.from(vec(1)));
  });
  it("ignores a trailing partial record left by a concurrent appender, and keeps the rest", () => {
    const p = join(home(), "partial.bin");
    S.appendEmbeddings([[S.embedKey("m", "x"), vec(9)]], p);
    appendFileSync(p, Buffer.alloc(100, 7)); // a torn write
    const l = S.loadEmbeddingStore(p);
    expect(l.records).toBe(1);
    expect(l.partialBytes).toBe(100);
    S.appendEmbeddings([[S.embedKey("m", "y"), vec(10)]], p); // the next append cuts the tear first
    const after = S.loadEmbeddingStore(p);
    expect(after.records).toBe(2);
    expect(after.partialBytes).toBe(0);
    expect(Array.from(after.vectors.get(S.embedKey("m", "y"))!)).toEqual(Array.from(vec(10)));
  });
  it("refuses a file that is not ours instead of reading garbage vectors", () => {
    const p = join(home(), "foreign.bin");
    writeFileSync(p, "this is not an embedding store at all, but it is long enough to pass the size check");
    const l = S.loadEmbeddingStore(p);
    expect(l.foreign).toBe(true);
    expect(l.vectors.size).toBe(0);
  });
});

describe("compaction", () => {
  it("does nothing below the record floor, and keeps only live keys above it", () => {
    const p = join(home(), "compact.bin");
    const entries: Array<[string, Float32Array]> = [];
    for (let i = 0; i < 30; i++) entries.push([S.embedKey("m", `t${i}`), vec(i)]);
    S.appendEmbeddings(entries, p);
    const live = new Set([S.embedKey("m", "t1"), S.embedKey("m", "t2")]);
    expect(S.compactEmbeddingStore(live, p, { minRecords: 100 }).compacted).toBe(false);
    const r = S.compactEmbeddingStore(live, p, { minRecords: 10, ratio: 2 });
    expect(r).toEqual({ compacted: true, before: 30, after: 2 });
    const l = S.loadEmbeddingStore(p);
    expect([...l.vectors.keys()].sort()).toEqual([...live].sort());
    expect(readFileSync(p).length).toBe(S._internal.HEADER_BYTES + 2 * S._internal.RECORD_BYTES);
  });
});

describe("embedChunks with the store", () => {
  const chunk = (content: string) => ({ source: "s", section: "sec", content, lineStart: 1, lineEnd: 1 });
  it("embeds only the texts the store does not hold, keeps input order, appends the new ones", async () => {
    const p = join(home(), "ec.bin");
    const calls: string[] = [];
    const fake = async (text: string) => { calls.push(text); return vec(text.length); };
    const chunks = [chunk("one"), chunk("two"), chunk("three")];
    const first = await E.embedChunks(chunks, new Map(), fake, p);
    expect(first.fresh).toBe(3);
    expect(first.reused).toBe(0);
    expect(calls).toHaveLength(3);
    const store = S.loadEmbeddingStore(p).vectors;
    expect(store.size).toBe(3);
    // A doc change: one new chunk, two unchanged.
    calls.length = 0;
    const second = await E.embedChunks([chunk("one"), chunk("two changed"), chunk("three")], store, fake, p);
    expect(calls).toEqual([E.embedInputOf(chunk("two changed"))]);
    expect(second.fresh).toBe(1);
    expect(second.reused).toBe(2);
    expect(second.embedded.map((e) => e.chunk.content)).toEqual(["one", "two changed", "three"]);
    expect(S.loadEmbeddingStore(p).records).toBe(4);
  });
  it("a text repeated inside one batch is embedded once and stored once", async () => {
    const p = join(home(), "dup.bin");
    let n = 0;
    const fake = async () => { n++; return vec(n); };
    const r = await E.embedChunks([chunk("same"), chunk("same")], new Map(), fake, p);
    expect(r.embedded).toHaveLength(2);
    expect(S.loadEmbeddingStore(p).records).toBe(1);
  });
});

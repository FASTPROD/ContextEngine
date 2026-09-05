// [LOCKED] [EMBEDDINGS-ARE-CONTENT-ADDRESSED] 2026-09-05
// [NEVER] key the embedding cache on the whole corpus again (one hash over every chunk), and
//         [NEVER] skip loading the model because "the cache hit".
// WHY: the previous cache (src/cache.ts, removed in this commit) used one SHA-256 over all
//      ~4,400 chunks as its key, and the corpus contains a `git diff --stat HEAD~1..HEAD` ops
//      chunk per project, the learnings and the last session. Any commit in any of 40 projects,
//      any saved learning, or another server with a different cwd writing the same single-slot
//      file made it stale: measured 2 hits in 51 server starts (SESSION_26). Every start and
//      every doc change then re-embedded every chunk, about 2 min unloaded and 29 min under the
//      load those re-embeds themselves created (nine chats open, load average 230). And on the
//      rare hit, initEmbeddings() was never called, so that server had no query pipeline: no
//      semantic search, and reindex() never re-embedded again for its whole life.
// FIX: one vector per distinct embedded text, keyed by SHA-256(model + text), in an
//      append-only binary file shared by every server on the machine. A doc change embeds
//      only its new chunks; a cold start embeds only texts never seen before, whatever the cwd.
//      Whoever embeds loads the model at start; a reader of the shared index loads it on its
//      first semantic query, never "skipped because the cache hit". Appends are one write
//      syscall each; a torn tail is cut before the next append and ignored by the loader.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

export const EMBED_DIM = 384;
const MAGIC = "CEEMB001"; // 8 bytes
const HEADER_BYTES = 16; // magic (8) + dims uint32 LE (4) + reserved (4)
const KEY_BYTES = 16;
const RECORD_BYTES = KEY_BYTES + EMBED_DIM * 4;

export function embeddingStoreDir(): string {
  return process.env.CONTEXTENGINE_HOME || join(homedir(), ".contextengine");
}

export function embeddingStorePath(): string {
  return join(embeddingStoreDir(), "embeddings.bin");
}

/** The key of one embedded text: 16 bytes (32 hex) of SHA-256 over model + text. */
export function embedKey(model: string, text: string): string {
  return createHash("sha256").update(model).update("\0").update(text).digest("hex").slice(0, KEY_BYTES * 2);
}

function header(): Buffer {
  const b = Buffer.alloc(HEADER_BYTES);
  b.write(MAGIC, 0, "ascii");
  b.writeUInt32LE(EMBED_DIM, 8);
  return b;
}

function recordOf(key: string, vec: Float32Array): Buffer {
  const b = Buffer.alloc(RECORD_BYTES);
  Buffer.from(key, "hex").copy(b, 0, 0, KEY_BYTES);
  for (let i = 0; i < EMBED_DIM; i++) b.writeFloatLE(vec[i] ?? 0, KEY_BYTES + i * 4);
  return b;
}

export interface StoreLoad {
  vectors: Map<string, Float32Array>;
  /** Records on disk, duplicates included (the same key appended twice by two servers). */
  records: number;
  /** Bytes ignored at the tail (a partial record from a concurrent appender). */
  partialBytes: number;
  /** True when the file exists but its header is not ours; nothing is read from it. */
  foreign: boolean;
}

/** Read the whole store. Missing file = empty store. ~7 MB for 4,400 vectors, tens of ms. */
export function loadEmbeddingStore(path: string = embeddingStorePath()): StoreLoad {
  const out: StoreLoad = { vectors: new Map(), records: 0, partialBytes: 0, foreign: false };
  if (!existsSync(path)) return out;
  let buf: Buffer;
  try { buf = readFileSync(path); } catch { return out; }
  if (buf.length < HEADER_BYTES || buf.toString("ascii", 0, 8) !== MAGIC || buf.readUInt32LE(8) !== EMBED_DIM) {
    out.foreign = true;
    return out;
  }
  const body = buf.length - HEADER_BYTES;
  const n = Math.floor(body / RECORD_BYTES);
  out.partialBytes = body - n * RECORD_BYTES;
  for (let r = 0; r < n; r++) {
    const off = HEADER_BYTES + r * RECORD_BYTES;
    const key = buf.toString("hex", off, off + KEY_BYTES);
    // A copy, not a view: the file buffer must be collectable.
    const vec = new Float32Array(EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i++) vec[i] = buf.readFloatLE(off + KEY_BYTES + i * 4);
    out.vectors.set(key, vec);
  }
  out.records = n;
  return out;
}

/**
 * Append vectors. One write syscall for the batch; the header is written with the first batch.
 * Two servers creating the file at the same instant both write header + batch and the last
 * truncating write wins; the loser's vectors are simply embedded again later.
 */
export function appendEmbeddings(entries: Array<[string, Float32Array]>, path: string = embeddingStorePath()): { written: number; bytes: number } {
  if (entries.length === 0) return { written: 0, bytes: 0 };
  const recs = Buffer.concat(entries.map(([k, v]) => recordOf(k, v)));
  mkdirSync(join(path, ".."), { recursive: true });
  let size = 0;
  try { size = statSync(path).size; } catch { size = 0; }
  if (size < HEADER_BYTES) {
    writeFileSync(path, Buffer.concat([header(), recs]));
    return { written: entries.length, bytes: recs.length };
  }
  // A torn tail (a writer that died mid-record) would shift the frame of every record appended
  // after it; cut back to the last whole record before adding ours.
  const torn = (size - HEADER_BYTES) % RECORD_BYTES;
  if (torn !== 0) truncateSync(path, size - torn);
  appendFileSync(path, recs);
  return { written: entries.length, bytes: recs.length };
}

/**
 * Rewrite the store with only the live keys, temp file + rename. Called by an indexer when the
 * file holds far more records than the corpus needs (every save of an edited doc appends its
 * changed chunks again). A record appended by another server between the read and the rename
 * is lost and re-embedded later; nothing else can be.
 */
export function compactEmbeddingStore(liveKeys: Set<string>, path: string = embeddingStorePath(), opts: { minRecords?: number; ratio?: number } = {}): { compacted: boolean; before: number; after: number } {
  const minRecords = opts.minRecords ?? 10_000;
  const ratio = opts.ratio ?? 2;
  // Decide from the size first: below the floor there is nothing to read.
  let onDisk = 0;
  try { onDisk = Math.max(0, Math.floor((statSync(path).size - HEADER_BYTES) / RECORD_BYTES)); } catch { onDisk = 0; }
  if (onDisk < minRecords) return { compacted: false, before: onDisk, after: onDisk };
  const load = loadEmbeddingStore(path);
  const live = [...load.vectors.entries()].filter(([k]) => liveKeys.has(k));
  if (load.records < minRecords || load.records < ratio * Math.max(live.length, 1)) {
    return { compacted: false, before: load.records, after: load.records };
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, Buffer.concat([header(), ...live.map(([k, v]) => recordOf(k, v))]));
  renameSync(tmp, path);
  return { compacted: true, before: load.records, after: live.length };
}

export const _internal = { HEADER_BYTES, RECORD_BYTES, KEY_BYTES, MAGIC };

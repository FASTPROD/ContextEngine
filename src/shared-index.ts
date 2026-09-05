// [LOCKED] [ONE-INDEXER-MANY-READERS] 2026-09-05
// [NEVER] let every MCP server watch the corpus and re-index it on its own again once the
//         shared index is on, and [NEVER] let a server whose build is older than the file on
//         disk win the election while a current one is alive.
// WHY: every Claude Code chat spawns its own MCP server (`.mcp.json` per project, the user-scope
//      entry elsewhere), plus launchd, plus VS Code. Each one parsed the same ~820 doc sources,
//      collected ops from 40 projects, watched the same files and re-embedded the whole corpus
//      on every save. Measured 2026-09-05 (SESSION_26): eleven servers, 9.3 CPU-hours in 1.4 h
//      of wall clock, load average 230, a test suite that timed out, and until 2.5.6 nine
//      writers racing on one learnings.json. A stale-build server that kept indexing after a
//      rebuild re-imported 1,766 records the owner had just had deleted (SESSION_25).
// FIX: one writer per corpus, chosen from the server registry (current build first, then the
//      earliest start, then the lowest pid), parses, embeds and writes this file with a stamp;
//      every other server of that corpus loads it read-only and reloads when the stamp moves.
//      Off unless CONTEXTENGINE_SHARED_INDEX=1 until the trial has run on a real fleet. A reader
//      that finds no index runs the old pipeline once, without importing learnings: the fallback
//      is today's code path, not a second one.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { findConfigFile, type KnowledgeSource } from "./config.js";
import type { Chunk } from "./ingest.js";
import type { ServerReport } from "./server-registry.js";

export type ServerRole = "indexer" | "reader";

export const SHARED_INDEX_VERSION = 1;

export function sharedIndexEnabled(): boolean {
  return process.env.CONTEXTENGINE_SHARED_INDEX === "1";
}

function ceHome(): string {
  return process.env.CONTEXTENGINE_HOME || join(homedir(), ".contextengine");
}

/**
 * What a server's corpus is made of, as a short id: the config file it resolved (path and
 * content) or the discovery fallback, and the env flags that change discovery. Two servers with
 * the same id index the same thing and can share one index; different ids get their own writer.
 */
export function corpusId(): string {
  const h = createHash("sha256");
  const cfg = findConfigFile();
  h.update(`config=${cfg ?? "none"}\0`);
  if (cfg) {
    try { h.update(readFileSync(cfg)); } catch { h.update("unreadable"); }
  }
  h.update(`\0ws=${process.env.CONTEXTENGINE_WORKSPACES ?? ""}`);
  h.update(`\0skipmem=${process.env.OPSCONTEXT_SKIP_CLAUDE_MEMORY ?? ""}`);
  h.update(`\0home=${homedir()}`);
  return h.digest("hex").slice(0, 12);
}

export interface SharedIndexFile {
  version: number;
  corpus: string;
  seq: number;
  stamp: string;
  writer: number;
  sources: KnowledgeSource[];
  activeProjectNames: string[];
  chunks: Chunk[];
  /** One embedding-store key per chunk, same order. */
  keys: string[];
}

export function sharedIndexPath(corpus: string): string {
  return join(ceHome(), "index", `${corpus}.json`);
}

/** Temp file + rename: a reader never sees a half-written index. */
export function writeSharedIndex(data: Omit<SharedIndexFile, "version" | "stamp">): { path: string; bytes: number; ms: number } {
  const t0 = Date.now();
  const path = sharedIndexPath(data.corpus);
  mkdirSync(join(path, ".."), { recursive: true });
  const file: SharedIndexFile = { version: SHARED_INDEX_VERSION, stamp: new Date().toISOString(), ...data };
  const json = JSON.stringify(file);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, json);
  renameSync(tmp, path);
  return { path, bytes: Buffer.byteLength(json), ms: Date.now() - t0 };
}

export function readSharedIndex(corpus: string): SharedIndexFile | null {
  const path = sharedIndexPath(corpus);
  if (!existsSync(path)) return null;
  try {
    const f = JSON.parse(readFileSync(path, "utf8")) as SharedIndexFile;
    if (f.version !== SHARED_INDEX_VERSION || f.corpus !== corpus || !Array.isArray(f.chunks) || !Array.isArray(f.keys)) return null;
    if (f.keys.length !== f.chunks.length) return null;
    return f;
  } catch {
    return null;
  }
}

/** Cheap change detector for readers: the file's mtime, or null when absent. */
export function sharedIndexMtime(corpus: string): number | null {
  try { return statSync(sharedIndexPath(corpus)).mtimeMs; } catch { return null; }
}

/**
 * Who indexes this corpus. Among the live registered servers of the corpus: a server whose
 * build equals the file on disk beats a stale one, then the earliest start, then the lowest pid.
 * A server that does not find itself in the registry indexes on its own: never wait on a
 * registry that failed.
 */
export function electIndexer(corpus: string, servers: ServerReport["servers"], myPid: number): { indexer: number | null; role: ServerRole } {
  const mine = servers.filter((s) => s.corpus === corpus);
  if (!mine.some((s) => s.pid === myPid)) return { indexer: null, role: "indexer" };
  mine.sort((a, b) => {
    if (a.staleBuild !== b.staleBuild) return a.staleBuild ? 1 : -1;
    const t = a.started.localeCompare(b.started);
    if (t !== 0) return t;
    return a.pid - b.pid;
  });
  const winner = mine[0];
  return { indexer: winner.pid, role: winner.pid === myPid ? "indexer" : "reader" };
}

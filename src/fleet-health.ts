// [LOCKED] [HEALTH-IS-MEASURED-NEVER-ESTIMATED] 2026-09-06
// [NEVER] put a number in this file that comes from a timer, a multiplier or a guess; every
//         field is counted from the audit log, the server registry, git, or a file on disk.
// WHY: the VS Code status bar showed "CE SAVE SESSION" in yellow on a wall-clock timer and
//      "~N min saved" from a multiplier nobody could check (Session 25 item 4). Meanwhile the
//      real problems of 2026-09-05 (eleven servers re-embedding, load average 230; two servers
//      on a stale build re-importing 1,766 records; a store growth of 1,766 in one minute) had no
//      surface at all. A nag without evidence trains the user to ignore the bar; a fact does not.
// FIX: one function computes the fleet's health from evidence, one writer (the indexer) drops
//      it into ~/.contextengine/fleet-health.json every minute, and every surface (servers CLI,
//      end-session, the status bar) reads the same file. Warnings list measured problems only.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { listServers, type ServerReport } from "./server-registry.js";

export interface FleetHealth {
  generatedAt: string;
  version: string;
  writerPid: number;
  servers: {
    total: number;
    indexers: number;
    readers: number;
    /** Servers whose loaded build differs from the file on disk. */
    stale: Array<{ pid: number; version: string; build: string; cwd: string }>;
    diskBuild: string | null;
  };
  reindex: {
    /** Shared-index writes in the last hour, all corpora. */
    lastHourWrites: number;
    perCorpus: Record<string, number>;
    /** Above this many writes per hour a warning is raised. */
    threshold: number;
  };
  today: {
    /** Pre-commit blocks (hook.block) since local midnight. */
    blocks: number;
    /** Store refusals (unreadable, shrink refused, growth refused) since local midnight. */
    refusals: number;
    learningsSaved: number;
    /** Newest last: time, kind, one-line detail. */
    lastBlocks: Array<{ ts: string; kind: string; detail: string }>;
  };
  /** The newest release for which verify-release passed on this machine, or null. */
  lastVerifiedRelease: string | null;
  /** Measured problems only. Empty means green. */
  warnings: string[];
}

export const REINDEX_PER_HOUR_WARN = 30;
const TAIL_BYTES = 8 * 1024 * 1024;

function ceHome(): string {
  return process.env.CONTEXTENGINE_HOME || join(homedir(), ".contextengine");
}

export function fleetHealthPath(): string {
  return join(ceHome(), "fleet-health.json");
}

/** The last `bytes` of a file as complete lines (the first partial line is dropped). */
function tailLines(path: string, bytes: number): string[] {
  if (!existsSync(path)) return [];
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    return text.split("\n").filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

interface Rec { ts: string; event: string; payload?: Record<string, unknown> }

function parseRecords(lines: string[]): Rec[] {
  const out: Rec[] = [];
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      if (r && typeof r.ts === "string" && typeof r.event === "string") out.push(r);
    } catch {
      /* a torn line, ignored */
    }
  }
  return out;
}

function localMidnight(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

function blockDetail(p: Record<string, unknown> = {}): string {
  const check = String(p.check ?? "block");
  if (p.file) return `${check}: ${String(p.file)}${p.line ? `:${String(p.line)}` : ""}${p.pattern_id ? ` (${String(p.pattern_id)})` : ""}`;
  if (p.requires_section) return `${check}: ${String(p.requires_section)}`;
  if (p.reason) return `${check}: ${String(p.reason)}`;
  return check;
}

/** The highest version with a verify-release marker; version order, not file time (ties). */
export function lastVerifiedRelease(dir: string = ceHome()): string | null {
  let files: string[] = [];
  try { files = readdirSync(dir); } catch { return null; }
  const versions = files.map((f) => /^verified-(\d+\.\d+\.\d+)$/.exec(f)?.[1]).filter((v): v is string => !!v);
  if (versions.length === 0) return null;
  const key = (v: string) => v.split(".").map(Number);
  versions.sort((a, b) => { const x = key(a), y = key(b); return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]); });
  return versions[versions.length - 1];
}

export function computeFleetHealth(opts: { now?: Date; version?: string; auditPath?: string; report?: ServerReport } = {}): FleetHealth {
  const now = opts.now ?? new Date();
  const report = opts.report ?? listServers();
  const audit = opts.auditPath ?? join(ceHome(), "audit.log");
  const records = parseRecords(tailLines(audit, TAIL_BYTES));
  const midnight = localMidnight(now).getTime();
  const hourAgo = now.getTime() - 3_600_000;

  const perCorpus: Record<string, number> = {};
  let lastHourWrites = 0, blocks = 0, refusals = 0, learningsSaved = 0;
  const lastBlocks: FleetHealth["today"]["lastBlocks"] = [];
  for (const r of records) {
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) continue;
    if (r.event === "index.write" && t >= hourAgo) {
      lastHourWrites++;
      const c = String(r.payload?.corpus ?? "?");
      perCorpus[c] = (perCorpus[c] ?? 0) + 1;
    }
    if (t < midnight) continue;
    if (r.event === "hook.block") { blocks++; lastBlocks.push({ ts: r.ts, kind: "pre-commit", detail: blockDetail(r.payload) }); }
    else if (r.event === "learning.store_unreadable" || r.event === "learning.store_shrink_refused" || r.event === "learning.store_growth_refused") {
      refusals++;
      lastBlocks.push({ ts: r.ts, kind: "store", detail: r.event.replace("learning.store_", "").replace(/_/g, " ") });
    } else if (r.event === "learning.save" && r.payload?.mode !== "update") learningsSaved++; // a sweep's updates are not saves
  }

  const stale = report.servers.filter((s) => s.staleBuild).map((s) => ({ pid: s.pid, version: s.version, build: s.build, cwd: s.cwd }));
  const diskBuild = report.servers.find((s) => s.currentBuild)?.currentBuild ?? null;
  const indexers = report.servers.filter((s) => s.role !== "reader").length;

  const warnings: string[] = [];
  if (stale.length > 0) warnings.push(`${stale.length} server(s) on an old build (pid ${stale.map((s) => s.pid).join(", ")}): reload their windows`);
  if (lastHourWrites > REINDEX_PER_HOUR_WARN) warnings.push(`${lastHourWrites} shared-index writes in the last hour (ceiling ${REINDEX_PER_HOUR_WARN}): something saves in a loop`);
  if (refusals > 0) warnings.push(`${refusals} learnings-store refusal(s) today: a write looked like a wipe or a runaway import`);
  for (const w of report.warnings) if (/index on their own/.test(w)) warnings.push(w);

  return {
    generatedAt: now.toISOString(),
    version: opts.version ?? "unknown",
    writerPid: process.pid,
    servers: { total: report.servers.length, indexers, readers: report.servers.length - indexers, stale, diskBuild },
    reindex: { lastHourWrites, perCorpus, threshold: REINDEX_PER_HOUR_WARN },
    today: { blocks, refusals, learningsSaved, lastBlocks: lastBlocks.slice(-3) },
    lastVerifiedRelease: lastVerifiedRelease(),
    warnings,
  };
}

/** Temp file + rename: a reader never sees half a file. */
export function writeFleetHealth(h: FleetHealth): string {
  const path = fleetHealthPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(h, null, 2) + "\n");
  renameSync(tmp, path);
  return path;
}

export function formatFleetHealth(h: FleetHealth): string {
  const lines: string[] = [];
  lines.push(`health: ${h.warnings.length === 0 ? "green" : `${h.warnings.length} measured problem(s)`}  (v${h.version}, last verified release ${h.lastVerifiedRelease ?? "none"}, ${h.generatedAt.slice(11, 19)}Z)`);
  lines.push(`  servers ${h.servers.total}: ${h.servers.indexers} indexing, ${h.servers.readers} reading, ${h.servers.stale.length} on an old build`);
  lines.push(`  shared-index writes last hour: ${h.reindex.lastHourWrites} (ceiling ${h.reindex.threshold})`);
  lines.push(`  today: ${h.today.blocks} block(s) prevented, ${h.today.refusals} store refusal(s), ${h.today.learningsSaved} learning(s) saved`);
  for (const b of h.today.lastBlocks) lines.push(`    ${b.ts.slice(11, 19)}Z ${b.kind}: ${b.detail}`);
  for (const w of h.warnings) lines.push(`  ⚠ ${w}`);
  return lines.join("\n");
}

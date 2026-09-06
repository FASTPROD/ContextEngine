// [LOCKED] [SERVERS-ARE-INVENTORIED] 2026-09-05
// [NEVER] let an MCP server start without writing its registry record, or answer "which
//         servers run and on which build?" from a `ps` grep instead of this registry.
// WHY: on 2026-09-05 two servers started before a build kept running the old importer for
//      two hours and re-imported 1,766 records the owner had just had deleted. `ps` found them
//      only on the second look: the first grep matched the absolute script path and the two
//      had been started with a relative one. Nine other servers, one per open chat, were each
//      re-embedding the whole corpus after every doc change (load average 230) and nothing
//      said so. `server-meta.json` held one version: the last server to start.
// FIX: every server writes ~/.contextengine/servers/<pid>.json on start (pid, parent, start
//      time, version, a hash of the script it loaded, cwd) and refreshes a heartbeat; the file
//      goes on exit, and a lister removes records whose pid is dead. `contextengine servers`
//      and the end-session checklist compare each record's build hash with the file on disk
//      now, and warn when more than SERVER_COUNT_WARN servers run at once.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { execFileSync } from "child_process";

export interface ServerRecord {
  pid: number;
  ppid: number;
  parent: string;
  started: string;
  heartbeat: string;
  version: string;
  script: string;
  build: string;
  cwd: string;
  node: string;
  /** Since 2.6.0: what this server indexes (see shared-index.ts corpusId) and whether it is
   *  the one writing the shared index for it, or a reader of it. Absent on older builds. */
  corpus?: string;
  role?: "indexer" | "reader";
}

export interface ServerReport {
  servers: Array<ServerRecord & { alive: true; currentBuild: string | null; staleBuild: boolean }>;
  removed: number;
  warnings: string[];
}

/** More concurrent servers than this and every doc change costs that many re-embeds. */
export const SERVER_COUNT_WARN = 3;
const HEARTBEAT_MS = 60_000;

function registryDir(): string {
  return join(process.env.CONTEXTENGINE_HOME || join(homedir(), ".contextengine"), "servers");
}

/** Short content hash of the script a server loaded; the build identity. */
export function buildHashOf(scriptPath: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(scriptPath)).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

function parentName(ppid: number): string {
  try {
    // Hardcoded argv, no shell: the only variable is a number.
    return execFileSync("ps", ["-o", "comm=", "-p", String(ppid)], { encoding: "utf8", timeout: 2000 })
      .trim().split("/").pop() || "?";
  } catch {
    return "?";
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM"; // exists, not ours
  }
}

/**
 * Register the running server. Returns a stop() that removes the record; exit handlers call it too.
 */
export function registerServer(opts: { version: string; script: string; corpus?: string; role?: "indexer" | "reader" }): { record: ServerRecord; stop: () => void; setRole: (role: "indexer" | "reader") => void } {
  const dir = registryDir();
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const record: ServerRecord = {
    pid: process.pid,
    ppid: process.ppid,
    parent: parentName(process.ppid),
    started: now,
    heartbeat: now,
    version: opts.version,
    script: opts.script,
    build: buildHashOf(opts.script) || "unknown",
    cwd: process.cwd(),
    node: process.version,
    ...(opts.corpus ? { corpus: opts.corpus } : {}),
    ...(opts.role ? { role: opts.role } : {}),
  };
  const file = join(dir, `${process.pid}.json`);
  const write = () => { try { writeFileSync(file, JSON.stringify(record, null, 2)); } catch { /* registry is diagnostics, never fatal */ } };
  write();
  const timer = setInterval(() => { record.heartbeat = new Date().toISOString(); write(); }, HEARTBEAT_MS);
  timer.unref();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try { unlinkSync(file); } catch { /* already gone */ }
  };
  process.on("exit", stop);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => { stop(); process.exit(0); });
  }
  const setRole = (role: "indexer" | "reader") => { record.role = role; write(); };
  return { record, stop, setRole };
}

/** Read every record, drop the dead ones, compare builds with the files on disk now. */
export function listServers(): ServerReport {
  const dir = registryDir();
  const report: ServerReport = { servers: [], removed: 0, warnings: [] };
  if (!existsSync(dir)) return report;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const path = join(dir, f);
    let rec: ServerRecord;
    try { rec = JSON.parse(readFileSync(path, "utf8")); } catch { try { unlinkSync(path); } catch { /* */ } report.removed++; continue; }
    if (!isAlive(rec.pid)) { try { unlinkSync(path); } catch { /* */ } report.removed++; continue; }
    const currentBuild = buildHashOf(rec.script);
    const staleBuild = currentBuild !== null && rec.build !== "unknown" && currentBuild !== rec.build;
    report.servers.push({ ...rec, alive: true, currentBuild, staleBuild });
  }
  report.servers.sort((a, b) => a.started.localeCompare(b.started));
  const stale = report.servers.filter((s) => s.staleBuild);
  if (stale.length > 0) {
    report.warnings.push(`${stale.length} server(s) run a build older than the file on disk (pid ${stale.map((s) => s.pid).join(", ")}): restart them or they keep the old behaviour`);
  }
  // Only servers that index on their own cost a re-index per doc change; readers of a shared
  // index do not. [LOCK] [ONE-INDEXER-MANY-READERS]
  const indexing = report.servers.filter((s) => s.role !== "reader");
  if (indexing.length > SERVER_COUNT_WARN) {
    report.warnings.push(`${indexing.length} of ${report.servers.length} servers index on their own; every doc change makes each of them re-index the corpus (${SERVER_COUNT_WARN} is the comfortable ceiling; CONTEXTENGINE_SHARED_INDEX=1 makes all but one per corpus readers)`);
  }
  return report;
}

/** CPU seconds consumed and resident memory of a live pid, from ps (hardcoded argv, no shell). */
export function processCost(pid: number): { cpuSeconds: number; rssMb: number } | null {
  try {
    const out = execFileSync("ps", ["-o", "time=,rss=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    const [time, rss] = out.split(/\s+/);
    if (!time) return null;
    const parts = time.split(":").map(Number);
    const cpuSeconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + (parts[1] || 0);
    return { cpuSeconds, rssMb: Math.round(Number(rss || 0) / 1024) };
  } catch {
    return null;
  }
}

function fmtCpu(s: number): string {
  if (s >= 3600) return `${(s / 3600).toFixed(1)} CPU-h`;
  if (s >= 60) return `${Math.round(s / 60)} CPU-min`;
  return `${Math.round(s)} CPU-s`;
}

/**
 * The listing. With `cost`, each line also carries CPU time and memory, and the total: this is
 * the number that was invisible on 2026-09-05 (9.3 CPU-hours across eleven servers) until
 * someone ran ps by hand. [LOCK] [ONE-INDEXER-MANY-READERS]
 */
export function formatServers(report: ServerReport, home: string = homedir(), opts: { cost?: boolean } = {}): string {
  const short = (p: string) => p.startsWith(home) ? "~" + p.slice(home.length) : p;
  const lines: string[] = [];
  lines.push(`${report.servers.length} server(s) running${report.removed ? `, ${report.removed} dead record(s) removed` : ""}`);
  let cpuTotal = 0, rssTotal = 0;
  for (const s of report.servers) {
    const t = s.started.slice(11, 19) + "Z";
    const flag = s.staleBuild ? `STALE BUILD (disk ${s.currentBuild})` : s.currentBuild === null ? "script missing on disk" : "current";
    const role = s.role ? `  ${s.role.padEnd(7)} corpus ${s.corpus ?? "?"}` : "";
    let cost = "";
    if (opts.cost) {
      const c = processCost(s.pid);
      if (c) { cpuTotal += c.cpuSeconds; rssTotal += c.rssMb; cost = `  ${fmtCpu(c.cpuSeconds).padStart(11)} ${String(c.rssMb).padStart(5)} MB`; }
      else cost = "  (cost unknown)";
    }
    lines.push(`  pid ${String(s.pid).padEnd(6)} ${t}  v${s.version}  build ${s.build}  ${flag}${role}${cost}  parent ${s.parent}  cwd ${short(s.cwd)}`);
  }
  if (opts.cost && report.servers.length > 0) lines.push(`  total: ${fmtCpu(cpuTotal)}, ${rssTotal} MB resident, across ${report.servers.length} server(s)`);
  for (const w of report.warnings) lines.push(`  ⚠ ${w}`);
  return lines.join("\n");
}

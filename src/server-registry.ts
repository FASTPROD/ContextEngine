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
export function registerServer(opts: { version: string; script: string }): { record: ServerRecord; stop: () => void } {
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
  return { record, stop };
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
  if (report.servers.length > SERVER_COUNT_WARN) {
    report.warnings.push(`${report.servers.length} servers run at once; every doc change makes each of them re-index and re-embed the corpus (${SERVER_COUNT_WARN} is the comfortable ceiling)`);
  }
  return report;
}

export function formatServers(report: ServerReport, home: string = homedir()): string {
  const short = (p: string) => p.startsWith(home) ? "~" + p.slice(home.length) : p;
  const lines: string[] = [];
  lines.push(`${report.servers.length} server(s) running${report.removed ? `, ${report.removed} dead record(s) removed` : ""}`);
  for (const s of report.servers) {
    const t = s.started.slice(11, 19) + "Z";
    const flag = s.staleBuild ? `STALE BUILD (disk ${s.currentBuild})` : s.currentBuild === null ? "script missing on disk" : "current";
    lines.push(`  pid ${String(s.pid).padEnd(6)} ${t}  v${s.version}  build ${s.build}  ${flag}  parent ${s.parent}  cwd ${short(s.cwd)}`);
  }
  for (const w of report.warnings) lines.push(`  ⚠ ${w}`);
  return lines.join("\n");
}

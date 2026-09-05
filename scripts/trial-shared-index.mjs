#!/usr/bin/env node
// Real trial of one indexer, many readers. [LOCK] [ONE-INDEXER-MANY-READERS]
//
// Three MCP servers from three cwds, one throwaway HOME, one doc change. Proves, from the
// servers' own stderr, the isolated audit log and the registry:
//   1. exactly one server re-indexed and embedded after the change (the indexer),
//   2. both readers answer search_context with the new content within seconds,
//   3. the readers' CPU time stays flat across the change.
// Exits 0 only when all three hold. Run from the repo, on the built dist:
//   node scripts/trial-shared-index.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = process.cwd();
const SERVER = join(REPO, "dist", "index.js");
if (!existsSync(SERVER)) { console.error("build first: npm run build"); process.exit(2); }

const home = mkdtempSync(join(tmpdir(), "ce-trial-"));
const ceHome = join(home, ".contextengine");
const ws = join(home, "ws");
const projects = ["alpha", "beta", "gamma"];
for (const p of projects) {
  mkdirSync(join(ws, p), { recursive: true });
  writeFileSync(join(ws, p, "CLAUDE.md"), `# ${p}\n\n## Deploy\n\nThe ${p} service deploys with its own script.\n\n## Ports\n\n${p} listens on a port of its own.\n`);
  writeFileSync(join(ws, p, "SKILLS.md"), `# ${p} skills\n\n## Testing\n\nRun the ${p} test suite before a release.\n`);
}
const env = {
  ...process.env,
  HOME: home,
  CONTEXTENGINE_HOME: ceHome,
  CONTEXTENGINE_SHARED_INDEX: "1",
  CONTEXTENGINE_WORKSPACES: ws,
  OPSCONTEXT_SKIP_CLAUDE_MEMORY: "1",
  CONTEXTENGINE_AUTO_ROTATE: "0",
  OPSCONTEXT_EVENT_PORT: "0", // never fight the real fleet for 7842
};
delete env.CONTEXTENGINE_CONFIG;

const T0 = Date.now();
const t = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`;
const log = (m) => console.log(`[trial ${t()}] ${m}`);

class Server {
  constructor(name, cwd) {
    this.name = name; this.cwd = cwd; this.err = ""; this.buf = ""; this.pending = new Map(); this.nextId = 1;
    this.child = spawn(process.execPath, [SERVER], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.pid = this.child.pid;
    this.child.stderr.on("data", (d) => { this.err += d.toString(); });
    this.child.stdout.on("data", (d) => {
      this.buf += d.toString();
      const lines = this.buf.split("\n"); this.buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); p(msg); }
      }
    });
  }
  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name}: ${method} timed out`)); }, 180_000);
      this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async init() {
    await this.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "trial", version: "0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  async search(query, mode = "keyword") {
    const r = await this.call("tools/call", { name: "search_context", arguments: { query, mode, top_k: 5 } });
    // Drop the header line: it echoes the query, and so would "No results found for" on its own.
    return (r.result?.content ?? []).map((c) => c.text ?? "").join("\n").split("\n").slice(1).join("\n");
  }
  count(re) { return (this.err.match(re) ?? []).length; }
  cpuSeconds() {
    try {
      const s = execFileSync("ps", ["-o", "time=", "-p", String(this.pid)], { encoding: "utf8" }).trim();
      const parts = s.split(":").map(Number);
      return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    } catch { return NaN; }
  }
  kill() { try { this.child.kill("SIGTERM"); } catch { /* */ } }
}

const waitFor = async (what, fn, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 500)); }
  throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`);
};
const registry = () => readdirSync(join(ceHome, "servers")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(ceHome, "servers", f), "utf8")));
const auditCount = (event, since = 0) => {
  const p = join(ceHome, "audit.log");
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf8").split("\n").slice(since).filter((l) => l.includes(`"event":"${event}"`)).length;
};
const auditLines = () => { const p = join(ceHome, "audit.log"); return existsSync(p) ? readFileSync(p, "utf8").split("\n").length : 0; };

const servers = [];
let failed = false;
try {
  // Start three servers, a few seconds apart so the election is deterministic: A is the indexer.
  for (const [i, p] of projects.entries()) {
    const s = new Server(String.fromCharCode(65 + i), join(ws, p));
    servers.push(s);
    log(`started ${s.name} (pid ${s.pid}) in ${p}`);
    await waitFor(`${s.name} running`, () => /MCP server running/.test(s.err), 120_000);
    await s.init();
    if (i === 0) await waitFor("A semantic ready", () => /Semantic search ready/.test(s.err), 240_000);
  }
  const [A, B, C] = servers;
  const roles = Object.fromEntries(registry().map((r) => [r.pid, r.role]));
  log(`registry roles: ${servers.map((s) => `${s.name}=${roles[s.pid]}`).join(" ")}`);
  if (roles[A.pid] !== "indexer" || roles[B.pid] !== "reader" || roles[C.pid] !== "reader") throw new Error("expected A indexer, B and C readers");
  for (const s of [B, C]) if (!/Shared index loaded/.test(s.err)) throw new Error(`${s.name} did not load the shared index`);

  // Baseline
  const token = `zebra-quokka-${Date.now().toString(36)}`;
  const before = { A: A.cpuSeconds(), B: B.cpuSeconds(), C: C.cpuSeconds() };
  const auditBefore = auditLines();
  const embedsBefore = servers.map((s) => s.count(/Embedded \d+\/\d+ new chunks/g));
  const seqBefore = Math.max(...[B, C].map((s) => Math.max(0, ...[...s.err.matchAll(/Shared index loaded: seq (\d+)/g)].map((m) => Number(m[1])))));
  if ((await B.search(token)).includes(token)) throw new Error("token found before it was written");

  // The doc change
  appendFileSync(join(ws, "beta", "CLAUDE.md"), `\n## Secret handshake\n\nThe deploy password hint is ${token}, never share it.\n`);
  const tChange = Date.now();
  log(`wrote ${token} into beta/CLAUDE.md`);

  // Readers pick up a new seq
  await waitFor("readers reload", () => [B, C].every((s) => Math.max(0, ...[...s.err.matchAll(/Shared index loaded: seq (\d+)/g)].map((m) => Number(m[1]))) > seqBefore), 180_000);
  const tReload = ((Date.now() - tChange) / 1000).toFixed(1);
  const hitB = (await B.search(token)).includes(token);
  const hitC = (await C.search(token)).includes(token);
  const tSearch = ((Date.now() - tChange) / 1000).toFixed(1);
  const hybridC = await C.search(token, "hybrid"); // exercises the reader's lazy model path, answered by keyword the first time
  const hybridOk = hybridC.includes(token);
  await new Promise((r) => setTimeout(r, 4000)); // let any straggler re-index show itself
  const embedsAfter = servers.map((s) => s.count(/Embedded \d+\/\d+ new chunks/g));
  const reindexed = servers.map((s) => s.count(/File changed:/g));
  const after = { A: A.cpuSeconds(), B: B.cpuSeconds(), C: C.cpuSeconds() };
  const indexWrites = auditCount("index.write", auditBefore);
  const importBursts = auditCount("learning.import", auditBefore);

  console.log("");
  console.log("| server | role | File changed seen | embed runs after change | CPU s before -> after |");
  console.log("|---|---|---|---|---|");
  for (const [i, s] of servers.entries()) console.log(`| ${s.name} pid ${s.pid} | ${roles[s.pid]} | ${reindexed[i]} | ${embedsAfter[i] - embedsBefore[i]} | ${before[s.name]} -> ${after[s.name]} |`);
  console.log("");
  console.log(`index.write events after the change: ${indexWrites}; learning.import events after the change: ${importBursts}`);
  console.log(`readers reloaded ${tReload}s after the write; search hit B=${hitB} C=${hitC} at ${tSearch}s; hybrid on a reader answered=${hybridOk}`);

  const oneReindex = reindexed[0] >= 1 && reindexed[1] === 0 && reindexed[2] === 0 && (embedsAfter[1] - embedsBefore[1]) === 0 && (embedsAfter[2] - embedsBefore[2]) === 0;
  const readersFlat = (after.B - before.B) <= 2 && (after.C - before.C) <= 2;
  if (!oneReindex) { failed = true; console.log("FAIL: more than one server re-indexed, or a reader embedded"); }
  if (!(hitB && hitC)) { failed = true; console.log("FAIL: a reader did not find the new content"); }
  if (!readersFlat) { failed = true; console.log("FAIL: a reader's CPU time moved by more than 2 s across the change"); }
  if (indexWrites < 1) { failed = true; console.log("FAIL: no index.write in the audit log"); }
  console.log(failed ? "\nTRIAL FAILED" : "\nTRIAL OK: one re-index, readers current within seconds, readers idle");
} catch (err) {
  failed = true;
  console.log(`\nTRIAL FAILED: ${err.message}`);
  for (const s of servers) console.log(`--- ${s.name} stderr tail ---\n${s.err.slice(-1500)}`);
} finally {
  for (const s of servers) s.kill();
  console.log(`\nthrowaway HOME kept for inspection: ${home}`);
  process.exit(failed ? 1 : 0);
}

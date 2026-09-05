#!/usr/bin/env node
// Real MCP stdio handshake against a server command: initialize, then tools/list.
// Prints one line per fact and exits 0 only when both answered. Used by
// scripts/verify-release.sh; also handy by hand:
//   node scripts/mcp-handshake.mjs <cwd> <command> [args...]
//
// [LOCKED] [RELEASE-PROVEN-BY-HANDSHAKE] 2026-09-05
// [NEVER] declare a version "reaches Claude Code" from `npm view`, a tarball grep, or a
//         `--version` print. Only an initialize + tools/list over stdio counts.
// WHY: Claude Code's own MCP log for this repo showed `sh: opscontext: command not found`
//      on 2026-08-23 and 2026-09-05: `npx -y @compr/opscontext-mcp` can never resolve
//      inside the package's own repo (npx treats it as locally installed), and the global
//      entry sat in a settings file Claude Code does not read. Three releases were
//      "published and verified" while Claude Code ran nothing, and nobody noticed
//      because every check stopped short of a real connection.
// FIX: this probe, run from the repo (local build) AND from a foreign cwd (published
//      package), with the served version compared to the one just published.
import { spawn } from "node:child_process";

const [cwd, cmd, ...args] = process.argv.slice(2);
if (!cwd || !cmd) {
  console.error("usage: node scripts/mcp-handshake.mjs <cwd> <command> [args...]");
  process.exit(2);
}
const expectVersion = process.env.EXPECT_VERSION || "";
const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
let buf = "", err = "", stage = 0;
const fail = (msg) => { console.log(msg); try { child.kill(); } catch {} process.exit(1); };
const timer = setTimeout(() => fail(`TIMEOUT after 120s; stderr: ${err.slice(-400)}`), 120_000);

child.stderr.on("data", (d) => { err += d.toString(); });
child.on("exit", (code) => {
  if (stage < 2) fail(`EXIT ${code} before tools/list; stderr: ${err.slice(-400).trim()}`);
});
child.stdout.on("data", (d) => {
  buf += d.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim().startsWith("{")) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (stage === 0 && msg.id === 1 && msg.result) {
      stage = 1;
      const v = msg.result.serverInfo?.version ?? "?";
      console.log(`initialize OK: ${msg.result.serverInfo?.name} ${v}`);
      if (expectVersion && v !== expectVersion) fail(`VERSION MISMATCH: served ${v}, expected ${expectVersion}`);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    } else if (stage === 1 && msg.id === 2 && msg.result) {
      stage = 2;
      const tools = msg.result.tools ?? [];
      const ll = tools.find((t) => t.name === "list_learnings");
      console.log(`tools/list OK: ${tools.length} tools; list_learnings.since=${!!ll?.inputSchema?.properties?.since}`);
      clearTimeout(timer);
      child.kill();
      process.exit(tools.length > 0 ? 0 : 1);
    }
  }
});
child.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify-release", version: "0" } },
}) + "\n");

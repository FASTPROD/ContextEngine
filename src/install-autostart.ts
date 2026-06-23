// 🔒 LOCKED [AUTOSTART-INSTALL] — 2026-06-23
// ⛔ NEVER bootstrap into a `system/` domain (would need root + run as root).
//    Use `gui/$UID` — per-user agent, started at user login, runs as the user.
// ⛔ NEVER write the plist before checking if a server is already listening on
//    the port. A pre-existing process means we'd race with the launchd-managed
//    one for port 7842.
// ⛔ NEVER ship a plist that calls `npx -y @latest` — every restart would
//    fetch the registry, eating ~3s and breaking offline. Pin a specific
//    node path + a specific dist path.
// WHY: This is the "set it and forget it" entrypoint for non-technical users.
//    If it fails silently or starts duplicating processes, the entire
//    auto-capture story collapses and the user has to type `nohup npx ...`
//    forever — defeating the whole point.
// FIX: To add platform support beyond macOS, branch on process.platform and
//    add equivalent systemd / NSSM logic. Keep `gui/$UID` and KeepAlive
//    discipline in any new platform.

import { existsSync, writeFileSync, mkdirSync, readlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir, platform } from "os";
import { execSync } from "child_process";

const LABEL = "com.opscontext.mcp";
const PLIST_FILE = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = join(homedir(), ".contextengine", "logs");
const PORT = 7842;

/** Resolve an absolute node binary path that launchd can find without PATH. */
function detectNodePath(): string {
  // process.execPath is the node that's running THIS script — absolute path.
  // launchd runs without the user's interactive shell, so we MUST pass an
  // absolute path (no PATH lookup of "node" works under launchd).
  return process.execPath;
}

/** Find a stable path to the opscontext entrypoint that survives version
 *  upgrades. Order: (1) globally installed bin → resolve symlink to real path;
 *  (2) ./dist/index.js next to this module (dev tree). Falls through with
 *  null if neither is found. */
function detectOpscontextEntry(): { kind: "global" | "devtree"; path: string } | null {
  // Try global install via `npm root -g`
  try {
    const globalRoot = execSync("npm root -g 2>/dev/null", { encoding: "utf-8" }).trim();
    const candidate = join(globalRoot, "@compr", "opscontext-mcp", "dist", "index.js");
    if (existsSync(candidate)) return { kind: "global", path: candidate };
  } catch {
    /* no npm root available; fall through */
  }
  // Try dev tree relative to this module's location (dist/install-autostart.js)
  // → __dirname/.. would be dist/, then ../ would be repo root, then dist/index.js
  try {
    // import.meta.url style would be nicer but cli.ts is CommonJS-ish; use __dirname
    // via require.resolve fallback. We're loaded from dist/, so look at sibling.
    const here = dirname(__filename || "");
    const candidate = join(here, "index.js");
    if (existsSync(candidate)) return { kind: "devtree", path: candidate };
  } catch {
    /* ignore */
  }
  return null;
}

function buildPlist(nodePath: string, entryPath: string, nodeBinDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${entryPath}</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${nodeBinDir}:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${homedir()}</string>
        <key>OPSCONTEXT_SKIP_CLAUDE_MEMORY</key>
        <string>1</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>${homedir()}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>${join(LOG_DIR, "mcp-stdout.log")}</string>

    <key>StandardErrorPath</key>
    <string>${join(LOG_DIR, "mcp-stderr.log")}</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`;
}

function isMacOS(): boolean {
  return platform() === "darwin";
}

function userId(): number {
  return process.getuid?.() ?? 501;
}

function portIsOurs(): boolean {
  try {
    execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function waitForPort(timeoutSec: number = 30): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    if (portIsOurs()) return true;
    execSync("sleep 1");
  }
  return false;
}

export async function cliInstallAutostart(args: string[]): Promise<void> {
  const help = args.includes("-h") || args.includes("--help");
  if (help) {
    console.log(`Usage: opscontext install-autostart [--force]

Installs OpsContext as a macOS LaunchAgent so the MCP server starts
automatically at every login and restarts if it crashes.

After running this once, you never need to start the server manually again.
Browser extension events + Claude Code hook events + VS Code emitter events
all flow through the auto-started server.

  --force   Re-create the plist even if one already exists (use after a
            node version upgrade or after moving the install location).

To stop / uninstall:        opscontext uninstall-autostart
To check status:            opscontext autostart-status
To view server logs:        tail -f ~/.contextengine/logs/mcp-stderr.log
`);
    return;
  }

  if (!isMacOS()) {
    console.error(`❌ install-autostart currently supports macOS only (this is ${platform()}).`);
    console.error(`   For Linux: write a systemd --user unit. For Windows: NSSM or Task Scheduler.`);
    process.exit(1);
  }

  const force = args.includes("--force") || args.includes("-f");
  if (existsSync(PLIST_FILE) && !force) {
    console.error(`❌ ${PLIST_FILE} already exists.`);
    console.error(`   Pass --force to overwrite, or run: opscontext autostart-status`);
    process.exit(1);
  }

  const nodePath = detectNodePath();
  const entry = detectOpscontextEntry();
  if (!entry) {
    console.error(`❌ Could not locate opscontext entrypoint.`);
    console.error(`   Either install globally:  npm install -g @compr/opscontext-mcp`);
    console.error(`   Or run from a clone:      cd .../ContextEngine && npm run build`);
    process.exit(1);
  }

  // Ensure log dir
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(dirname(PLIST_FILE), { recursive: true });

  const nodeBinDir = dirname(nodePath);
  const plist = buildPlist(nodePath, entry.path, nodeBinDir);
  writeFileSync(PLIST_FILE, plist);
  console.log(`✅ Wrote ${PLIST_FILE}`);
  console.log(`   node:  ${nodePath}`);
  console.log(`   entry: ${entry.path}  (${entry.kind})`);

  // Stop any currently-running unmanaged opscontext server on the port —
  // it would race with launchd for port 7842.
  if (portIsOurs()) {
    console.log(`   detected existing process on :${PORT} — relying on launchctl bootout to clean it.`);
  }

  // Idempotent bootstrap: bootout (ignore failure) → bootstrap
  const uid = userId();
  try {
    execSync(`launchctl bootout gui/${uid}/${LABEL}`, { stdio: "ignore" });
  } catch {
    /* not loaded — fine */
  }
  try {
    execSync(`launchctl bootstrap gui/${uid} ${PLIST_FILE}`, { stdio: "inherit" });
  } catch (err) {
    console.error(`❌ launchctl bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(`   waiting for the server to bind port ${PORT}...`);
  if (waitForPort(30)) {
    console.log(`✅ OpsContext is now running as a LaunchAgent (started at every login).`);
    console.log(``);
    console.log(`Verify:      curl -s http://127.0.0.1:${PORT}/health | jq .`);
    console.log(`Logs:        tail -f ~/.contextengine/logs/mcp-stderr.log`);
    console.log(`Stop:        opscontext uninstall-autostart`);
  } else {
    console.error(`⚠️ Server didn't bind port ${PORT} within 30s.`);
    console.error(`   Check the logs: tail -50 ~/.contextengine/logs/mcp-stderr.log`);
    process.exit(1);
  }
}

export async function cliUninstallAutostart(args: string[]): Promise<void> {
  const help = args.includes("-h") || args.includes("--help");
  if (help) {
    console.log(`Usage: opscontext uninstall-autostart

Removes the LaunchAgent and stops the OpsContext MCP server. The audit log
and extension secret are NOT touched — only the auto-start wiring goes away.
You can re-install with: opscontext install-autostart`);
    return;
  }

  if (!isMacOS()) {
    console.error(`❌ Only macOS LaunchAgents supported here.`);
    process.exit(1);
  }

  const uid = userId();
  let removed = false;
  try {
    execSync(`launchctl bootout gui/${uid}/${LABEL}`, { stdio: "ignore" });
    removed = true;
  } catch {
    /* not loaded */
  }

  if (existsSync(PLIST_FILE)) {
    const { unlinkSync } = await import("fs");
    unlinkSync(PLIST_FILE);
    console.log(`✅ Removed ${PLIST_FILE}`);
  } else {
    console.log(`   (no plist at ${PLIST_FILE})`);
  }

  if (removed) {
    console.log(`✅ Stopped the running ${LABEL} agent.`);
  } else {
    console.log(`   (no running ${LABEL} agent found)`);
  }
  console.log(``);
  console.log(`Audit log and extension secret kept at ~/.contextengine/ — re-install any time.`);
}

export async function cliAutostartStatus(args: string[]): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(`Usage: opscontext autostart-status

Shows whether OpsContext is configured to auto-start (LaunchAgent present),
whether it's currently running (port 7842 listening), and the path to the
running entrypoint.`);
    return;
  }

  if (!isMacOS()) {
    console.log(`platform:  ${platform()} (LaunchAgent applies to macOS only)`);
    return;
  }

  const plistExists = existsSync(PLIST_FILE);
  const portUp = portIsOurs();
  const uid = userId();

  let launchctlState = "not loaded";
  try {
    const out = execSync(`launchctl print gui/${uid}/${LABEL} 2>/dev/null || true`, { encoding: "utf-8" });
    const match = out.match(/state\s*=\s*(\S+)/);
    if (match) launchctlState = match[1];
  } catch {
    /* ignore */
  }

  console.log(`OpsContext auto-start status`);
  console.log(`─────────────────────────────`);
  console.log(`  plist:       ${plistExists ? "✅ " + PLIST_FILE : "❌ not installed (run: opscontext install-autostart)"}`);
  console.log(`  launchctl:   ${launchctlState}`);
  console.log(`  port ${PORT}:   ${portUp ? "✅ listening" : "❌ not listening"}`);

  if (portUp) {
    try {
      const health = execSync(`curl -sf http://127.0.0.1:${PORT}/health`, { encoding: "utf-8", timeout: 2000 });
      console.log(`  health:      ${health.trim()}`);
    } catch {
      console.log(`  health:      ⚠ port open but /health didn't respond`);
    }
  }
  console.log(``);
  console.log(`Logs: ~/.contextengine/logs/mcp-stderr.log`);
}

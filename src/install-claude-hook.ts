// 🔒 LOCKED [CLAUDE-HOOK-INSTALL] — 2026-06-23
// ⛔ NEVER overwrite existing entries in hooks.PostToolUse — must APPEND.
//    Users (and CE itself via the dogfood settings) commonly have
//    matcher-specific PostToolUse entries (e.g. "Read|Edit|Write" gating)
//    that would be silently destroyed by a replace.
// ⛔ NEVER write to ~/.claude/settings.json without parsing first. A typo
//    or non-JSON state means Claude Code refuses to start.
// ⛔ NEVER emit on PreToolUse — would double-count vs PostToolUse for the
//    `stuck` heuristic and skew `silent_failure` counts.
// WHY: Claude Code hook wiring is the ONLY way the user's terminal Claude
//    Code sessions get into the OpsContext audit log. The installer has to
//    be safe (idempotent, preserve existing) AND legible (clear error
//    messages) AND fast (one command). If users have to hand-edit JSON,
//    they won't.
// FIX: To add a new hook event, extend EVENT_KINDS + the splice block.
//    Keep the "preserve existing" discipline in every code path.

import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
// [LOCK] [M2-ESM-FILENAME-FIX]: the package is "type": "module", so a bare __dirname is a
// ReferenceError at runtime. Found 2026-09-06 while adding the Stop gate: the defaults/ lookup
// below used `__dirname_esm`, and a real run against a throwaway HOME died with
// "__dirname is not defined": the installer had never worked from the published package.
const __dirname_esm = dirname(fileURLToPath(import.meta.url));

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");
const HOOKS_DIR = join(CLAUDE_DIR, "hooks");
const HOOK_SCRIPT = join(HOOKS_DIR, "opscontext-emit.sh");
/** The Stop gate: a wrapper that runs `session-gate` with the node and CLI that installed it.
 *  [LOCK] [SESSION-SAVE-IS-A-GATE] (src/session-gate.ts) */
const GATE_SCRIPT = join(HOOKS_DIR, "opscontext-session-gate.sh");

const EVENT_KINDS = ["UserPromptSubmit", "PostToolUse", "SessionStart"] as const;

export interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

export interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

export interface Settings {
  hooks?: Record<string, HookEntry[]>;
  [k: string]: unknown;
}

function readSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Settings;
  } catch (err) {
    throw new Error(
      `${SETTINGS_FILE} is not valid JSON — refusing to touch. (${err instanceof Error ? err.message : err})`,
    );
  }
}

function backupSettings(): string {
  if (!existsSync(SETTINGS_FILE)) return "";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${SETTINGS_FILE}.bak-pre-opscontext-${ts}`;
  copyFileSync(SETTINGS_FILE, backup);
  return backup;
}

// [LOCKED] [HOOKS-COMPARED-BY-EXPANDED-PATH] - 2026-09-15
// [NEVER] compare a hook command with startsWith or any other literal text match again.
// WHY: settings.json held the emit hooks as "$HOME/.claude/hooks/opscontext-emit.sh <Kind>",
//      hand-wired on 2026-06-23 before this installer existed. On 2026-09-06 the 2.7.0 rollout
//      ran install-claude-hook; its startsWith(absolute path) check did not see them, printed
//      "4 hook entries added, 0 already present" and wrote a second set. From 2026-09-06
//      08:20:21Z every Claude Code event reached the audit log twice (0 doubled events in the 8
//      days before, 99.5 to 100 percent every day after), doubling the stuck and silent_failure
//      inputs that [OPSCONTEXT-CC-HOOK] protects.
// FIX: compare the script path after expanding $HOME, ${HOME} and a leading ~; installing also
//      removes extra copies of our own commands under the same matcher, and nothing else.

/** The script path of a hook command, with $HOME, ${HOME} or a leading ~ expanded. */
export function hookScriptPath(command: string, home: string = homedir()): string {
  const m = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command ?? "");
  const path = m ? (m[1] ?? m[2] ?? m[3]) : "";
  return path.replace(/^(?:\$HOME|\$\{HOME\}|~)(?=\/)/, home);
}

/** The command with its script path expanded, so two spellings of one call compare equal. */
function normalizedCommand(command: string, home: string): string {
  const args = (command ?? "").trim().replace(/^(?:"[^"]*"|'[^']*'|\S+)/, "").trim();
  return `${hookScriptPath(command, home)} ${args}`.trim();
}

function hookAlreadyWired(entries: HookEntry[] | undefined, hookScript: string, home: string = homedir()): boolean {
  return (entries ?? []).some((e) => e.hooks?.some((h) => hookScriptPath(h.command, home) === hookScript));
}

/** Removes repeated registrations of our scripts under the same matcher. Keeps the first copy
 *  and every hook that is not ours; drops an entry only when that leaves it empty. */
export function dropDuplicateHooks(
  entries: HookEntry[],
  ourScripts: string[],
  home: string = homedir(),
): { entries: HookEntry[]; removed: number } {
  const seen = new Set<string>();
  let removed = 0;
  const kept: HookEntry[] = [];
  for (const entry of entries) {
    const before = entry.hooks ?? [];
    const hooks = before.filter((h) => {
      if (!ourScripts.includes(hookScriptPath(h.command, home))) return true;
      const key = `${entry.matcher ?? ""}\u0000${normalizedCommand(h.command, home)}`;
      if (seen.has(key)) {
        removed++;
        return false;
      }
      seen.add(key);
      return true;
    });
    if (hooks.length > 0 || before.length === 0) kept.push({ ...entry, hooks });
  }
  return { entries: kept, removed };
}

/** How many times each event runs `script`. A correct install has exactly 1 everywhere. */
export function countOurHooks(
  settings: Settings,
  events: readonly string[],
  script: string,
  home: string = homedir(),
): Record<string, number> {
  const count = (ev: string) =>
    (settings.hooks?.[ev] ?? []).flatMap((e) => e.hooks ?? []).filter((h) => hookScriptPath(h.command, home) === script).length;
  return Object.fromEntries(events.map((ev) => [ev, count(ev)]));
}

/** Path to the reference hook script bundled with this package. */
function bundledHookSource(): string | null {
  // dist/install-claude-hook.js → ../defaults/claude-code-hook.sh in dev tree,
  // or .../node_modules/@compr/opscontext-mcp/defaults/claude-code-hook.sh
  // when globally / locally installed via npm. Both follow the same relative
  // shape because npm copies defaults/ via the `files` whitelist.
  const candidates = [
    join(__dirname_esm, "..", "defaults", "claude-code-hook.sh"),
    join(__dirname_esm, "defaults", "claude-code-hook.sh"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** dist/cli.js of a global install, when there is one (same preference as install-autostart). */
function globalCliPath(): string | null {
  try {
    const root = execSync("npm root -g 2>/dev/null", { encoding: "utf-8" }).trim();
    const c = join(root, "@compr", "opscontext-mcp", "dist", "cli.js");
    return existsSync(c) ? c : null;
  } catch {
    return null;
  }
}

export async function cliInstallClaudeHook(args: string[]): Promise<void> {
  const help = args.includes("-h") || args.includes("--help");
  if (help) {
    console.log(`Usage: opscontext install-claude-hook

Wires OpsContext into Claude Code's hook system so every terminal Claude
Code session sends prompts + tool calls to the OpsContext audit log.

Events emitted (all go through the local HTTP endpoint, never the network):
  • UserPromptSubmit → vscode.prompt_submit  (feeds the loop heuristic)
  • PostToolUse      → vscode.tool_call      (feeds stuck + silent_failure)
  • SessionStart     → vscode.session_start
  • Stop             → the session gate: a turn cannot end while the repo's CE session
                       is older than the last commit (contextengine session-gate --help)

The installer:
  1. Copies the bundled hook script to ~/.claude/hooks/opscontext-emit.sh
     and writes ~/.claude/hooks/opscontext-session-gate.sh (node + this CLI, absolute paths)
  2. Splices four entries into ~/.claude/settings.json under "hooks"
  3. Preserves every existing hook entry (idempotent, safe to re-run)

A timestamped backup is written next to settings.json before any change.

Pre-req: the MCP server must be auto-started or running (otherwise the hook
silently no-ops, which is the safe default — you won't lose events later).
Run: opscontext install-autostart
`);
    return;
  }

  // Step 1: Install / verify the hook script
  mkdirSync(HOOKS_DIR, { recursive: true });
  const src = bundledHookSource();
  if (!src) {
    console.error(`❌ Could not find bundled hook script defaults/claude-code-hook.sh.`);
    console.error(`   This means the install is incomplete. Reinstall opscontext:`);
    console.error(`     npm install -g @compr/opscontext-mcp`);
    process.exit(1);
  }
  copyFileSync(src, HOOK_SCRIPT);
  chmodSync(HOOK_SCRIPT, 0o755);
  console.log(`✅ Installed hook script: ${HOOK_SCRIPT}`);

  // Step 2: Splice into settings.json
  const settings = readSettings();
  const backup = backupSettings();
  if (backup) console.log(`✅ Backed up settings.json → ${backup}`);

  settings.hooks ??= {};
  const hookCmdPrefix = `${HOOK_SCRIPT}`; // compared by expanded path, [HOOKS-COMPARED-BY-EXPANDED-PATH]

  // [LOCK] [HOOKS-COMPARED-BY-EXPANDED-PATH]: remove extra copies before deciding what to add.
  let deduped = 0;
  for (const kind of [...EVENT_KINDS, "Stop"]) {
    const entries = settings.hooks[kind];
    if (!entries) continue;
    const r = dropDuplicateHooks(entries, [HOOK_SCRIPT, GATE_SCRIPT]);
    settings.hooks[kind] = r.entries;
    deduped += r.removed;
  }

  let added = 0;
  let skipped = 0;

  for (const kind of EVENT_KINDS) {
    settings.hooks[kind] ??= [];
    if (hookAlreadyWired(settings.hooks[kind], hookCmdPrefix)) {
      skipped++;
      continue;
    }
    const entry: HookEntry = {
      hooks: [
        {
          type: "command",
          command: `${HOOK_SCRIPT} ${kind}`,
          timeout: 5,
        },
      ],
    };
    // PostToolUse needs a matcher (PreToolUse/PostToolUse are tool-matched);
    // ".*" matches every tool. Other events are not tool-scoped.
    if (kind === "PostToolUse") entry.matcher = ".*";
    settings.hooks[kind].push(entry);
    added++;
  }

  // Step 3: the Stop gate. Absolute node + CLI paths: hooks run without the user's shell PATH.
  // Prefer the global install: an npx cache copy can be pruned and the hook would then exit 127.
  const cliPath = globalCliPath() ?? join(__dirname_esm, "cli.js");
  writeFileSync(
    GATE_SCRIPT,
    `#!/bin/sh\n# Generated by \`opscontext install-claude-hook\`: the CE session gate on Claude Code Stop.\n# Exit 2 = the turn may not end yet (reason on stderr). See: contextengine session-gate --help\nexec "${process.execPath}" "${cliPath}" session-gate\n`,
  );
  chmodSync(GATE_SCRIPT, 0o755);
  settings.hooks.Stop ??= [];
  if (hookAlreadyWired(settings.hooks.Stop, GATE_SCRIPT)) {
    skipped++;
  } else {
    settings.hooks.Stop.push({ hooks: [{ type: "command", command: GATE_SCRIPT, timeout: 15 }] });
    added++;
  }
  console.log(`✅ Installed session gate: ${GATE_SCRIPT}`);

  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
  const removedNote = deduped ? `, ${deduped} duplicate registrations removed` : "";
  console.log(`✅ ${added} hook entries added, ${skipped} already present${removedNote}.`);

  // [LOCKED] [INSTALL-VERIFIES-BY-COUNT] - 2026-09-15
  // [NEVER] treat the added/present counters above as proof of a correct install.
  // WHY: on 2026-09-06 this command printed "0 already present" over three existing hooks, and
  //      the session that ran it recorded "they were not there"; the doubled audit events then
  //      went unseen for nine days.
  // FIX: re-read settings.json from disk and require exactly one registration per event.
  const written = readSettings();
  const counts = {
    ...countOurHooks(written, EVENT_KINDS, HOOK_SCRIPT),
    ...countOurHooks(written, ["Stop"], GATE_SCRIPT),
  };
  const wrong = Object.entries(counts).filter(([, n]) => n !== 1);
  if (wrong.length > 0) {
    const detail = wrong.map(([ev, n]) => `${ev}=${n}`).join(", ");
    console.error(`❌ settings.json must hold exactly one OpsContext hook per event, found ${detail}. Backup: ${backup || "none"}`);
    process.exit(1);
  }
  console.log(`✅ Verified in settings.json: exactly one registration for ${Object.keys(counts).join(", ")}.`);
  console.log(``);
  console.log(`Test live:`);
  console.log(`  1. Open a NEW VS Code terminal (settings.json is read at session start).`);
  console.log(`  2. Run \`claude\` and ask anything — Claude will use tools.`);
  console.log(`  3. In any other terminal:`);
  console.log(`     tail -f ~/.contextengine/audit.log | grep --line-buffered '"actor":"claude-code"'`);
  console.log(``);
  console.log(`To remove: opscontext uninstall-claude-hook   (or hand-edit ~/.claude/settings.json)`);
}

export async function cliUninstallClaudeHook(args: string[]): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(`Usage: opscontext uninstall-claude-hook

Removes OpsContext hook entries from ~/.claude/settings.json. The hook
script file (~/.claude/hooks/opscontext-emit.sh) is left in place — delete
manually if you want it gone. The audit log is NOT touched.`);
    return;
  }

  const settings = readSettings();
  if (!settings.hooks) {
    console.log(`   (no hooks block in settings.json — nothing to remove)`);
    return;
  }

  const backup = backupSettings();
  if (backup) console.log(`✅ Backed up settings.json → ${backup}`);

  let removed = 0;
  for (const kind of [...EVENT_KINDS, "Stop"] as const) {
    const entries = settings.hooks[kind];
    if (!entries) continue;
    const filtered = entries.filter(
      (e) => !e.hooks?.some((h) => h.command?.includes("opscontext-emit.sh") || h.command?.includes("opscontext-session-gate.sh")),
    );
    removed += entries.length - filtered.length;
    if (filtered.length === 0) {
      delete settings.hooks[kind];
    } else {
      settings.hooks[kind] = filtered;
    }
  }

  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
  console.log(`✅ Removed ${removed} hook entries.`);
  console.log(`   Hook script kept at: ${HOOK_SCRIPT}`);
  console.log(`   Audit log untouched.`);
}

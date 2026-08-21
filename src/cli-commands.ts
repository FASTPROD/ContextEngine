/**
 * 🔒 LOCKED [UNKNOWN-COMMAND-MUST-NOT-START-A-SERVER] — 2026-08-20
 * ⛔ NEVER route an unrecognised argv[2] to the MCP server again. The MCP server starts
 *    ONLY on a bare invocation, or on the explicit `serve` alias.
 * WHY: `cli.ts` dispatched with a long if/else chain ending in `else { import("./index.js") }`,
 *      so ANY unknown token started a stdio server that silently waits on stdin. A typo
 *      (`contextengine scor`), a flag-first invocation (`contextengine --version`) or a
 *      renamed subcommand produced no error, no exit code, and no output — it hung.
 *      This is [ABSENCE-IS-NOT-A-VERDICT] at the dispatch layer: "I do not recognise this"
 *      was rendered as "start the default mode", a plausible action chosen from a branch
 *      that had determined nothing. It has already cost a wrong finding: SESSION_22 §E3
 *      recorded "check_ports is ungated on the CLI" when there is no `check-ports` command
 *      at all — what got measured was an MCP server booting.
 * FIX: KNOWN_COMMANDS below is the single source of truth. Unknown token → name it on
 *      stderr, suggest the nearest command, exit 1. A parity test asserts this list matches
 *      the literals the dispatcher actually handles, so the two cannot drift.
 */

/** Every token `cli.ts` dispatches on, including flag-style aliases. */
export const KNOWN_COMMANDS: readonly string[] = [
  "--help",
  "--version",
  "-h",
  "-v",
  "activate",
  "audit",
  "audit-export",
  "audit-rotate",
  "audit-redact-ack",
  "audit-verify",
  "autostart-status",
  "cost",
  "deactivate",
  "delete-learning",
  "delete-session",
  "emit-event",
  "end-session",
  "export-learnings",
  "help",
  "hook",
  "import-learnings",
  "init",
  "init-extension-secret",
  "install-autostart",
  "install-claude-hook",
  "install-skill",
  "list-learnings",
  "list-projects",
  "list-sessions",
  "list-sources",
  "load-session",
  "policy",
  "save-learning",
  "save-session",
  "score",
  "search",
  "serve",
  "stats",
  "status",
  "sync-claude-md",
  "sync-community-rules",
  "uninstall-autostart",
  "uninstall-claude-hook",
  "version",
  "watch",
];

/** Commands that start the stdio MCP server. A bare invocation (argv[2] undefined)
 *  does the same — that is the documented default and every launcher on disk uses it. */
export const SERVER_COMMANDS: readonly string[] = ["serve"];

/** Levenshtein distance, capped early — only used to build a "did you mean" line. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 4) return 99;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Closest known commands to `input`, nearest first, at most `limit`.
 * Returns [] when nothing is close enough — an empty suggestion list is honest,
 * a wrong suggestion is not.
 */
export function suggestCommands(input: string, limit = 3): string[] {
  const candidates = KNOWN_COMMANDS.filter((c) => !c.startsWith("-"));
  const scored = candidates
    .map((c) => ({ c, d: editDistance(input.toLowerCase(), c) }))
    // A prefix match is always relevant however long the tail ("audit" → "audit-export").
    .map((s) => ({ ...s, d: s.c.startsWith(input.toLowerCase()) ? Math.min(s.d, 2) : s.d }))
    .filter((s) => s.d <= 3)
    .sort((a, b) => a.d - b.d || a.c.localeCompare(b.c));
  return scored.slice(0, limit).map((s) => s.c);
}

export function isKnownCommand(token: string): boolean {
  return KNOWN_COMMANDS.includes(token);
}

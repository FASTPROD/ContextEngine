// [LOCKED] [SESSION-SAVE-IS-A-GATE] 2026-09-06 (moved here from scripts/session-gate.sh, 2.7.0)
// [NEVER] turn this back into a reminder (exit 0 with a message), gate it on a wall clock, or
//         make it block outside a git repo.
// WHY: the owner had to type "check and update session and ce docs!" at the end of every session
//      ("why do I have to write this systematically?", 2026-09-06). The firewall nag lives inside
//      MCP tool responses and the post-push hook only reminds; on 2026-09-05 the MCP server was
//      disconnected for hours and the work went through the CLI, so nothing fired. A rule that
//      lives in prose is not a rule; a Stop hook that refuses is. The first version was a shell
//      script copied into 33 repos, which no paying user could get; now it ships in the package
//      and `install-claude-hook` wires it once, at user scope, for every repo the user opens.
// FIX: compare the repo's CE session file (newest session whose normalized name starts with the
//      repo's normalized basename) with the last commit's time. Older = block (exit 2) with the
//      session-doc and copilot-instructions staleness in the same message, so the docs get the
//      same pass. `stop_hook_active` from Claude Code means "you are already continuing because
//      of me": never block twice. Not a git repo, or no commit yet: nothing to gate, pass.
import { existsSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";

export interface GateInput {
  /** The repository the turn ran in (CLAUDE_PROJECT_DIR, else cwd). */
  repo: string;
  /** Where CE keeps sessions; default ~/.contextengine/sessions. */
  sessionsDir?: string;
  /** Claude Code sets this when the turn is already continuing because of a Stop hook. */
  stopHookActive?: boolean;
  /** Tests: a session file to use instead of the lookup. */
  sessionFile?: string;
}

export interface GateResult {
  block: boolean;
  reason: "loop_guard" | "not_git" | "no_commits" | "fresh" | "stale";
  sessionName: string;
  sessionTs: number;
  commitTs: number;
  /** Commits under src/ since copilot-instructions.md last changed; null when unknown. */
  docsBehind: number | null;
  /** Newest docs/sessions/SESSION_*.md, relative to the repo; null when none. */
  sessionDoc: string | null;
  message: string;
}

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mtime(p: string): number {
  try { return Math.floor(statSync(p).mtimeMs / 1000); } catch { return 0; }
}

function git(repo: string, args: string[]): string | null {
  try {
    // Hardcoded argv, no shell; the only variable parts are paths and a commit hash git itself printed.
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

/** The session for a repo: the newest file whose normalized name starts with the repo's. */
export function findRepoSession(repo: string, sessionsDir: string): { name: string; ts: number } {
  const name = basename(repo);
  const want = normalizeName(name);
  let best = { name, ts: 0 };
  let files: string[] = [];
  try { files = readdirSync(sessionsDir); } catch { return best; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const base = f.slice(0, -5);
    if (!normalizeName(base).startsWith(want)) continue;
    const ts = mtime(join(sessionsDir, f));
    if (ts > best.ts) best = { name: base, ts };
  }
  return best;
}

function newestSessionDoc(repo: string): string | null {
  const dir = join(repo, "docs", "sessions");
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => /^SESSION_.*\.md$/.test(f)); } catch { return null; }
  let best: { f: string; ts: number } | null = null;
  for (const f of files) {
    const ts = mtime(join(dir, f));
    if (!best || ts > best.ts) best = { f, ts };
  }
  return best ? join("docs", "sessions", best.f) : null;
}

function docsBehind(repo: string): number | null {
  const ci = ".github/copilot-instructions.md";
  if (!existsSync(join(repo, ci))) return null;
  const last = git(repo, ["log", "-1", "--format=%H", "--", ci]);
  if (!last) return null;
  const n = git(repo, ["rev-list", "--count", `${last}..HEAD`, "--", "src"]);
  return n === null ? null : Number(n) || 0;
}

function fmt(ts: number): string {
  return ts === 0 ? "never saved" : new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

export function evaluateSessionGate(input: GateInput): GateResult {
  const repo = input.repo;
  const name = basename(repo);
  const sessionsDir = input.sessionsDir ?? join(process.env.CONTEXTENGINE_HOME || join(homedir(), ".contextengine"), "sessions");
  const base: Omit<GateResult, "block" | "reason" | "message"> = { sessionName: name, sessionTs: 0, commitTs: 0, docsBehind: null, sessionDoc: null };
  if (input.stopHookActive) return { ...base, block: false, reason: "loop_guard", message: "" };
  if (!git(repo, ["rev-parse", "--git-dir"])) return { ...base, block: false, reason: "not_git", message: "" };
  const commitRaw = git(repo, ["log", "-1", "--format=%ct"]);
  const commitTs = commitRaw ? Number(commitRaw) || 0 : 0;
  if (commitTs === 0) return { ...base, block: false, reason: "no_commits", message: "" };

  let session: { name: string; ts: number };
  if (input.sessionFile) session = { name: name, ts: existsSync(input.sessionFile) ? mtime(input.sessionFile) : 0 };
  else session = findRepoSession(repo, sessionsDir);

  const doc = newestSessionDoc(repo);
  const behind = docsBehind(repo);
  const filled = { ...base, sessionName: session.name, sessionTs: session.ts, commitTs, docsBehind: behind, sessionDoc: doc };
  if (session.ts >= commitTs) return { ...filled, block: false, reason: "fresh", message: "" };

  const lines = [
    `CE session gate: session '${session.name}' (${fmt(session.ts)}) is older than the last commit (${fmt(commitTs)}). Before ending:`,
    `1. save_session (MCP) session='${session.name}' keys summary and open, with what changed since the last save;`,
    `2. update ${doc ?? "docs/sessions/SESSION_N.md"} if the work changed and commit it;`,
    behind === null
      ? `3. no .github/copilot-instructions.md here; if the project has agent docs, update them the same way;`
      : `3. .github/copilot-instructions.md is ${behind} src commit(s) behind; update it if any of them changed how the project works;`,
    `4. save_learning for any reusable lesson. Then end the turn; this gate passes once the session file is newer than HEAD.`,
  ];
  return { ...filled, block: true, reason: "stale", message: lines.join("\n") };
}

/** Read Claude Code's hook payload from stdin without ever blocking on a TTY. */
async function readStdinJson(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let buf = "";
    const done = () => { try { resolve(buf.trim() ? JSON.parse(buf) : {}); } catch { resolve({}); } };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { buf += d; });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    setTimeout(done, 1500).unref();
  });
}

/** `contextengine session-gate`: the Stop hook body. Exit 2 blocks the turn end, 0 lets it end. */
export async function cliSessionGate(args: string[]): Promise<never> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(`Usage: contextengine session-gate   (as a Claude Code Stop hook; see install-claude-hook)

Refuses to end a Claude Code turn (exit 2, reason on stderr) while the repo's CE session is
older than the last commit. The repo is CLAUDE_PROJECT_DIR or the cwd; the session is the newest
~/.contextengine/sessions/*.json whose name starts with the repo's name. Passes (exit 0) when the
session is newer, outside a git repo, before the first commit, or when stop_hook_active is set.`);
    process.exit(0);
  }
  const payload = await readStdinJson();
  const repo = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const r = evaluateSessionGate({ repo, stopHookActive: payload.stop_hook_active === true });
  if (r.block) {
    console.error(r.message);
    process.exit(2);
  }
  process.exit(0);
}

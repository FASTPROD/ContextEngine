// [LOCKED] [PUSHED-MEANS-CI-READ] 2026-09-07
// [NEVER] let end-session pass while a workflow run for HEAD has failed, and [NEVER] count
//         "no runs found" as green.
// WHY: main's CI had been red on every commit since 2026-09-04 (one lint error, then a Node 18
//      job that eslint 10 cannot run on) and the Telegram alert fired each time. Thirty commits,
//      five releases, nobody read it: the post-commit hook pushes, end-session ran after every
//      push, and nothing in that loop looked at the result. A push is not done until its CI is.
// FIX: end-session check 3c lists every workflow run for the exact HEAD sha through `gh run
//      list` (hardcoded argv, no shell) and counts a failure as a FAIL item. gh missing, no
//      GitHub remote, or no runs yet is reported as "not checked", never as pass.
import { execFileSync } from "child_process";

export interface CiRun { name: string; status: string; conclusion: string | null; url: string }
export interface CiStatus {
  sha: string;
  state: "ok" | "failed" | "pending" | "no-runs" | "unavailable";
  runs: CiRun[];
  note?: string;
}

export type Runner = (cmd: string, args: string[], cwd: string) => string;

const defaultRunner: Runner = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim();

export function ciStatusForHead(cwd: string, run: Runner = defaultRunner): CiStatus {
  let sha = "";
  try { sha = run("git", ["rev-parse", "HEAD"], cwd); } catch { return { sha, state: "unavailable", runs: [], note: "not a git repository" }; }
  let raw = "";
  try {
    raw = run("gh", ["run", "list", "--limit", "40", "--json", "name,status,conclusion,url,headSha"], cwd);
  } catch {
    return { sha, state: "unavailable", runs: [], note: "gh not available, not logged in, or no GitHub remote" };
  }
  let all: Array<CiRun & { headSha: string }> = [];
  try { all = JSON.parse(raw); } catch { return { sha, state: "unavailable", runs: [], note: "gh returned no JSON" }; }
  const runs = all.filter((r) => r.headSha === sha).map(({ name, status, conclusion, url }) => ({ name, status, conclusion, url }));
  if (runs.length === 0) return { sha, state: "no-runs", runs, note: "no workflow run for HEAD yet: pushed seconds ago, or CI not wired" };
  const failed = runs.some((r) => r.conclusion === "failure" || r.conclusion === "timed_out" || r.conclusion === "startup_failure");
  const pending = runs.some((r) => r.status !== "completed");
  return { sha, state: failed ? "failed" : pending ? "pending" : "ok", runs };
}

export function formatCiStatus(s: CiStatus): string[] {
  const lines: string[] = [];
  if (s.state === "unavailable" || s.state === "no-runs") {
    lines.push(`- ⚠️ CI on HEAD${s.sha ? ` ${s.sha.slice(0, 7)}` : ""} not checked: ${s.note}`);
    return lines;
  }
  for (const r of s.runs) {
    const bad = r.conclusion === "failure" || r.conclusion === "timed_out" || r.conclusion === "startup_failure";
    const icon = bad ? "❌ FAIL" : r.status !== "completed" ? "⏳" : r.conclusion === "success" ? "✅" : "▫️";
    lines.push(`- ${icon} ${r.name}: ${r.conclusion ?? r.status}${bad ? `  ${r.url}` : ""}`);
  }
  return lines;
}

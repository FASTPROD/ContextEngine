/**
 * Status Bar — what OpsContext measured, never what it guesses.
 *
 * LOCK [HEALTH-IS-MEASURED-NEVER-ESTIMATED] (src/fleet-health.ts in the package):
 *  - warning colour ONLY on a measured problem: a learnings-store refusal, servers on an old
 *    build, a shared-index write storm, no MCP session, or commits made since the last saved
 *    CE session. Never on a timer.
 *  - default text `$(check) CE` plus what CE did today: blocks prevented and recalls surfaced.
 *    No "time saved": that number was a multiplier nobody could check (Session 25 item 4).
 *  - tooltip: the last blocks with file and reason, today's counts, servers and their roles,
 *    version and last verified release, commits since the session save.
 * Sources: ~/.contextengine/fleet-health.json (FleetHealthPoller), session-stats.json
 * (StatsPoller), git (GitMonitor) and the CE sessions directory. Nothing else.
 *
 * @module statusBar
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import * as vscode from "vscode";
import { type GitSnapshot } from "./gitMonitor";
import { type SessionStats } from "./statsPoller";
import { type FleetHealth } from "./fleetHealthPoller";

/**
 * Commits since the repo's CE session was last saved. Same rule as `contextengine session-gate`
 * (src/session-gate.ts): the session is the newest ~/.contextengine/sessions/*.json whose
 * normalized name starts with the repo's normalized basename. null when not a git repo.
 */
export function commitsSinceSessionSave(repo: string): { commits: number; session: string | null } | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = norm(path.basename(repo));
  const dir = path.join(process.env.CONTEXTENGINE_HOME || path.join(os.homedir(), ".contextengine"), "sessions");
  let best: { name: string; ts: number } | null = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const base = f.slice(0, -5);
      if (!norm(base).startsWith(want)) continue;
      const ts = Math.floor(fs.statSync(path.join(dir, f)).mtimeMs / 1000);
      if (!best || ts > best.ts) best = { name: base, ts };
    }
  } catch { /* no sessions dir yet */ }
  try {
    const since = best ? `--since=@${best.ts}` : "--since=@0";
    // Hardcoded argv, no shell. Counts commits newer than the session file.
    const out = execFileSync("git", ["rev-list", "--count", "HEAD", since], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    return { commits: Number(out) || 0, session: best?.name ?? null };
  } catch {
    return null;
  }
}

export class StatusBarController implements vscode.Disposable {
  private _item: vscode.StatusBarItem;
  private _threshold: number;
  private _lastSnapshot: GitSnapshot | undefined;
  private _lastStats: SessionStats | undefined;
  private _lastHealth: FleetHealth | undefined;
  private _sessionActive = false;
  private _sessionGap: { commits: number; session: string | null } | null = null;
  private _log: vscode.OutputChannel | undefined;

  constructor(outputChannel?: vscode.OutputChannel) {
    this._log = outputChannel;
    this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this._item.command = "contextengine.showStatus";
    this._item.name = "OpsContext";
    const config = vscode.workspace.getConfiguration("contextengine");
    this._threshold = config.get<number>("maxDirtyFilesBeforeWarning", 5);
    this._item.text = "$(shield) CE";
    this._item.tooltip = "OpsContext: reading the fleet…";
    const enabled = config.get<boolean>("enableStatusBar", true);
    this._log?.appendLine(`Status bar: created (enabled=${enabled})`);
    if (enabled) this._item.show();
  }

  updateStats(stats: SessionStats, active: boolean): void {
    this._lastStats = stats;
    this._sessionActive = active;
    this._render();
  }

  updateHealth(health: FleetHealth | undefined): void {
    this._lastHealth = health;
    this._render();
  }

  update(snapshot: GitSnapshot): void {
    this._lastSnapshot = snapshot;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this._sessionGap = root ? commitsSinceSessionSave(root) : null;
    this._render();
  }

  refreshConfig(): void {
    const config = vscode.workspace.getConfiguration("contextengine");
    this._threshold = config.get<number>("maxDirtyFilesBeforeWarning", 5);
    if (config.get<boolean>("enableStatusBar", true)) this._item.show(); else this._item.hide();
    this._render();
  }

  dispose(): void { this._item.dispose(); }

  // -----------------------------------------------------------------------

  /** Measured problems, most urgent first. Empty means green. */
  private _problems(): string[] {
    const p: string[] = [];
    const h = this._lastHealth;
    if (h) {
      if (h.today.refusals > 0) p.push(`${h.today.refusals} store refusal${h.today.refusals > 1 ? "s" : ""} today`);
      if (h.servers.stale.length > 0) p.push(`${h.servers.stale.length} server${h.servers.stale.length > 1 ? "s" : ""} on an old build`);
      if (h.reindex.lastHourWrites > h.reindex.threshold) p.push(`${h.reindex.lastHourWrites} index writes/h`);
    }
    if (this._sessionGap && this._sessionGap.commits > 0) p.push(`${this._sessionGap.commits} commit${this._sessionGap.commits > 1 ? "s" : ""} since session save`);
    if (!this._sessionActive && !h) p.push("no MCP session");
    const dirty = this._lastSnapshot?.totalDirty ?? 0;
    if (dirty >= this._threshold) p.push(`${dirty} uncommitted files`);
    return p;
  }

  private _render(): void {
    const problems = this._problems();
    const blocks = this._lastHealth?.today.blocks ?? 0;
    const recalls = (this._lastStats?.searchRecalls ?? 0) + (this._lastStats?.learningsInjected ?? 0);
    if (problems.length > 0) {
      this._item.text = `$(warning) CE: ${problems[0]}${problems.length > 1 ? ` +${problems.length - 1}` : ""}`;
      this._item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      const facts: string[] = [];
      if (blocks > 0) facts.push(`${blocks} blocked`);
      if (recalls > 0) facts.push(`${recalls} recalled`);
      this._item.text = `$(check) CE${facts.length ? " " + facts.join(", ") : ""}`;
      this._item.backgroundColor = undefined;
    }
    this._item.tooltip = this._tooltip(problems);
  }

  private _tooltip(problems: string[]): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;
    const h = this._lastHealth;
    md.appendMarkdown(`### $(shield) OpsContext${h ? ` v${h.version}` : ""}\n\n`);
    if (problems.length > 0) {
      md.appendMarkdown(`**Measured problems**\n\n`);
      for (const p of problems) md.appendMarkdown(`- $(warning) ${p}\n`);
      md.appendMarkdown(`\n`);
    } else {
      md.appendMarkdown(`**Nothing measured needs you.**\n\n`);
    }
    md.appendMarkdown(`| Today | |\n|---|---|\n`);
    md.appendMarkdown(`| $(circle-slash) Blocks prevented | ${h ? h.today.blocks : "?"} |\n`);
    md.appendMarkdown(`| $(shield) Store refusals | ${h ? h.today.refusals : "?"} |\n`);
    md.appendMarkdown(`| $(save) Learnings saved | ${h ? h.today.learningsSaved : "?"} |\n`);
    md.appendMarkdown(`| $(search) Recalled this session | ${this._sessionActive && this._lastStats ? this._lastStats.searchRecalls + (this._lastStats.learningsInjected || 0) : "no session"} |\n\n`);
    if (h && h.today.lastBlocks.length > 0) {
      md.appendMarkdown(`**Last blocks**\n\n`);
      for (const b of [...h.today.lastBlocks].reverse()) md.appendMarkdown(`- ${b.ts.slice(11, 16)}Z ${b.kind}: \`${b.detail}\`\n`);
      md.appendMarkdown(`\n`);
    }
    if (h) {
      md.appendMarkdown(`**Servers**: ${h.servers.total} (${h.servers.indexers} indexing, ${h.servers.readers} reading)`);
      if (h.servers.stale.length > 0) md.appendMarkdown(`, old build: pid ${h.servers.stale.map((s) => s.pid).join(", ")}`);
      md.appendMarkdown(`; ${h.reindex.lastHourWrites} index write${h.reindex.lastHourWrites === 1 ? "" : "s"} in the last hour\n\n`);
      md.appendMarkdown(`**Release**: v${h.version}, last verified ${h.lastVerifiedRelease ? `v${h.lastVerifiedRelease}` : "none"}\n\n`);
    } else {
      md.appendMarkdown(`*No fleet-health file: no indexing server has written one in the last 5 minutes.*\n\n`);
    }
    if (this._sessionGap) {
      md.appendMarkdown(`**Session**: ${this._sessionGap.session ? `\`${this._sessionGap.session}\`` : "never saved"}, ${this._sessionGap.commits} commit${this._sessionGap.commits === 1 ? "" : "s"} since\n\n`);
    }
    if (this._lastSnapshot) {
      const d = this._lastSnapshot.totalDirty;
      md.appendMarkdown(`$(git-commit) Git: ${d === 0 ? "all clean" : `${d} uncommitted`}\n\n`);
    }
    md.appendMarkdown(`$(git-commit) [Commit All](command:contextengine.commitAll) · $(checklist) [End Session](command:contextengine.endSession) · $(search) [Search](command:contextengine.search)\n`);
    return md;
  }
}

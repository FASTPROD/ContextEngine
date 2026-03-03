/**
 * Status Bar — persistent value meter in the VS Code status bar.
 *
 * Shows what ContextEngine has done for you this session:
 *  - 🧠 N recalls (learnings surfaced via search)
 *  - 💾 N saved (new learnings persisted)
 *  - ⏱ ~Xmin saved (estimated time saved)
 *
 * Falls back to git dirty count when no MCP session is active.
 *
 * Clicking the status bar item runs the `contextengine.showStatus` command
 * which opens a detailed panel.
 *
 * @module statusBar
 */

import * as vscode from "vscode";
import { type GitSnapshot } from "./gitMonitor";
import { type SessionStats } from "./statsPoller";

// ---------------------------------------------------------------------------
// Status Bar Controller
// ---------------------------------------------------------------------------

export class StatusBarController implements vscode.Disposable {
  private _item: vscode.StatusBarItem;
  private _threshold: number;
  private _lastSnapshot: GitSnapshot | undefined;
  private _lastStats: SessionStats | undefined;
  private _sessionActive = false;
  private _log: vscode.OutputChannel | undefined;

  constructor(outputChannel?: vscode.OutputChannel) {
    this._log = outputChannel;

    this._item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100 // high priority — visible near the left edge
    );

    this._item.command = "contextengine.showStatus";
    this._item.name = "ContextEngine";

    const config = vscode.workspace.getConfiguration("contextengine");
    this._threshold = config.get<number>("maxDirtyFilesBeforeWarning", 5);

    // Show immediately with "scanning" state
    this._item.text = "$(shield) CE — scanning…";
    this._item.tooltip = "ContextEngine — scanning workspace…";

    const enabled = config.get<boolean>("enableStatusBar", true);
    this._log?.appendLine(`Status bar: created (enabled=${enabled}, priority=100, alignment=Left)`);

    if (enabled) {
      this._item.show();
      this._log?.appendLine(`Status bar: shown`);
    }
  }

  /**
   * Update the status bar from MCP session stats (primary display).
   */
  updateStats(stats: SessionStats, active: boolean): void {
    this._lastStats = stats;
    this._sessionActive = active;
    this._render();
  }

  /**
   * Update the status bar from a git snapshot (secondary/fallback).
   */
  update(snapshot: GitSnapshot): void {
    this._lastSnapshot = snapshot;
    // Only render from git if we don't have active session stats
    if (!this._sessionActive) {
      this._render();
    }
  }

  /**
   * Refresh configuration (e.g., if user changes settings).
   */
  refreshConfig(): void {
    const config = vscode.workspace.getConfiguration("contextengine");
    this._threshold = config.get<number>("maxDirtyFilesBeforeWarning", 5);

    if (config.get<boolean>("enableStatusBar", true)) {
      this._item.show();
    } else {
      this._item.hide();
    }
  }

  dispose(): void {
    this._item.dispose();
  }

  // -----------------------------------------------------------------------
  // Private: render
  // -----------------------------------------------------------------------

  private _render(): void {
    if (this._sessionActive && this._lastStats) {
      this._renderValueMeter(this._lastStats);
    } else if (this._lastSnapshot) {
      this._renderGitFallback(this._lastSnapshot);
    }
  }

  /**
   * Value meter — shows what CE did for you this session.
   */
  private _renderValueMeter(stats: SessionStats): void {
    const recalls = stats.searchRecalls;
    const saved = stats.learningsSaved;
    const timeSaved = stats.timeSavedMinutes;
    const overdue = stats.sessionOverdue;

    // Session save overdue — show warning state
    if (overdue) {
      this._item.text = `$(warning) CE ⚠️ SAVE SESSION`;
      this._item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      this._item.tooltip = this._buildValueTooltip(stats);
      return;
    }

    // Compact status bar text
    if (timeSaved > 0) {
      this._item.text = `$(shield) CE ~${timeSaved}min saved`;
    } else if (recalls > 0 || saved > 0) {
      this._item.text = `$(shield) CE ${recalls}🔍 ${saved}💾`;
    } else {
      this._item.text = `$(shield) CE`;
    }

    this._item.backgroundColor = undefined;
    this._item.tooltip = this._buildValueTooltip(stats);
  }

  /**
   * Git fallback — shown when no MCP session is active.
   */
  private _renderGitFallback(snapshot: GitSnapshot): void {
    const { totalDirty, dirtyProjects, projects } = snapshot;

    if (totalDirty === 0) {
      this._item.text = "$(check) CE";
      this._item.tooltip = this._buildGitTooltip(
        "✅ All projects clean", projects.length, 0, dirtyProjects
      );
      this._item.backgroundColor = undefined;
    } else if (totalDirty < this._threshold) {
      this._item.text = `$(git-commit) CE: ${totalDirty}`;
      this._item.tooltip = this._buildGitTooltip(
        `${totalDirty} uncommitted file${totalDirty > 1 ? "s" : ""}`,
        projects.length, totalDirty, dirtyProjects
      );
      this._item.backgroundColor = undefined;
    } else if (totalDirty < this._threshold * 2) {
      this._item.text = `$(warning) CE: ${totalDirty}`;
      this._item.tooltip = this._buildGitTooltip(
        `⚠️ ${totalDirty} uncommitted files — commit soon!`,
        projects.length, totalDirty, dirtyProjects
      );
      this._item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
    } else {
      this._item.text = `$(error) CE: ${totalDirty}`;
      this._item.tooltip = this._buildGitTooltip(
        `🔴 ${totalDirty} uncommitted files — commit NOW!`,
        projects.length, totalDirty, dirtyProjects
      );
      this._item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
    }
  }

  // -----------------------------------------------------------------------
  // Private: tooltip builders
  // -----------------------------------------------------------------------

  private _buildValueTooltip(stats: SessionStats): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    md.appendMarkdown(`### $(shield) ContextEngine — Value Meter\n\n`);

    md.appendMarkdown(`| Metric | Value |\n`);
    md.appendMarkdown(`|--------|-------|\n`);
    md.appendMarkdown(`| 🔍 Learnings recalled | ${stats.searchRecalls} |\n`);
    md.appendMarkdown(`| 💾 Learnings saved | ${stats.learningsSaved} |\n`);
    md.appendMarkdown(`| 📋 Compliance nudges | ${stats.nudgesIssued} |\n`);
    md.appendMarkdown(`| ⛔ Truncations | ${stats.truncations} |\n`);
    md.appendMarkdown(`| 🔧 Tool calls | ${stats.toolCalls} |\n`);
    md.appendMarkdown(`| ⏱ Session uptime | ${stats.uptimeMinutes} min |\n`);
    md.appendMarkdown(`| ⏱ **Time saved** | **~${stats.timeSavedMinutes} min** |\n`);
    if (stats.sessionOverdue) {
      md.appendMarkdown(`| ⚠️ **Session save** | **OVERDUE — save now!** |\n`);
    }
    md.appendMarkdown(`\n`);

    // Git status as secondary info
    if (this._lastSnapshot) {
      const dirty = this._lastSnapshot.totalDirty;
      const icon = dirty === 0 ? "$(check)" : dirty < this._threshold ? "$(git-commit)" : "$(warning)";
      md.appendMarkdown(`${icon} Git: ${dirty === 0 ? "all clean" : `${dirty} uncommitted`}\n\n`);
    }

    md.appendMarkdown(
      `$(git-commit) [Commit All](command:contextengine.commitAll) · `
    );
    md.appendMarkdown(
      `$(checklist) [End Session](command:contextengine.endSession) · `
    );
    md.appendMarkdown(
      `$(search) [Search](command:contextengine.search)\n`
    );

    return md;
  }

  private _buildGitTooltip(
    headline: string,
    totalProjects: number,
    totalDirty: number,
    dirtyProjects: { name: string; dirty: number; branch: string }[]
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    md.appendMarkdown(`### $(shield) ContextEngine\n\n`);
    md.appendMarkdown(`**${headline}**\n\n`);
    md.appendMarkdown(`*No active MCP session detected — showing git status*\n\n`);

    if (dirtyProjects.length > 0) {
      md.appendMarkdown(`| Project | Branch | Uncommitted |\n`);
      md.appendMarkdown(`|---------|--------|-------------|\n`);
      for (const p of dirtyProjects) {
        md.appendMarkdown(`| ${p.name} | \`${p.branch}\` | ${p.dirty} |\n`);
      }
      md.appendMarkdown(`\n`);
    }

    md.appendMarkdown(
      `$(git-commit) [Commit All](command:contextengine.commitAll) · `
    );
    md.appendMarkdown(
      `$(checklist) [End Session](command:contextengine.endSession) · `
    );
    md.appendMarkdown(
      `$(search) [Search](command:contextengine.search)\n`
    );

    return md;
  }
}

/**
 * Status Bar — persistent indicator in the VS Code status bar.
 *
 * Shows session health at a glance:
 *  - ✅ 0 uncommitted — all clean
 *  - ⚠️ 5 uncommitted — threshold warning
 *  - 🔴 12 uncommitted — critical
 *
 * Clicking the status bar item runs the `contextengine.showStatus` command
 * which opens a detailed panel.
 *
 * @module statusBar
 */

import * as vscode from "vscode";
import { type GitSnapshot } from "./gitMonitor";

// ---------------------------------------------------------------------------
// Status Bar Controller
// ---------------------------------------------------------------------------

export class StatusBarController implements vscode.Disposable {
  private _item: vscode.StatusBarItem;
  private _threshold: number;

  constructor() {
    this._item = vscode.window.createStatusBarItem(
      "contextengine.status",
      vscode.StatusBarAlignment.Left,
      50 // priority — lower than git, higher than most
    );

    this._item.command = "contextengine.showStatus";
    this._item.name = "ContextEngine";

    const config = vscode.workspace.getConfiguration("contextengine");
    this._threshold = config.get<number>("maxDirtyFilesBeforeWarning", 5);

    // Show immediately with "scanning" state
    this._item.text = "$(sync~spin) CE";
    this._item.tooltip = "ContextEngine — scanning git status…";

    if (config.get<boolean>("enableStatusBar", true)) {
      this._item.show();
    }
  }

  /**
   * Update the status bar from a git snapshot.
   */
  update(snapshot: GitSnapshot): void {
    const { totalDirty, dirtyProjects, projects } = snapshot;

    if (totalDirty === 0) {
      // All clean
      this._item.text = "$(check) CE";
      this._item.tooltip = this._buildTooltip(
        "✅ All projects clean",
        projects.length,
        0,
        dirtyProjects
      );
      this._item.backgroundColor = undefined;
    } else if (totalDirty < this._threshold) {
      // Minor — informational
      this._item.text = `$(git-commit) CE: ${totalDirty}`;
      this._item.tooltip = this._buildTooltip(
        `${totalDirty} uncommitted file${totalDirty > 1 ? "s" : ""}`,
        projects.length,
        totalDirty,
        dirtyProjects
      );
      this._item.backgroundColor = undefined;
    } else if (totalDirty < this._threshold * 2) {
      // Warning
      this._item.text = `$(warning) CE: ${totalDirty}`;
      this._item.tooltip = this._buildTooltip(
        `⚠️ ${totalDirty} uncommitted files — commit soon!`,
        projects.length,
        totalDirty,
        dirtyProjects
      );
      this._item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
    } else {
      // Critical
      this._item.text = `$(error) CE: ${totalDirty}`;
      this._item.tooltip = this._buildTooltip(
        `🔴 ${totalDirty} uncommitted files — commit NOW!`,
        projects.length,
        totalDirty,
        dirtyProjects
      );
      this._item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
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
  // Private
  // -----------------------------------------------------------------------

  private _buildTooltip(
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

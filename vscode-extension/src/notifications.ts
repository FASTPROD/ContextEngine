/**
 * Notification Manager — warning and informational notifications.
 *
 * Fires VS Code notifications when:
 *  - Uncommitted file count exceeds threshold (warning, once per escalation)
 *  - A session has been running for a long time without save
 *  - End-of-session protocol has outstanding items
 *
 * Respects the `contextengine.enableNotifications` setting.
 *
 * @module notifications
 */

import * as vscode from "vscode";
import { type GitSnapshot } from "./gitMonitor";

// ---------------------------------------------------------------------------
// Notification Manager
// ---------------------------------------------------------------------------

export class NotificationManager implements vscode.Disposable {
  /** Track escalation so we don't spam the same warning repeatedly. */
  private _lastNotifiedDirtyCount = 0;
  private _lastNotificationTime = 0;
  private _disposed = false;

  /** Minimum time between notifications (5 minutes). */
  private static readonly MIN_INTERVAL_MS = 5 * 60 * 1000;

  /**
   * Process a git snapshot and fire notifications if warranted.
   */
  async onSnapshot(snapshot: GitSnapshot): Promise<void> {
    if (this._disposed) return;

    const config = vscode.workspace.getConfiguration("contextengine");
    if (!config.get<boolean>("enableNotifications", true)) return;
    if (!config.get<boolean>("autoCommitReminder", true)) return;

    const threshold = config.get<number>("maxDirtyFilesBeforeWarning", 5);
    const { totalDirty, dirtyProjects } = snapshot;

    // Only notify if above threshold
    if (totalDirty < threshold) {
      this._lastNotifiedDirtyCount = 0;
      return;
    }

    // Don't re-notify at the same level too quickly
    const now = Date.now();
    if (
      totalDirty <= this._lastNotifiedDirtyCount &&
      now - this._lastNotificationTime < NotificationManager.MIN_INTERVAL_MS
    ) {
      return;
    }

    // Escalation levels
    const isUrgent = totalDirty >= threshold * 2;
    const projectList = dirtyProjects
      .map((p) => `${p.name} (${p.dirty})`)
      .join(", ");

    if (isUrgent) {
      const action = await vscode.window.showWarningMessage(
        `🚨 ContextEngine: ${totalDirty} uncommitted files across ${dirtyProjects.length} project${dirtyProjects.length > 1 ? "s" : ""}: ${projectList}`,
        "Commit All",
        "Show Status",
        "Dismiss"
      );
      await this._handleAction(action);
    } else {
      const action = await vscode.window.showInformationMessage(
        `$(git-commit) ContextEngine: ${totalDirty} uncommitted files — ${projectList}`,
        "Commit All",
        "Dismiss"
      );
      await this._handleAction(action);
    }

    this._lastNotifiedDirtyCount = totalDirty;
    this._lastNotificationTime = now;
  }

  /**
   * Show a session reminder notification.
   */
  async showSessionReminder(message: string): Promise<void> {
    if (this._disposed) return;

    const config = vscode.workspace.getConfiguration("contextengine");
    if (!config.get<boolean>("enableNotifications", true)) return;

    const action = await vscode.window.showInformationMessage(
      `$(shield) ContextEngine: ${message}`,
      "End Session",
      "Dismiss"
    );

    if (action === "End Session") {
      await vscode.commands.executeCommand("contextengine.endSession");
    }
  }

  dispose(): void {
    this._disposed = true;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private async _handleAction(action: string | undefined): Promise<void> {
    switch (action) {
      case "Commit All":
        await vscode.commands.executeCommand("contextengine.commitAll");
        break;
      case "Show Status":
        await vscode.commands.executeCommand("contextengine.showStatus");
        break;
      default:
        // Dismissed or undefined — do nothing
        break;
    }
  }
}

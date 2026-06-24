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
import type { DriftAuditRecord, DriftKind } from "./driftAlertPoller";

// ---------------------------------------------------------------------------
// Notification Manager
// ---------------------------------------------------------------------------

export class NotificationManager implements vscode.Disposable {
  /** Track escalation so we don't spam the same warning repeatedly. */
  private _lastNotifiedDirtyCount = 0;
  private _lastNotificationTime = 0;
  private _lastDocStaleNotificationTime = 0;
  private _disposed = false;

  /** Minimum time between notifications (5 minutes). */
  private static readonly MIN_INTERVAL_MS = 5 * 60 * 1000;

  /** Minimum time between doc staleness notifications (15 minutes). */
  private static readonly DOC_STALE_INTERVAL_MS = 15 * 60 * 1000;

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
        `🚨 OpsContext: ${totalDirty} uncommitted files across ${dirtyProjects.length} project${dirtyProjects.length > 1 ? "s" : ""}: ${projectList}`,
        "Commit All",
        "Show Status",
        "Dismiss"
      );
      await this._handleAction(action);
    } else {
      const action = await vscode.window.showInformationMessage(
        `$(git-commit) OpsContext: ${totalDirty} uncommitted files — ${projectList}`,
        "Commit All",
        "Dismiss"
      );
      await this._handleAction(action);
    }

    this._lastNotifiedDirtyCount = totalDirty;
    this._lastNotificationTime = now;
  }

  /**
   * Check for stale CE docs and fire a notification if warranted.
   */
  async onDocStaleness(snapshot: GitSnapshot): Promise<void> {
    if (this._disposed) return;

    const config = vscode.workspace.getConfiguration("contextengine");
    if (!config.get<boolean>("enableNotifications", true)) return;

    if (!snapshot.hasStaleDocProjects) return;

    const now = Date.now();
    if (now - this._lastDocStaleNotificationTime < NotificationManager.DOC_STALE_INTERVAL_MS) {
      return;
    }

    // Build the warning message
    const staleProjects = snapshot.ceDocStatus.filter(
      (s) => s.codeAheadOfDocs || !s.copilotInstructions.exists || !s.skillsMd.exists
    );

    if (staleProjects.length === 0) return;

    const issues: string[] = [];
    for (const s of staleProjects) {
      if (!s.copilotInstructions.exists) {
        issues.push(`${s.project}: missing copilot-instructions.md`);
      } else if (!s.skillsMd.exists) {
        issues.push(`${s.project}: missing SKILLS.md`);
      } else if (s.codeAheadOfDocs) {
        issues.push(`${s.project}: code committed after CE docs`);
      }
    }

    const summary = issues.length <= 2
      ? issues.join(", ")
      : `${issues.length} projects have stale CE docs`;

    const action = await vscode.window.showWarningMessage(
      `📝 OpsContext: ${summary}`,
      "Run Sync",
      "Show Details",
      "Dismiss"
    );

    if (action === "Run Sync") {
      await vscode.commands.executeCommand("contextengine.sync");
    } else if (action === "Show Details") {
      await vscode.commands.executeCommand("contextengine.showStatus");
    }

    this._lastDocStaleNotificationTime = now;
  }

  /**
   * Show a drift alert notification — surfaces a `drift.detected` audit-log
   * record to the user via the appropriate VS Code dialog tier:
   *   - severity: "info"     → status-bar-style info popup
   *   - severity: "warn"     → non-modal warning popup
   *   - severity: "critical" → MODAL warning (OS-level interrupt)
   *
   * Gated by `contextengine.enableNotifications` (master switch) AND
   * `contextengine.enableDriftAlerts` (drift-specific opt-out). Actions:
   *   - "Show Audit Log"  → opens the drift-filtered audit log
   *   - "Mute this kind"  → adds the kind to the poller's mute list
   *   - "Dismiss"         → close (default)
   */
  async showDriftAlert(
    rec: DriftAuditRecord,
    opts: { onMuteKind: (k: DriftKind) => void }
  ): Promise<void> {
    if (this._disposed) return;

    const config = vscode.workspace.getConfiguration("contextengine");
    if (!config.get<boolean>("enableNotifications", true)) return;
    if (!config.get<boolean>("enableDriftAlerts", true)) return;

    const { kind, severity, reason } = rec.payload;
    const title = `OpsContext drift [${kind}]: ${reason}`;
    const showAuditLog = "Show Audit Log";
    const muteKind = "Mute this kind";
    const dismiss = "Dismiss";
    const actions = [showAuditLog, muteKind, dismiss];

    let action: string | undefined;
    if (severity === "critical") {
      action = await vscode.window.showWarningMessage(
        title,
        { modal: true },
        ...actions
      );
    } else if (severity === "warn") {
      action = await vscode.window.showWarningMessage(title, ...actions);
    } else {
      action = await vscode.window.showInformationMessage(title, ...actions);
    }

    if (action === showAuditLog) {
      await vscode.commands.executeCommand("contextengine.showDriftLog");
    } else if (action === muteKind) {
      opts.onMuteKind(kind);
    }
  }

  /**
   * Show a session reminder notification.
   */
  async showSessionReminder(message: string): Promise<void> {
    if (this._disposed) return;

    const config = vscode.workspace.getConfiguration("contextengine");
    if (!config.get<boolean>("enableNotifications", true)) return;

    const action = await vscode.window.showInformationMessage(
      `$(shield) OpsContext: ${message}`,
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

/**
 * Git Monitor — periodic scanning of workspace git repositories.
 *
 * Runs on a configurable interval (default 120s) and tracks:
 *  - Number of uncommitted files per project
 *  - Time since last commit
 *  - Whether any project exceeds the dirty-file threshold
 *
 * Emits events that other modules (status bar, notifications, chat) consume.
 *
 * @module gitMonitor
 */

import * as vscode from "vscode";
import { scanGitStatus, type GitProject } from "./contextEngineClient";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitSnapshot {
  projects: GitProject[];
  totalDirty: number;
  dirtyProjects: GitProject[];
  timestamp: number;
}

type GitSnapshotListener = (snapshot: GitSnapshot) => void;

// ---------------------------------------------------------------------------
// Git Monitor
// ---------------------------------------------------------------------------

export class GitMonitor implements vscode.Disposable {
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _listeners: GitSnapshotListener[] = [];
  private _lastSnapshot: GitSnapshot | undefined;
  private _disposed = false;

  /** Most recent snapshot (may be undefined before first scan). */
  get lastSnapshot(): GitSnapshot | undefined {
    return this._lastSnapshot;
  }

  /**
   * Start the periodic git monitor.
   * @param intervalMs — scan interval in milliseconds (default from config)
   */
  start(intervalMs?: number): void {
    if (this._disposed) return;

    const config = vscode.workspace.getConfiguration("contextengine");
    const seconds = config.get<number>("gitCheckInterval", 120);
    const interval = intervalMs ?? seconds * 1000;

    // Run immediately on start
    void this._scan();

    // Then on interval
    this._timer = setInterval(() => {
      void this._scan();
    }, interval);
  }

  /** Stop the periodic scanner. */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  /** Register a listener for snapshot updates. */
  onSnapshot(listener: GitSnapshotListener): vscode.Disposable {
    this._listeners.push(listener);
    return new vscode.Disposable(() => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    });
  }

  /** Force an immediate scan (e.g., after a commit). */
  async forceScan(): Promise<GitSnapshot> {
    return this._scan();
  }

  dispose(): void {
    this._disposed = true;
    this.stop();
    this._listeners = [];
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async _scan(): Promise<GitSnapshot> {
    try {
      const projects = await scanGitStatus();
      const totalDirty = projects.reduce((sum, p) => sum + p.dirty, 0);
      const dirtyProjects = projects.filter((p) => p.dirty > 0);

      const snapshot: GitSnapshot = {
        projects,
        totalDirty,
        dirtyProjects,
        timestamp: Date.now(),
      };

      this._lastSnapshot = snapshot;
      this._notifyListeners(snapshot);
      return snapshot;
    } catch (error) {
      // Return empty snapshot on error
      const empty: GitSnapshot = {
        projects: [],
        totalDirty: 0,
        dirtyProjects: [],
        timestamp: Date.now(),
      };
      this._lastSnapshot = empty;
      return empty;
    }
  }

  private _notifyListeners(snapshot: GitSnapshot): void {
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch {
        // Don't let one bad listener kill the monitor
      }
    }
  }
}

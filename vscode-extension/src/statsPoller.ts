/**
 * Stats Poller — reads live session stats from the MCP server.
 *
 * The MCP server writes `~/.contextengine/session-stats.json` during active
 * sessions. This module polls that file and exposes the data to the status
 * bar and info panel.
 *
 * @module statsPoller
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionStats {
  pid: number;
  startedAt: string;
  updatedAt: string;
  toolCalls: number;
  learningsSaved: number;
  sessionSaved: boolean;
  uptimeMinutes: number;
  nudgesIssued: number;
  searchRecalls: number;
  truncations: number;
  timeSavedMinutes: number;
}

const EMPTY_STATS: SessionStats = {
  pid: 0,
  startedAt: "",
  updatedAt: "",
  toolCalls: 0,
  learningsSaved: 0,
  sessionSaved: false,
  uptimeMinutes: 0,
  nudgesIssued: 0,
  searchRecalls: 0,
  truncations: 0,
  timeSavedMinutes: 0,
};

// ---------------------------------------------------------------------------
// Stats Poller
// ---------------------------------------------------------------------------

export class StatsPoller implements vscode.Disposable {
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _stats: SessionStats = { ...EMPTY_STATS };
  private _active = false;
  /** Fingerprint of last emitted stats — only fire event on change. */
  private _lastFingerprint = "";

  private readonly _onStats = new vscode.EventEmitter<SessionStats>();
  /** Fires only when stats actually change (not every poll). */
  readonly onStats = this._onStats.event;

  private static readonly STATS_PATH = path.join(
    os.homedir(),
    ".contextengine",
    "session-stats.json"
  );

  /** Current stats snapshot. */
  get stats(): SessionStats {
    return this._stats;
  }

  /** Whether an MCP session appears to be active (stats updated within 5 min). */
  get isActive(): boolean {
    return this._active;
  }

  /**
   * Start polling at the given interval (default: 15s).
   */
  start(intervalMs = 15_000): void {
    this.poll(); // immediate first read
    this._timer = setInterval(() => this.poll(), intervalMs);
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  /**
   * Force an immediate poll.
   */
  poll(): void {
    try {
      if (!fs.existsSync(StatsPoller.STATS_PATH)) {
        this._active = false;
        return;
      }

      const raw = fs.readFileSync(StatsPoller.STATS_PATH, "utf-8");
      const data = JSON.parse(raw) as Partial<SessionStats>;

      this._stats = { ...EMPTY_STATS, ...data };

      // Consider session active if updated within the last 5 minutes
      const updatedAt = new Date(this._stats.updatedAt).getTime();
      const wasActive = this._active;
      this._active = !isNaN(updatedAt) && Date.now() - updatedAt < 5 * 60_000;

      // Only fire event when stats actually change
      const fp = `${this._stats.toolCalls}|${this._stats.searchRecalls}|${this._stats.learningsSaved}|${this._stats.timeSavedMinutes}|${this._active}|${this._stats.nudgesIssued}|${this._stats.truncations}`;
      if (fp !== this._lastFingerprint || this._active !== wasActive) {
        this._lastFingerprint = fp;
        this._onStats.fire(this._stats);
      }
    } catch {
      // File might be mid-write or corrupt — skip this cycle
    }
  }

  dispose(): void {
    this.stop();
    this._onStats.dispose();
  }
}

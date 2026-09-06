/**
 * Fleet Health Poller — reads `~/.contextengine/fleet-health.json`, written once a minute by
 * the indexing MCP server (src/fleet-health.ts, LOCK [HEALTH-IS-MEASURED-NEVER-ESTIMATED]).
 *
 * Same shape as StatsPoller: immediate first poll, then an interval; emits only on change;
 * dispose stops the timer. Every number in the file is counted from the audit log, the server
 * registry or a file on disk. The status bar shows nothing that is not in here or in git.
 *
 * @module fleetHealthPoller
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";

export interface FleetHealth {
  generatedAt: string;
  version: string;
  writerPid: number;
  servers: { total: number; indexers: number; readers: number; stale: Array<{ pid: number; version: string; build: string; cwd: string }>; diskBuild: string | null };
  reindex: { lastHourWrites: number; perCorpus: Record<string, number>; threshold: number };
  today: { blocks: number; refusals: number; learningsSaved: number; lastBlocks: Array<{ ts: string; kind: string; detail: string }> };
  lastVerifiedRelease: string | null;
  warnings: string[];
}

/** Older than this and the file is treated as absent: the writer is gone. */
const STALE_AFTER_MS = 5 * 60_000;

export class FleetHealthPoller implements vscode.Disposable {
  private static readonly PATH = path.join(
    process.env.CONTEXTENGINE_HOME || path.join(os.homedir(), ".contextengine"),
    "fleet-health.json",
  );
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _health: FleetHealth | undefined;
  private _fingerprint = "";
  private readonly _emitter = new vscode.EventEmitter<FleetHealth | undefined>();
  readonly onHealth = this._emitter.event;

  get health(): FleetHealth | undefined { return this._health; }

  start(intervalMs = 15_000): void {
    this.poll();
    this._timer = setInterval(() => this.poll(), intervalMs);
  }

  poll(): void {
    let next: FleetHealth | undefined;
    try {
      const raw = fs.readFileSync(FleetHealthPoller.PATH, "utf-8");
      const parsed = JSON.parse(raw) as FleetHealth;
      const age = Date.now() - Date.parse(parsed.generatedAt);
      next = Number.isNaN(age) || age > STALE_AFTER_MS ? undefined : parsed;
    } catch {
      next = undefined;
    }
    const fp = next ? JSON.stringify(next) : "";
    if (fp === this._fingerprint) return;
    this._fingerprint = fp;
    this._health = next;
    this._emitter.fire(next);
  }

  dispose(): void {
    if (this._timer) clearInterval(this._timer);
    this._timer = undefined;
    this._emitter.dispose();
  }
}

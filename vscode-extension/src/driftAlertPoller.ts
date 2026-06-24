/**
 * Drift Alert Poller — tail the OpsContext hash-chained audit log for
 * `drift.detected` records and surface them through the in-extension UI.
 *
 * Layer story:
 *   L1: `opscontext watch` CLI fires drift signals into ~/.contextengine/audit.log
 *       as `drift.detected` records (src/detector.ts:387).
 *   L2: This poller is the bridge — it tails audit.log on a 15s interval,
 *       parses new `drift.detected` records, dedupes by byte-offset + hash,
 *       throttles per-kind, and forwards survivors to NotificationManager.
 *   L3: NotificationManager.showDriftAlert() routes severity → VS Code UI:
 *       info → info popup, warn → warning popup, critical → modal warning.
 *
 * Mirrors the StatsPoller pattern (timer-driven file read + EventEmitter +
 * Disposable contract). Critical difference: StatsPoller READs a single
 * stat-snapshot JSON file; this poller TAILS an append-only NDJSON log,
 * which means we need a byte-offset cursor (persisted across restarts) +
 * truncation/rotation handling + per-record hash dedup.
 *
 * @module driftAlertPoller
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { NotificationManager } from "./notifications";

// ---------------------------------------------------------------------------
// Types — mirror src/detector.ts unions
//   The extension can't import from the main `src/` tree at build time
//   (different tsconfig, different rootDir), so we duplicate the literal
//   union here. If the union in src/detector.ts ever grows, append to this
//   list — the worst that happens with an unknown kind today is the alert
//   still surfaces via the "info" branch and the kind string is shown as-is.
// ---------------------------------------------------------------------------

export type DriftKind =
  | "loop"
  | "stuck"
  | "context_bloat"
  | "fabrication_suspect"
  | "drift"
  | "no_insight"
  | "stale_doc_signal"
  | "silent_failure";

export type Severity = "info" | "warn" | "critical";

export interface DriftAuditRecord {
  ts: string;
  event: "drift.detected";
  actor: string;
  payload: {
    kind: DriftKind;
    severity: Severity;
    reason: string;
    evidence_count: number;
    [k: string]: unknown;
  };
  prev_hash: string;
  hash: string;
}

/** Optional persistent state — survives VS Code restart so dedup carries. */
interface PersistedState {
  lastOffset?: number;
  mutedKinds?: DriftKind[];
}

// ---------------------------------------------------------------------------
// DriftAlertPoller
// ---------------------------------------------------------------------------

export class DriftAlertPoller implements vscode.Disposable {
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _disposed = false;

  /** Byte-offset cursor — primary dedup mechanism. Persisted across restarts. */
  private _lastOffset = 0;

  /** Per-kind throttle: last-fired ts(ms) per DriftKind. UX-level dedup. */
  private _lastFiredByKind: Map<DriftKind, number> = new Map();

  /** Per-record hash LRU — secondary safety net for fs-watcher races. */
  private _seenHashes = new Set<string>();
  private _seenOrder: string[] = [];
  private static readonly SEEN_CAP = 500;

  /** User-controlled mute list (clicking "Mute this kind" on a popup). */
  private _mutedKinds = new Set<DriftKind>();

  /** Workspace-state-backed persistence (extension memento), optional. */
  private readonly _workspaceState?: vscode.Memento;
  private static readonly STATE_KEY = "contextengine.driftAlertPoller";

  /** Path resolution mirrors src/audit.ts auditDir() exactly. */
  private static readonly CONTEXTENGINE_DIR =
    process.env.CONTEXTENGINE_HOME || path.join(os.homedir(), ".contextengine");
  private static readonly AUDIT_PATH = path.join(
    DriftAlertPoller.CONTEXTENGINE_DIR,
    "audit.log"
  );
  /** Fallback state file (used when no workspaceState supplied). */
  private static readonly STATE_PATH = path.join(
    DriftAlertPoller.CONTEXTENGINE_DIR,
    "vscode-drift-cursor.json"
  );

  /** Per-kind notification throttle (5 min, mirroring NotificationManager). */
  private static readonly KIND_THROTTLE_MS = 5 * 60 * 1000;

  /** EventEmitter for downstream consumers (info panel, future webview). */
  private readonly _onDrift = new vscode.EventEmitter<DriftAuditRecord>();
  readonly onDrift = this._onDrift.event;

  /** Override audit-log path — test seam ONLY. */
  private readonly _auditPathOverride?: string;

  constructor(
    private readonly notifications: NotificationManager,
    private readonly outputChannel: vscode.OutputChannel,
    workspaceState?: vscode.Memento,
    auditPathOverride?: string
  ) {
    this._workspaceState = workspaceState;
    this._auditPathOverride = auditPathOverride;
    this._loadCursor();
  }

  /** Resolve the path we should be tailing — env / override aware. */
  private _auditPath(): string {
    return this._auditPathOverride ?? DriftAlertPoller.AUDIT_PATH;
  }

  /**
   * Start tailing audit.log at the given interval (default: 15s — mirrors
   * StatsPoller). Calling start() twice is a no-op (second call is ignored).
   */
  start(intervalMs = 15_000): void {
    if (this._disposed) return;
    if (this._timer) return;
    this.poll(); // immediate first read
    this._timer = setInterval(() => this.poll(), intervalMs);
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  /**
   * Read any new bytes from audit.log and process every `drift.detected`
   * record. Safe to call manually for tests / forced refresh.
   */
  poll(): void {
    try {
      const auditPath = this._auditPath();
      if (!fs.existsSync(auditPath)) return;
      const stat = fs.statSync(auditPath);

      // Truncation/rotation: file shrank → reset cursor.
      if (stat.size < this._lastOffset) {
        this.outputChannel.appendLine(
          `DriftAlertPoller: audit.log shrank (${stat.size} < ${this._lastOffset}) — resetting cursor`
        );
        this._lastOffset = 0;
      }
      if (stat.size === this._lastOffset) return; // no new bytes

      // Read only the new tail bytes.
      const fd = fs.openSync(auditPath, "r");
      let buf: Buffer;
      try {
        const len = stat.size - this._lastOffset;
        buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, this._lastOffset);
      } finally {
        fs.closeSync(fd);
      }

      const text = buf.toString("utf-8");
      const lastNl = text.lastIndexOf("\n");
      if (lastNl === -1) return; // partial line — wait for next poll

      // Advance cursor to the byte AFTER the last full newline so we never
      // split a record. Use byteLength (not text.length) to handle multi-byte.
      const consumed = text.substring(0, lastNl + 1);
      this._lastOffset += Buffer.byteLength(consumed, "utf-8");

      const lines = consumed.split("\n").filter((l) => l.length > 0);
      for (const line of lines) {
        this._handleLine(line);
      }

      this._saveCursor();
    } catch (err) {
      this.outputChannel.appendLine(
        `DriftAlertPoller: poll error — ${(err as Error).message}`
      );
    }
  }

  dispose(): void {
    this._disposed = true;
    this.stop();
    this._onDrift.dispose();
    // Persist cursor + mute list one last time.
    try {
      this._saveCursor();
    } catch {
      /* best-effort */
    }
  }

  // -----------------------------------------------------------------------
  // private
  // -----------------------------------------------------------------------

  /** Parse + dispatch a single NDJSON line. Silently skips non-drift rows. */
  private _handleLine(line: string): void {
    let rec: DriftAuditRecord | undefined;
    try {
      rec = JSON.parse(line) as DriftAuditRecord;
    } catch {
      return; // partial / corrupt line — next poll cycle will retry tail
    }

    if (!rec || rec.event !== "drift.detected") return;
    if (!rec.payload || typeof rec.payload.kind !== "string") return;
    if (!rec.hash || this._seenHashes.has(rec.hash)) return;

    // Bounded-LRU hash dedup.
    this._seenHashes.add(rec.hash);
    this._seenOrder.push(rec.hash);
    if (this._seenOrder.length > DriftAlertPoller.SEEN_CAP) {
      const evict = this._seenOrder.shift();
      if (evict) this._seenHashes.delete(evict);
    }

    const { kind, severity, reason } = rec.payload;

    if (this._mutedKinds.has(kind)) {
      this.outputChannel.appendLine(
        `DriftAlertPoller: drift suppressed (muted kind=${kind}) — ${reason}`
      );
      return;
    }

    // Per-kind UX throttle. Critical always fires.
    const lastFired = this._lastFiredByKind.get(kind) ?? 0;
    const now = Date.now();
    if (
      severity !== "critical" &&
      now - lastFired < DriftAlertPoller.KIND_THROTTLE_MS
    ) {
      this.outputChannel.appendLine(
        `DriftAlertPoller: drift throttled (kind=${kind}, severity=${severity}) — ${reason}`
      );
      // Still fire the EventEmitter so consumers like the info panel can update.
      this._onDrift.fire(rec);
      return;
    }
    this._lastFiredByKind.set(kind, now);

    this.outputChannel.appendLine(
      `DriftAlertPoller: drift detected — kind=${kind} severity=${severity} — ${reason}`
    );
    this._onDrift.fire(rec);

    // Surface via NotificationManager. Fire-and-forget.
    void this.notifications.showDriftAlert(rec, {
      onMuteKind: (k) => {
        this._mutedKinds.add(k);
        this._saveCursor();
      },
    });
  }

  private _loadCursor(): void {
    // Prefer workspaceState if provided (survives extension reload cleanly).
    if (this._workspaceState) {
      const data =
        this._workspaceState.get<PersistedState>(DriftAlertPoller.STATE_KEY);
      if (data) {
        this._lastOffset = data.lastOffset ?? 0;
        for (const k of data.mutedKinds ?? []) this._mutedKinds.add(k);
        return;
      }
    }
    // Fallback: JSON file at ~/.contextengine/vscode-drift-cursor.json
    try {
      const raw = fs.readFileSync(DriftAlertPoller.STATE_PATH, "utf-8");
      const data = JSON.parse(raw) as PersistedState;
      this._lastOffset = data.lastOffset ?? 0;
      for (const k of data.mutedKinds ?? []) this._mutedKinds.add(k);
    } catch {
      // No prior state — start at offset 0. First poll on a fresh install
      // will fast-forward through every existing record without firing
      // notifications (every record will land in `_seenHashes`).
      this._lastOffset = 0;
    }
  }

  private _saveCursor(): void {
    const data: PersistedState = {
      lastOffset: this._lastOffset,
      mutedKinds: Array.from(this._mutedKinds),
    };
    if (this._workspaceState) {
      void this._workspaceState.update(DriftAlertPoller.STATE_KEY, data);
      return;
    }
    try {
      fs.mkdirSync(DriftAlertPoller.CONTEXTENGINE_DIR, { recursive: true });
      fs.writeFileSync(
        DriftAlertPoller.STATE_PATH,
        JSON.stringify(data),
        "utf-8"
      );
    } catch {
      /* best-effort */
    }
  }
}

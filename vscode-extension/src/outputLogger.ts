/**
 * Output Logger — mirrors OutputChannel content to a log file on disk.
 *
 * VS Code provides no API to read back OutputChannel history. This module
 * wraps a real `vscode.OutputChannel` and mirrors every `appendLine()` call
 * to `~/.contextengine/output.log` with timestamps. Agents in ANY project
 * can then read the log via `read_file` — no copy-paste needed.
 *
 * Features:
 *  - Timestamped lines (ISO 8601)
 *  - Automatic rotation: truncates oldest lines when file exceeds MAX_SIZE
 *  - Session markers: writes a separator on activation so agents can find
 *    the current session boundary
 *  - Graceful failure: if disk write fails, the real OutputChannel still works
 *
 * @module outputLogger
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum log file size before rotation (512 KB). */
const MAX_SIZE_BYTES = 512 * 1024;

/** How much to keep after rotation — tail end (384 KB). */
const KEEP_BYTES = 384 * 1024;

const LOG_DIR = path.join(os.homedir(), ".contextengine");
const LOG_PATH = path.join(LOG_DIR, "output.log");

// ---------------------------------------------------------------------------
// LoggedOutputChannel
// ---------------------------------------------------------------------------

/**
 * Wraps a real VS Code OutputChannel and mirrors writes to disk.
 *
 * Implements the subset of `vscode.OutputChannel` that we actually use:
 * `appendLine`, `append`, `clear`, `show`, `hide`, `dispose`, `name`.
 */
export class LoggedOutputChannel implements vscode.OutputChannel {
  readonly name: string;
  private _channel: vscode.OutputChannel;
  private _fd: number | undefined;
  private _bytesWritten = 0;
  private _writeBuffer: string[] = [];
  private _flushTimer: ReturnType<typeof setTimeout> | undefined;

  /** Debounce interval for flushing writes to disk (ms). */
  private static readonly FLUSH_INTERVAL_MS = 2_000;

  constructor(channel: vscode.OutputChannel) {
    this._channel = channel;
    this.name = channel.name;
    this._ensureDir();
    this._openFile();
    this._writeSessionMarker();
  }

  // -- OutputChannel interface (used methods) --------------------------------

  appendLine(value: string): void {
    this._channel.appendLine(value);
    this._bufferLine(value);
  }

  append(value: string): void {
    this._channel.append(value);
    // For append (no newline), still buffer but don't add timestamp
    this._writeBuffer.push(value);
    this._scheduleFlush();
  }

  clear(): void {
    this._channel.clear();
    // Don't clear the log file — keep history for agent analysis
    this._bufferLine("--- [Output cleared] ---");
  }

  show(preserveFocus?: boolean): void;
  show(column?: unknown, preserveFocus?: boolean): void;
  show(_columnOrPreserve?: unknown, _preserveFocus?: boolean): void {
    if (typeof _columnOrPreserve === "boolean") {
      this._channel.show(_columnOrPreserve);
    } else {
      this._channel.show(_columnOrPreserve as undefined, _preserveFocus);
    }
  }

  hide(): void {
    this._channel.hide();
  }

  replace(value: string): void {
    this._channel.replace(value);
    this._bufferLine(value);
  }

  dispose(): void {
    this._flush();
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = undefined;
    }
    this._closeFile();
    this._channel.dispose();
  }

  // -- File operations -------------------------------------------------------

  /** Get the log file path (for agents to reference). */
  static get logPath(): string {
    return LOG_PATH;
  }

  private _ensureDir(): void {
    try {
      if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
      }
    } catch {
      // Best-effort — dir might already exist
    }
  }

  private _openFile(): void {
    try {
      // Check existing size for rotation tracking
      if (fs.existsSync(LOG_PATH)) {
        const stat = fs.statSync(LOG_PATH);
        this._bytesWritten = stat.size;
      }
      this._fd = fs.openSync(LOG_PATH, "a");
    } catch {
      // Graceful degradation — outputChannel still works without file logging
      this._fd = undefined;
    }
  }

  private _closeFile(): void {
    if (this._fd !== undefined) {
      try {
        fs.closeSync(this._fd);
      } catch {
        // ignore
      }
      this._fd = undefined;
    }
  }

  private _writeSessionMarker(): void {
    const marker = [
      "",
      "════════════════════════════════════════════════════════════════",
      `  ContextEngine Extension Session — ${new Date().toISOString()}`,
      "════════════════════════════════════════════════════════════════",
      "",
    ].join("\n");
    this._writeBuffer.push(marker + "\n");
    this._flush();
  }

  private _bufferLine(value: string): void {
    const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
    this._writeBuffer.push(`[${ts}] ${value}\n`);
    this._scheduleFlush();
  }

  private _scheduleFlush(): void {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = undefined;
      this._flush();
    }, LoggedOutputChannel.FLUSH_INTERVAL_MS);
  }

  private _flush(): void {
    if (this._fd === undefined || this._writeBuffer.length === 0) return;

    const data = this._writeBuffer.join("");
    this._writeBuffer = [];

    try {
      fs.writeSync(this._fd, data);
      this._bytesWritten += Buffer.byteLength(data);

      // Rotate if needed
      if (this._bytesWritten > MAX_SIZE_BYTES) {
        this._rotate();
      }
    } catch {
      // Disk full or other I/O error — silently skip
    }
  }

  /**
   * Rotate the log file: keep the tail (most recent lines).
   * Close fd, read file, truncate to KEEP_BYTES from end, reopen.
   */
  private _rotate(): void {
    this._closeFile();
    try {
      const content = fs.readFileSync(LOG_PATH, "utf-8");
      const bytes = Buffer.byteLength(content);
      if (bytes > MAX_SIZE_BYTES) {
        // Find a newline boundary near the cut point
        const cutPoint = bytes - KEEP_BYTES;
        const cutStr = content.substring(cutPoint);
        const firstNewline = cutStr.indexOf("\n");
        const trimmed = firstNewline >= 0 ? cutStr.substring(firstNewline + 1) : cutStr;

        fs.writeFileSync(LOG_PATH, `[…log rotated — older entries trimmed…]\n${trimmed}`);
        this._bytesWritten = Buffer.byteLength(trimmed) + 50;
      }
    } catch {
      // If rotation fails, just truncate
      try {
        fs.writeFileSync(LOG_PATH, "[…log rotated…]\n");
        this._bytesWritten = 20;
      } catch {
        // give up on rotation
      }
    }
    this._openFile();
  }
}

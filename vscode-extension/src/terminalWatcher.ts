/**
 * Terminal Watcher — monitors terminal command completions.
 *
 * Uses VS Code Shell Integration API (1.93+) to detect when commands
 * finish in any terminal. Surfaces results via:
 *  - Output channel logging
 *  - Notifications for important commands (git, npm, deploy, ssh)
 *  - Git monitor rescan trigger after git operations
 *
 * This is the **event-driven fix** for the "agent goes blind after
 * cancelled terminal commands" problem. Instead of relying on the agent
 * to check `git log` manually, we surface the result proactively.
 *
 * @module terminalWatcher
 */

import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Categories of commands we care about */
type CommandCategory =
  | "git"
  | "npm"
  | "build"
  | "deploy"
  | "test"
  | "ssh"
  | "other";

interface CommandResult {
  command: string;
  category: CommandCategory;
  exitCode: number | undefined;
  timestamp: number;
}

type CommandResultListener = (result: CommandResult) => void;

// ---------------------------------------------------------------------------
// Patterns for command classification
// ---------------------------------------------------------------------------

const COMMAND_PATTERNS: { pattern: RegExp; category: CommandCategory }[] = [
  { pattern: /^git\s/, category: "git" },
  { pattern: /\bgit\s+(commit|push|pull|merge|rebase|checkout|add)\b/, category: "git" },
  { pattern: /^npm\s+(publish|install|run|test)/, category: "npm" },
  { pattern: /^npx\s/, category: "npm" },
  { pattern: /^(tsc|npx tsc|npm run build|npm run compile)/, category: "build" },
  { pattern: /^(vitest|jest|npm test|npx vitest)/, category: "test" },
  { pattern: /\b(sshpass|ssh|rsync|scp|deploy)\b/, category: "deploy" },
  { pattern: /\bpm2\b/, category: "deploy" },
  { pattern: /\bcurl\b.*\b(api|health|contextengine)\b/, category: "deploy" },
];

// Commands that warrant a notification (not just logging)
const NOTIFY_CATEGORIES: CommandCategory[] = [
  "git",
  "npm",
  "deploy",
  "build",
  "test",
];

// ---------------------------------------------------------------------------
// Terminal Watcher
// ---------------------------------------------------------------------------

export class TerminalWatcher implements vscode.Disposable {
  private _disposables: vscode.Disposable[] = [];
  private _listeners: CommandResultListener[] = [];
  private _outputChannel: vscode.OutputChannel;
  private _recentResults: CommandResult[] = [];
  private _disposed = false;

  /** Max recent results to keep */
  private static readonly MAX_RECENT = 50;

  /** Cooldown between notifications for the same category (30s) */
  private static readonly NOTIFY_COOLDOWN_MS = 30_000;
  private _lastNotifyTime: Record<CommandCategory, number> = {
    git: 0,
    npm: 0,
    build: 0,
    deploy: 0,
    test: 0,
    ssh: 0,
    other: 0,
  };

  constructor(outputChannel: vscode.OutputChannel) {
    this._outputChannel = outputChannel;
  }

  /**
   * Start watching terminal command completions.
   */
  start(): void {
    if (this._disposed) return;

    // Watch for command completions
    this._disposables.push(
      vscode.window.onDidEndTerminalShellExecution((event) => {
        void this._onCommandEnd(event);
      })
    );

    this._outputChannel.appendLine(
      "Terminal watcher started — monitoring command completions"
    );
  }

  /** Register a listener for command results (e.g., git monitor rescan). */
  onCommandResult(listener: CommandResultListener): vscode.Disposable {
    this._listeners.push(listener);
    return new vscode.Disposable(() => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    });
  }

  /** Get recent command results. */
  get recentResults(): readonly CommandResult[] {
    return this._recentResults;
  }

  dispose(): void {
    this._disposed = true;
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
    this._listeners = [];
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async _onCommandEnd(
    event: vscode.TerminalShellExecutionEndEvent
  ): Promise<void> {
    const commandLine = event.execution.commandLine?.value || "";
    const exitCode = event.exitCode;

    if (!commandLine.trim()) return;

    // Classify the command
    const category = this._classifyCommand(commandLine);

    const result: CommandResult = {
      command: commandLine,
      category,
      exitCode,
      timestamp: Date.now(),
    };

    // Store in recent results
    this._recentResults.push(result);
    if (this._recentResults.length > TerminalWatcher.MAX_RECENT) {
      this._recentResults.shift();
    }

    // Log to output channel
    const icon = exitCode === 0 ? "✅" : exitCode !== undefined ? "❌" : "⚡";
    const shortCmd =
      commandLine.length > 80
        ? commandLine.substring(0, 77) + "…"
        : commandLine;
    this._outputChannel.appendLine(
      `${icon} [${category}] ${shortCmd} (exit: ${exitCode ?? "?"})`
    );

    // Fire notification for important commands
    if (NOTIFY_CATEGORIES.includes(category)) {
      await this._maybeNotify(result);
    }

    // Notify listeners
    for (const listener of this._listeners) {
      try {
        listener(result);
      } catch {
        // Don't let one bad listener kill the watcher
      }
    }
  }

  private _classifyCommand(commandLine: string): CommandCategory {
    const trimmed = commandLine.trim();
    for (const { pattern, category } of COMMAND_PATTERNS) {
      if (pattern.test(trimmed)) {
        return category;
      }
    }
    return "other";
  }

  private async _maybeNotify(result: CommandResult): Promise<void> {
    const config = vscode.workspace.getConfiguration("contextengine");
    if (!config.get<boolean>("enableNotifications", true)) return;

    // Cooldown check
    const now = Date.now();
    const lastNotify = this._lastNotifyTime[result.category] || 0;
    if (now - lastNotify < TerminalWatcher.NOTIFY_COOLDOWN_MS) return;

    const shortCmd =
      result.command.length > 60
        ? result.command.substring(0, 57) + "…"
        : result.command;

    if (result.exitCode === 0) {
      // Success — brief info for important commands
      if (result.category === "git" || result.category === "npm" || result.category === "deploy") {
        vscode.window.showInformationMessage(
          `$(terminal) ${shortCmd} — completed successfully`
        );
      }
    } else if (result.exitCode !== undefined) {
      // Failure — warning
      const action = await vscode.window.showWarningMessage(
        `$(error) ${shortCmd} — failed (exit ${result.exitCode})`,
        "Show Output",
        "Dismiss"
      );
      if (action === "Show Output") {
        this._outputChannel.show();
      }
    }

    this._lastNotifyTime[result.category] = now;
  }
}

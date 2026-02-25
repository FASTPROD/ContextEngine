/**
 * Terminal Watcher — monitors terminal command completions.
 *
 * Uses VS Code Shell Integration API (1.93+) to detect when commands
 * finish in any terminal. Surfaces results via:
 *  - Output channel logging (with credential redaction)
 *  - Notifications for important commands (git, npm, deploy, ssh)
 *  - Git monitor rescan trigger after git operations
 *  - Stuck-pattern detection (e.g. repeated exit 130 on git commit)
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
  | "database"
  | "python"
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
  // Git
  { pattern: /^git\s/, category: "git" },
  { pattern: /\bgit\s+(commit|push|pull|merge|rebase|checkout|add|status|log|diff|stash|reset|restore)\b/, category: "git" },
  { pattern: /\b(cp|chmod|cat|ls|rm)\b.*\.git\/(hooks|config)/, category: "git" },
  // Database
  { pattern: /\b(psql|mysql|mongosh|redis-cli|sqlite3)\b/, category: "database" },
  { pattern: /\bPGPASSWORD\b/, category: "database" },
  { pattern: /\bmigrate/, category: "database" },
  // Python
  { pattern: /^(python3?|pip3?|pytest|poetry|pdm)\s/, category: "python" },
  { pattern: /\bpython3?\s+-[cm]\b/, category: "python" },
  { pattern: /\bsource\s+\.venv/, category: "python" },
  // Test
  { pattern: /^(vitest|jest|npm test|npx vitest|pytest|python -m pytest)/, category: "test" },
  { pattern: /\bphp\s+artisan\s+test\b/, category: "test" },
  // Build
  { pattern: /^(tsc|npx tsc|npm run build|npm run compile)/, category: "build" },
  { pattern: /\bvite\s+build\b/, category: "build" },
  { pattern: /\bwebpack\b/, category: "build" },
  { pattern: /\breact-scripts\s+build\b/, category: "build" },
  { pattern: /\btsc\s+--noEmit\b/, category: "build" },
  // npm
  { pattern: /^npm\s+(publish|install|run|test|version)/, category: "npm" },
  { pattern: /^npx\s+@vscode\/vsce\b/, category: "npm" },
  { pattern: /^npx\s/, category: "npm" },
  // VS Code
  { pattern: /^code\s+--install-extension\b/, category: "npm" },
  // Deploy / infra
  { pattern: /\b(sshpass|ssh|rsync|scp|deploy)\b/, category: "deploy" },
  { pattern: /\bpm2\b/, category: "deploy" },
  { pattern: /\bcurl\b/, category: "deploy" },
  { pattern: /\bdocker\s+(compose|build|run|exec|push|pull)\b/, category: "deploy" },
  { pattern: /\bwhois\b/, category: "deploy" },
  { pattern: /\bnc\s+-z\b/, category: "deploy" },
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
// Credential redaction patterns
// ---------------------------------------------------------------------------

const REDACT_PATTERNS: { pattern: RegExp; replacement: string }[] = [  // printf '%s' 'password' > file (common sshpass workaround)
  { pattern: /printf\s+['"]%s['"]\s+['"][^'"]{4,}['"]\s*>/gi, replacement: "printf '%s' '***' >" },  // Database passwords: PGPASSWORD='...' or PGPASSWORD=...
  { pattern: /PGPASSWORD=['\"]?[^'"\s]+['\"]?/gi, replacement: "PGPASSWORD=***" },
  // Generic password flags: -p 'password', --password=xxx
  { pattern: /(-p\s+|--password[= ])['\"]?[^'"\s]+['\"]?/gi, replacement: "$1***" },
  // sshpass -p 'xxx'
  { pattern: /sshpass\s+-p\s+['\"]?[^'"\s]+['\"]?/gi, replacement: "sshpass -p ***" },
  // Bearer tokens
  { pattern: /Bearer\s+[A-Za-z0-9._\-]+/gi, replacement: "Bearer ***" },
  // Authorization headers with token value
  { pattern: /Authorization:\s*['\"]?Bearer\s+\$?\{?[A-Za-z0-9._\-]+\}?['\"]?/gi, replacement: "Authorization: Bearer ***" },
  // TOKEN=xxx or $TOKEN inline (only long tokens, not the variable name)
  { pattern: /TOKEN=(['\"]?[A-Za-z0-9._\-]{20,}['\"]?)/gi, replacement: "TOKEN=***" },
  // ENV_API_KEY=value, ENV_SECRET_KEY=value, ENV_SECRET=value (e.g. GROQ_API_KEY=gsk_xxx, STRIPE_SECRET_KEY=sk_xxx)
  { pattern: /[A-Z_]*(?:API_KEY|SECRET_KEY|SECRET|ACCESS_TOKEN|API_SECRET)\s*=\s*['\"]?[^'"\s]{4,}['\"]?/gi, replacement: "***_REDACTED=***" },
  // Known API key prefixes: gsk_, sk-live_, sk-test_, sk-, ghp_, glpat-, xoxb-, xoxp-
  { pattern: /\b(gsk_|sk-live_|sk-test_|sk-|ghp_|glpat-|xoxb-|xoxp-)[A-Za-z0-9_\-]{10,}/gi, replacement: "***" },
  // Connection strings with passwords: ://user:pass@host
  { pattern: /:\/\/([^:]+):([^@]{4,})@/gi, replacement: "://$1:***@" },
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
  private static readonly MAX_RECENT = 100;

  /** Cooldown between notifications for the same category (30s) */
  private static readonly NOTIFY_COOLDOWN_MS = 30_000;
  private _lastNotifyTime: Record<CommandCategory, number> = {
    git: 0,
    npm: 0,
    build: 0,
    deploy: 0,
    test: 0,
    database: 0,
    python: 0,
    ssh: 0,
    other: 0,
  };

  // Track consecutive failures for stuck-pattern detection
  // Key: category + exit code, Value: count + last command
  private _failStreaks: Map<string, { count: number; lastCmd: string; lastTime: number }> = new Map();
  /** How many consecutive same-type failures before alerting */
  private static readonly STUCK_THRESHOLD = 3;
  /** Reset streak if more than 5 min between failures */
  private static readonly STREAK_TIMEOUT_MS = 5 * 60_000;

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

    const trimmed = commandLine.trim();
    if (!trimmed) return;

    // Filter out comment-only lines (shell sends them as commands)
    if (/^#\s/.test(trimmed)) return;

    // Classify the command
    const category = this._classifyCommand(trimmed);

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

    // Log to output channel (with credential redaction)
    const icon = exitCode === 0 ? "✅" : exitCode !== undefined ? "❌" : "⚡";
    const redacted = this._redactCredentials(commandLine);
    const shortCmd =
      redacted.length > 80
        ? redacted.substring(0, 77) + "…"
        : redacted;
    this._outputChannel.appendLine(
      `${icon} [${category}] ${shortCmd} (exit: ${exitCode ?? "?"})`
    );

    // Check for stuck patterns (repeated failures)
    if (exitCode !== undefined && exitCode !== 0) {
      this._trackFailStreak(result);
    } else if (exitCode === 0) {
      // Success resets the streak for this category
      this._resetFailStreak(category);
    }

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

  // -----------------------------------------------------------------------
  // Credential redaction
  // -----------------------------------------------------------------------

  private _redactCredentials(cmd: string): string {
    let redacted = cmd;
    for (const { pattern, replacement } of REDACT_PATTERNS) {
      redacted = redacted.replace(pattern, replacement);
    }
    return redacted;
  }

  // -----------------------------------------------------------------------
  // Stuck-pattern detection
  // -----------------------------------------------------------------------

  /**
   * Track consecutive failures of the same type.
   * If the agent keeps failing on e.g. `git commit` with exit 130,
   * surface a warning after 3 consecutive failures.
   */
  private _trackFailStreak(result: CommandResult): void {
    const key = `${result.category}:${result.exitCode}`;
    const existing = this._failStreaks.get(key);
    const now = Date.now();

    if (existing && now - existing.lastTime < TerminalWatcher.STREAK_TIMEOUT_MS) {
      existing.count++;
      existing.lastCmd = result.command;
      existing.lastTime = now;

      if (existing.count === TerminalWatcher.STUCK_THRESHOLD) {
        this._notifyStuck(result, existing.count);
      } else if (
        existing.count > TerminalWatcher.STUCK_THRESHOLD &&
        existing.count % 5 === 0
      ) {
        // Re-alert every 5 additional failures
        this._notifyStuck(result, existing.count);
      }
    } else {
      this._failStreaks.set(key, { count: 1, lastCmd: result.command, lastTime: now });
    }
  }

  private _resetFailStreak(category: CommandCategory): void {
    // Reset all streaks for this category
    for (const key of this._failStreaks.keys()) {
      if (key.startsWith(`${category}:`)) {
        this._failStreaks.delete(key);
      }
    }
  }

  private _notifyStuck(result: CommandResult, count: number): void {
    const exitName = result.exitCode === 130 ? "SIGINT/cancelled" :
                     result.exitCode === 127 ? "command not found" :
                     result.exitCode === 1   ? "error" :
                     `exit ${result.exitCode}`;

    const msg = `⚠️ Agent appears stuck: ${count}× ${result.category} failures (${exitName})`;
    this._outputChannel.appendLine(`\n🔴 STUCK PATTERN DETECTED: ${msg}`);

    // Specific advice based on the pattern
    let advice = "";
    if (result.category === "git" && result.exitCode === 130) {
      advice = "Pre-commit hook or GPG signing may be blocking non-interactive commits.";
    } else if (result.exitCode === 127) {
      advice = "Command not found — wrong PATH or virtualenv not activated.";
    } else if (result.category === "deploy" && result.exitCode === 130) {
      advice = "SSH connection timing out or requiring interactive auth.";
    }

    if (advice) {
      this._outputChannel.appendLine(`   💡 ${advice}`);
    }

    void vscode.window.showWarningMessage(msg, "Show Output").then((action) => {
      if (action === "Show Output") {
        this._outputChannel.show();
      }
    });
  }
}

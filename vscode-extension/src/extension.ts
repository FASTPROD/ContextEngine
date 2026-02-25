/**
 * ContextEngine — VS Code Extension
 *
 * Persistent memory, enforcement nudges, and session management for AI
 * coding agents. Ensures agents commit code, save context, and follow
 * protocol.
 *
 * This extension is the **proactive enforcement layer** that the MCP server
 * cannot provide alone. MCP is reactive (responds to tool calls). This
 * extension is proactive:
 *   - Monitors git status on a timer
 *   - Shows warnings in the status bar
 *   - Fires notification popups when uncommitted files accumulate
 *   - Provides a @contextengine chat participant for Copilot Chat
 *   - Registers VS Code commands for commit, search, end-session
 *
 * Architecture:
 *   extension.ts         — activation, wiring, command registration
 *   gitMonitor.ts        — periodic git status scanning
 *   statusBar.ts         — persistent status bar indicator
 *   notifications.ts     — warning/info notifications
 *   chatParticipant.ts   — @contextengine in Copilot Chat
 *   contextEngineClient.ts — CLI execution and git operations
 *
 * @module extension
 */

import * as vscode from "vscode";
import { GitMonitor } from "./gitMonitor";
import { StatusBarController } from "./statusBar";
import { NotificationManager } from "./notifications";
import { registerChatParticipant } from "./chatParticipant";
import { InfoStatusBarController, showInfoPanel, updateInfoPanel } from "./infoPanel";
import { TerminalWatcher } from "./terminalWatcher";
import { StatsPoller } from "./statsPoller";
import { LoggedOutputChannel } from "./outputLogger";
import * as client from "./contextEngineClient";

// ---------------------------------------------------------------------------
// Global State
// ---------------------------------------------------------------------------

let gitMonitor: GitMonitor;
let statusBar: StatusBarController;
let infoBar: InfoStatusBarController;
let notifications: NotificationManager;
let terminalWatcher: TerminalWatcher;
let statsPoller: StatsPoller;
const disposables: vscode.Disposable[] = [];

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const rawChannel = vscode.window.createOutputChannel("ContextEngine");
  const outputChannel = new LoggedOutputChannel(rawChannel);
  outputChannel.appendLine(
    `ContextEngine extension activated — ${new Date().toISOString()}`
  );
  outputChannel.appendLine(
    `Output log: ${LoggedOutputChannel.logPath}`
  );

  // -----------------------------------------------------------------------
  // 1. Git Monitor
  // -----------------------------------------------------------------------
  gitMonitor = new GitMonitor();
  disposables.push(gitMonitor);

  // -----------------------------------------------------------------------
  // 2. Status Bar
  // -----------------------------------------------------------------------
  statusBar = new StatusBarController(outputChannel);
  disposables.push(statusBar);

  // Connect git monitor → status bar + info panel (only log on change)
  let lastGitFingerprint = "";
  disposables.push(
    gitMonitor.onSnapshot((snapshot) => {
      const fp = `${snapshot.totalDirty}|${snapshot.projects.length}|${snapshot.dirtyProjects.map(p => `${p.name}:${p.dirty}`).join(",")}`;
      if (fp !== lastGitFingerprint) {
        lastGitFingerprint = fp;
        outputChannel.appendLine(
          `Git scan: ${snapshot.projects.length} projects, ${snapshot.totalDirty} dirty files` +
          (snapshot.dirtyProjects.length > 0
            ? ` (${snapshot.dirtyProjects.map(p => `${p.name}:${p.dirty}`).join(", ")})`
            : "")
        );
      }
      statusBar.update(snapshot);
      updateInfoPanel(snapshot, statsPoller?.stats, statsPoller?.isActive);
    })
  );

  // -----------------------------------------------------------------------
  // 2b. Info Status Bar (ℹ️ icon)
  // -----------------------------------------------------------------------
  infoBar = new InfoStatusBarController();
  disposables.push(infoBar);

  // -----------------------------------------------------------------------
  // 2c. Stats Poller — reads MCP session stats from disk
  // -----------------------------------------------------------------------
  statsPoller = new StatsPoller();
  disposables.push(statsPoller);

  // Connect stats poller → status bar + info panel (only fires on change)
  disposables.push(
    statsPoller.onStats((stats) => {
      outputChannel.appendLine(
        `Stats changed: toolCalls=${stats.toolCalls}, recalls=${stats.searchRecalls}, saved=${stats.learningsSaved}, timeSaved=${stats.timeSavedMinutes}min, active=${statsPoller.isActive}`
      );
      statusBar.updateStats(stats, statsPoller.isActive);
      // Also refresh the info panel if open
      const lastSnapshot = gitMonitor.lastSnapshot;
      if (lastSnapshot) {
        updateInfoPanel(lastSnapshot, stats, statsPoller.isActive);
      }
    })
  );

  // -----------------------------------------------------------------------
  // 3. Notifications
  // -----------------------------------------------------------------------
  notifications = new NotificationManager();
  disposables.push(notifications);

  // Connect git monitor → notifications
  disposables.push(
    gitMonitor.onSnapshot((snapshot) => {
      void notifications.onSnapshot(snapshot);
      void notifications.onDocStaleness(snapshot);
    })
  );

  // -----------------------------------------------------------------------
  // 4. Chat Participant
  // -----------------------------------------------------------------------
  const chatDisposable = registerChatParticipant(gitMonitor);
  disposables.push(chatDisposable);

  // -----------------------------------------------------------------------
  // 4b. Terminal Watcher — monitor command completions
  // -----------------------------------------------------------------------
  terminalWatcher = new TerminalWatcher(outputChannel);
  disposables.push(terminalWatcher);

  // Trigger git rescan after git commands complete
  disposables.push(
    terminalWatcher.onCommandResult((result) => {
      if (result.category === "git" && result.exitCode === 0) {
        // Git command succeeded — rescan to update status bar
        setTimeout(() => void gitMonitor.forceScan(), 1000);
      }
    })
  );

  terminalWatcher.start();

  // -----------------------------------------------------------------------
  // 5. Commands
  // -----------------------------------------------------------------------
  registerCommands(context, outputChannel);

  // -----------------------------------------------------------------------
  // 6. Configuration Change Listener
  // -----------------------------------------------------------------------
  disposables.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("contextengine")) {
        statusBar.refreshConfig();
        infoBar.refreshConfig();

        // Restart git monitor with new interval
        const config = vscode.workspace.getConfiguration("contextengine");
        const seconds = config.get<number>("gitCheckInterval", 120);
        gitMonitor.stop();
        gitMonitor.start(seconds * 1000);

        outputChannel.appendLine(
          `Configuration changed — git check interval: ${seconds}s`
        );
      }
    })
  );

  // -----------------------------------------------------------------------
  // 7. File Save Listener — increment dirty tracking
  // -----------------------------------------------------------------------
  disposables.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      // Trigger a rescan shortly after save (debounced by the monitor)
      // This gives faster feedback than waiting for the next interval
      const debounce = setTimeout(() => {
        void gitMonitor.forceScan();
      }, 2000);

      // Clean up the timeout
      disposables.push(
        new vscode.Disposable(() => clearTimeout(debounce))
      );
    })
  );

  // -----------------------------------------------------------------------
  // 8. Start the Monitor + Stats Poller
  // -----------------------------------------------------------------------
  gitMonitor.start();
  statsPoller.start(15_000); // poll every 15s

  outputChannel.appendLine(`Git monitor started (interval: ${vscode.workspace.getConfiguration("contextengine").get<number>("gitCheckInterval", 120)}s)`);
  outputChannel.appendLine(`Stats poller started (interval: 15s, path: ~/.contextengine/session-stats.json)`);

  // Register all disposables with the context
  for (const d of disposables) {
    context.subscriptions.push(d);
  }
  context.subscriptions.push(outputChannel); // flush log file on deactivate

  outputChannel.appendLine(
    `ContextEngine ready — monitoring ${vscode.workspace.workspaceFolders?.length || 0} workspace folders`
  );
}

// ---------------------------------------------------------------------------
// Deactivation
// ---------------------------------------------------------------------------

export function deactivate(): void {
  for (const d of disposables) {
    d.dispose();
  }
  disposables.length = 0;
}

// ---------------------------------------------------------------------------
// Command Registration
// ---------------------------------------------------------------------------

function registerCommands(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel
): void {
  // -----------------------------------------------------------------------
  // contextengine.commitAll — Stage + commit all dirty projects
  // -----------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("contextengine.commitAll", async () => {
      const snapshot = await gitMonitor.forceScan();

      if (snapshot.totalDirty === 0) {
        vscode.window.showInformationMessage(
          "ContextEngine: All projects are clean — nothing to commit."
        );
        return;
      }

      // Ask for commit message
      const message = await vscode.window.showInputBox({
        prompt: `Commit message for ${snapshot.totalDirty} files across ${snapshot.dirtyProjects.length} project(s)`,
        placeHolder: "chore: session checkpoint",
        value: `chore: session checkpoint — ${snapshot.totalDirty} files`,
      });

      if (!message) return; // User cancelled

      let successCount = 0;
      let failCount = 0;
      const errors: string[] = [];

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "ContextEngine: Committing changes…",
          cancellable: false,
        },
        async (progress) => {
          for (const p of snapshot.dirtyProjects) {
            progress.report({
              message: `${p.name} (${p.dirty} files)`,
              increment: (100 / snapshot.dirtyProjects.length),
            });

            const result = await client.gitCommitAll(p.path, message);
            if (result.success) {
              successCount++;
              outputChannel.appendLine(
                `✅ Committed ${p.dirty} files in ${p.name}`
              );
            } else {
              failCount++;
              errors.push(`${p.name}: ${result.error}`);
              outputChannel.appendLine(
                `❌ Failed to commit ${p.name}: ${result.error}`
              );
            }
          }
        }
      );

      // Show result
      if (failCount === 0) {
        const pushAction = await vscode.window.showInformationMessage(
          `✅ Committed ${snapshot.totalDirty} files across ${successCount} project(s).`,
          "Push All",
          "OK"
        );

        if (pushAction === "Push All") {
          await pushAllProjects(snapshot, outputChannel);
        }
      } else {
        vscode.window.showWarningMessage(
          `⚠️ ${successCount} committed, ${failCount} failed. See Output for details.`
        );
      }

      // Refresh
      await gitMonitor.forceScan();
    })
  );

  // -----------------------------------------------------------------------
  // contextengine.showStatus — Show status in Output channel
  // -----------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("contextengine.showStatus", async () => {
      const snapshot = await gitMonitor.forceScan();

      outputChannel.clear();
      outputChannel.appendLine("═══════════════════════════════════════");
      outputChannel.appendLine("  ContextEngine — Session Status");
      outputChannel.appendLine("═══════════════════════════════════════");
      outputChannel.appendLine("");

      if (snapshot.totalDirty === 0) {
        outputChannel.appendLine("  ✅ All projects clean");
      } else {
        outputChannel.appendLine(
          `  ⚠️ ${snapshot.totalDirty} uncommitted files`
        );
      }
      outputChannel.appendLine("");

      for (const p of snapshot.projects) {
        const icon = p.dirty === 0 ? "✅" : "⚠️";
        outputChannel.appendLine(
          `  ${icon} ${p.name} (${p.branch}) — ${p.dirty} uncommitted`
        );
        if (p.dirty > 0) {
          for (const f of p.uncommittedFiles.slice(0, 10)) {
            outputChannel.appendLine(`      ${f}`);
          }
          if (p.uncommittedFiles.length > 10) {
            outputChannel.appendLine(
              `      …and ${p.uncommittedFiles.length - 10} more`
            );
          }
        }
      }

      outputChannel.appendLine("");
      outputChannel.appendLine("═══════════════════════════════════════");
      outputChannel.show();
    })
  );

  // -----------------------------------------------------------------------
  // contextengine.endSession — Run end-session checklist
  // -----------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("contextengine.endSession", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "ContextEngine: Running end-session checklist…",
          cancellable: false,
        },
        async () => {
          try {
            const checks = await client.endSession();

            outputChannel.clear();
            outputChannel.appendLine("═══════════════════════════════════════");
            outputChannel.appendLine("  ContextEngine — End Session Checklist");
            outputChannel.appendLine("═══════════════════════════════════════");
            outputChannel.appendLine("");

            let passCount = 0;
            let failCount = 0;

            for (const check of checks) {
              const icon = check.status === "PASS" ? "✅" : "❌";
              outputChannel.appendLine(
                `  ${icon} ${check.check}: ${check.detail}`
              );
              if (check.status === "PASS") passCount++;
              else failCount++;
            }

            outputChannel.appendLine("");
            outputChannel.appendLine(
              `  Score: ${passCount}/${checks.length} — ${failCount > 0 ? `${failCount} action(s) required` : "All clear!"}`
            );
            outputChannel.appendLine("");
            outputChannel.appendLine("═══════════════════════════════════════");
            outputChannel.show();

            if (failCount > 0) {
              vscode.window.showWarningMessage(
                `ContextEngine: ${failCount} end-session check${failCount > 1 ? "s" : ""} failed. See Output.`
              );
            } else {
              vscode.window.showInformationMessage(
                "✅ ContextEngine: All end-session checks passed!"
              );
            }
          } catch (error: unknown) {
            const err = error as { message?: string };
            vscode.window.showErrorMessage(
              `ContextEngine: End-session failed — ${err.message || "CLI not available"}`
            );
          }
        }
      );
    })
  );

  // -----------------------------------------------------------------------
  // contextengine.showInfo — Open the info panel WebView
  // -----------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("contextengine.showInfo", async () => {
      const snapshot = await gitMonitor.forceScan();
      statsPoller.poll(); // get latest stats
      showInfoPanel(context, snapshot, statsPoller.stats, statsPoller.isActive);
    })
  );

  // -----------------------------------------------------------------------
  // contextengine.sync — Check CE doc freshness and show actionable report
  // -----------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("contextengine.sync", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "ContextEngine: Checking CE doc freshness…",
          cancellable: false,
        },
        async () => {
          try {
            const docStatuses = await client.checkCEDocFreshness();

            outputChannel.clear();
            outputChannel.appendLine("═══════════════════════════════════════");
            outputChannel.appendLine("  ContextEngine — CE Doc Sync Report");
            outputChannel.appendLine("═══════════════════════════════════════");
            outputChannel.appendLine("");

            let totalIssues = 0;

            for (const status of docStatuses) {
              const problems: string[] = [];

              if (!status.copilotInstructions.exists) {
                problems.push("  ❌ copilot-instructions.md — MISSING");
              } else if (status.copilotInstructions.stale) {
                problems.push(`  ⚠️  copilot-instructions.md — ${status.copilotInstructions.ageHours}h old`);
              }

              if (!status.skillsMd.exists) {
                problems.push("  ❌ SKILLS.md — MISSING");
              } else if (status.skillsMd.stale) {
                problems.push(`  ⚠️  SKILLS.md — ${status.skillsMd.ageHours}h old`);
              }

              if (!status.scoreMd.exists) {
                problems.push("  ❌ SCORE.md — MISSING");
              } else if (status.scoreMd.stale) {
                problems.push(`  ⚠️  SCORE.md — ${status.scoreMd.ageHours}h old`);
              }

              if (status.codeAheadOfDocs) {
                problems.push("  🔴 Code committed AFTER last CE doc update");
              }

              if (problems.length > 0) {
                totalIssues += problems.length;
                outputChannel.appendLine(`⚠️  ${status.project}:`);
                for (const p of problems) {
                  outputChannel.appendLine(p);
                }
              } else {
                outputChannel.appendLine(`✅ ${status.project} — all CE docs fresh`);
              }
              outputChannel.appendLine("");
            }

            outputChannel.appendLine("═══════════════════════════════════════");
            outputChannel.show();

            if (totalIssues > 0) {
              vscode.window.showWarningMessage(
                `ContextEngine: ${totalIssues} CE doc issue(s) found. See Output.`,
                "Open Chat"
              ).then((action) => {
                if (action === "Open Chat") {
                  vscode.commands.executeCommand(
                    "workbench.action.chat.open",
                    { query: "@contextengine /sync" }
                  );
                }
              });
            } else {
              vscode.window.showInformationMessage(
                "✅ ContextEngine: All CE docs are up to date!"
              );
            }
          } catch (error: unknown) {
            const err = error as { message?: string };
            vscode.window.showErrorMessage(
              `ContextEngine: Sync failed — ${err.message || "unknown error"}`
            );
          }
        }
      );
    })
  );

  // -----------------------------------------------------------------------
  // contextengine.search — Search knowledge base (input box)
  // -----------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("contextengine.search", async () => {
      const query = await vscode.window.showInputBox({
        prompt: "Search ContextEngine knowledge base",
        placeHolder: "deployment process, scoring system, security rules…",
      });

      if (!query) return;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `ContextEngine: Searching "${query}"…`,
          cancellable: false,
        },
        async () => {
          try {
            const results = await client.search(query, 5);

            outputChannel.clear();
            outputChannel.appendLine("═══════════════════════════════════════");
            outputChannel.appendLine(
              `  ContextEngine — Search: "${query}"`
            );
            outputChannel.appendLine("═══════════════════════════════════════");
            outputChannel.appendLine("");

            if (results.length === 0) {
              outputChannel.appendLine("  No results found.");
            } else {
              for (let i = 0; i < results.length; i++) {
                const r = results[i];
                outputChannel.appendLine(
                  `  --- Result ${i + 1} (${r.score.toFixed(3)}) ---`
                );
                outputChannel.appendLine(`  Source:  ${r.source}`);
                outputChannel.appendLine(`  Section: ${r.section}`);
                outputChannel.appendLine(`  Lines:   ${r.lines}`);
                outputChannel.appendLine("");
                outputChannel.appendLine(r.content);
                outputChannel.appendLine("");
              }
            }

            outputChannel.appendLine("═══════════════════════════════════════");
            outputChannel.show();
          } catch (error: unknown) {
            const err = error as { message?: string };
            vscode.window.showErrorMessage(
              `ContextEngine: Search failed — ${err.message || "CLI not available"}`
            );
          }
        }
      );
    })
  );
}

// ---------------------------------------------------------------------------
// Push Helper
// ---------------------------------------------------------------------------

async function pushAllProjects(
  snapshot: { dirtyProjects: client.GitProject[] },
  outputChannel: vscode.OutputChannel
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "ContextEngine: Pushing to remotes…",
      cancellable: false,
    },
    async (progress) => {
      // Push all projects (including formerly dirty ones)
      const folders = vscode.workspace.workspaceFolders;
      if (!folders) return;

      for (const folder of folders) {
        progress.report({ message: folder.name });

        const results = await client.gitPush(folder.uri.fsPath);
        for (const r of results) {
          if (r.success) {
            outputChannel.appendLine(
              `✅ Pushed ${folder.name} → ${r.remote}`
            );
          } else {
            outputChannel.appendLine(
              `⚠️ Push failed ${folder.name} → ${r.remote}: ${r.error}`
            );
          }
        }
      }
    }
  );

  vscode.window.showInformationMessage(
    "ContextEngine: Push complete. See Output for details."
  );
}

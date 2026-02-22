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
import * as client from "./contextEngineClient";

// ---------------------------------------------------------------------------
// Global State
// ---------------------------------------------------------------------------

let gitMonitor: GitMonitor;
let statusBar: StatusBarController;
let notifications: NotificationManager;
const disposables: vscode.Disposable[] = [];

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("ContextEngine");
  outputChannel.appendLine(
    `ContextEngine extension activated — ${new Date().toISOString()}`
  );

  // -----------------------------------------------------------------------
  // 1. Git Monitor
  // -----------------------------------------------------------------------
  gitMonitor = new GitMonitor();
  disposables.push(gitMonitor);

  // -----------------------------------------------------------------------
  // 2. Status Bar
  // -----------------------------------------------------------------------
  statusBar = new StatusBarController();
  disposables.push(statusBar);

  // Connect git monitor → status bar
  disposables.push(
    gitMonitor.onSnapshot((snapshot) => {
      statusBar.update(snapshot);
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
    })
  );

  // -----------------------------------------------------------------------
  // 4. Chat Participant
  // -----------------------------------------------------------------------
  const chatDisposable = registerChatParticipant(gitMonitor);
  disposables.push(chatDisposable);

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
  // 8. Start the Monitor
  // -----------------------------------------------------------------------
  gitMonitor.start();

  // Register all disposables with the context
  for (const d of disposables) {
    context.subscriptions.push(d);
  }

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

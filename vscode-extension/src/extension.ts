/**
 * OpsContext — VS Code Extension
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
import { DriftAlertPoller } from "./driftAlertPoller";
import { LoggedOutputChannel } from "./outputLogger";
import { runSetup, runUninstall } from "./setupOrchestrator";
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
let driftAlertPoller: DriftAlertPoller;
const disposables: vscode.Disposable[] = [];

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const rawChannel = vscode.window.createOutputChannel("OpsContext");
  const outputChannel = new LoggedOutputChannel(rawChannel);
  outputChannel.appendLine(
    `OpsContext extension activated — ${new Date().toISOString()}`
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
  // 3b. Drift Alert Poller — tail audit log for `drift.detected` events
  //     L1 (CLI `opscontext watch` → audit.log) → L2 (this poller) → L3
  //     (NotificationManager.showDriftAlert → VS Code UI). Closes the
  //     L2 → in-extension-UI gap from vscode-ext 0.10.
  // -----------------------------------------------------------------------
  driftAlertPoller = new DriftAlertPoller(
    notifications,
    outputChannel,
    context.workspaceState
  );
  disposables.push(driftAlertPoller);

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
  driftAlertPoller.start(15_000); // tail audit.log every 15s

  outputChannel.appendLine(`Git monitor started (interval: ${vscode.workspace.getConfiguration("contextengine").get<number>("gitCheckInterval", 120)}s)`);
  outputChannel.appendLine(`Stats poller started (interval: 15s, path: ~/.contextengine/session-stats.json)`);
  outputChannel.appendLine(`Drift alert poller started (interval: 15s, path: ~/.contextengine/audit.log)`);

  // Register all disposables with the context
  for (const d of disposables) {
    context.subscriptions.push(d);
  }
  context.subscriptions.push(outputChannel); // flush log file on deactivate

  outputChannel.appendLine(
    `OpsContext ready — monitoring ${vscode.workspace.workspaceFolders?.length || 0} workspace folders`
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
      void client.emitEvent("vscode.tool_call", { tool: "contextengine.commitAll", trigger: "command-palette" });
      const snapshot = await gitMonitor.forceScan();

      if (snapshot.totalDirty === 0) {
        vscode.window.showInformationMessage(
          "OpsContext: All projects are clean — nothing to commit."
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
          title: "OpsContext: Committing changes…",
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
      void client.emitEvent("vscode.tool_call", { tool: "contextengine.showStatus", trigger: "command-palette" });
      const snapshot = await gitMonitor.forceScan();

      outputChannel.clear();
      outputChannel.appendLine("═══════════════════════════════════════");
      outputChannel.appendLine("  OpsContext — Session Status");
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
      void client.emitEvent("vscode.tool_call", { tool: "contextengine.endSession", trigger: "command-palette" });
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "OpsContext: Running end-session checklist…",
          cancellable: false,
        },
        async () => {
          try {
            const checks = await client.endSession();

            outputChannel.clear();
            outputChannel.appendLine("═══════════════════════════════════════");
            outputChannel.appendLine("  OpsContext — End Session Checklist");
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
                `OpsContext: ${failCount} end-session check${failCount > 1 ? "s" : ""} failed. See Output.`
              );
            } else {
              vscode.window.showInformationMessage(
                "✅ OpsContext: All end-session checks passed!"
              );
            }
          } catch (error: unknown) {
            const err = error as { message?: string };
            vscode.window.showErrorMessage(
              `OpsContext: End-session failed — ${err.message || "CLI not available"}`
            );
          }
        }
      );
    })
  );

  // -----------------------------------------------------------------------
  // contextengine.showDriftLog — Show drift.detected entries in Output
  // -----------------------------------------------------------------------
  // Wired as the target for the "Show Audit Log" action on the drift alert
  // popup fired by NotificationManager.showDriftAlert(). Functionally
  // identical to contextengine.alertHistory; kept as a distinct command id
  // so the notification action and the palette entry can evolve separately.
  context.subscriptions.push(
    vscode.commands.registerCommand("contextengine.showDriftLog", async () => {
      void client.emitEvent("vscode.tool_call", { tool: "contextengine.showDriftLog", trigger: "notification-action" });
      await showDriftLog(outputChannel);
    })
  );

  // -----------------------------------------------------------------------
  // contextengine.alertHistory — Palette-driven drift history viewer
  // -----------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("contextengine.alertHistory", async () => {
      void client.emitEvent("vscode.tool_call", { tool: "contextengine.alertHistory", trigger: "command-palette" });
      await showDriftLog(outputChannel);
    })
  );

  // -----------------------------------------------------------------------
  // contextengine.showInfo — Open the info panel WebView
  // -----------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("contextengine.showInfo", async () => {
      void client.emitEvent("vscode.tool_call", { tool: "contextengine.showInfo", trigger: "command-palette" });
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
      void client.emitEvent("vscode.tool_call", { tool: "contextengine.sync", trigger: "command-palette" });
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "OpsContext: Checking CE doc freshness…",
          cancellable: false,
        },
        async () => {
          try {
            const docStatuses = await client.checkCEDocFreshness();

            outputChannel.clear();
            outputChannel.appendLine("═══════════════════════════════════════");
            outputChannel.appendLine("  OpsContext — CE Doc Sync Report");
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
                `OpsContext: ${totalIssues} CE doc issue(s) found. See Output.`,
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
                "✅ OpsContext: All CE docs are up to date!"
              );
            }
          } catch (error: unknown) {
            const err = error as { message?: string };
            vscode.window.showErrorMessage(
              `OpsContext: Sync failed — ${err.message || "unknown error"}`
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
      void client.emitEvent("vscode.tool_call", { tool: "contextengine.search", trigger: "command-palette" });
      const query = await vscode.window.showInputBox({
        prompt: "Search OpsContext knowledge base",
        placeHolder: "deployment process, scoring system, security rules…",
      });

      if (!query) return;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `OpsContext: Searching "${query}"…`,
          cancellable: false,
        },
        async () => {
          try {
            const results = await client.search(query, 5);

            outputChannel.clear();
            outputChannel.appendLine("═══════════════════════════════════════");
            outputChannel.appendLine(
              `  OpsContext — Search: "${query}"`
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
              `OpsContext: Search failed — ${err.message || "CLI not available"}`
            );
          }
        }
      );
    })
  );

  // -----------------------------------------------------------------------
  // contextengine.scoreHtml — Generate HTML score report (PRO)
  // -----------------------------------------------------------------------
  // Closes the visible-paid-feature gap: the pricing page advertises
  // "HTML score reports — ✓" for PRO, but before 0.8.1 there was no
  // clickable path to invoke it from the extension. Users had to know to
  // open a terminal and run `contextengine score --html`. Now it's a
  // command palette entry that gates correctly + opens the report.
  context.subscriptions.push(
    vscode.commands.registerCommand("contextengine.scoreHtml", async () => {
      void client.emitEvent("vscode.tool_call", { tool: "contextengine.scoreHtml", trigger: "command-palette" });
      const folders = vscode.workspace.workspaceFolders;
      const defaultProject = folders?.[0]?.name;

      // Pre-flight PRO check so the upgrade flow LEADS instead of trailing
      // a confusing error.
      const isPro = await client.isProActivated();
      if (!isPro) {
        const choice = await vscode.window.showWarningMessage(
          "OpsContext: HTML score reports are a PRO feature. Upgrade to unlock " +
            "Project Health Score (A+ to F), Compliance Audit, Port Conflict " +
            "Detection, Multi-Project Discovery, and HTML reports.",
          "Get a Pro key",
          "Already have a key? Activate",
          "Dismiss",
        );
        if (choice === "Get a Pro key") {
          vscode.env.openExternal(
            vscode.Uri.parse("https://api.compr.ch/contextengine/pricing"),
          );
        } else if (choice === "Already have a key? Activate") {
          // Surface the exact command they need; we don't take the key
          // through the UI because activate writes to ~/.contextengine/
          // and the CLI path is the canonical activation surface.
          vscode.window.showInformationMessage(
            "Run in a terminal: npx @compr/opscontext-mcp activate <key> <email>",
          );
        }
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `OpsContext: Generating HTML score report${defaultProject ? ` for ${defaultProject}` : ""}…`,
          cancellable: true,
        },
        async (_progress, token) => {
          // Wire the progress's cancel button to an AbortController that
          // propagates through runCLI → execFile.signal → SIGKILL on the
          // child. Without this the user has no way to exit a stuck score —
          // the 0.11.1 bug class.
          const abortController = new AbortController();
          token.onCancellationRequested(() => abortController.abort());
          try {
            const path = await client.generateHtmlScoreReport(defaultProject, abortController.signal);
            // The CLI auto-opens the file in the default browser, so we just
            // confirm and surface the path for the user who wants to share it.
            const action = await vscode.window.showInformationMessage(
              `OpsContext: Score report ready → ${path}`,
              "Reveal in Finder",
              "Open file",
            );
            if (action === "Reveal in Finder") {
              vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path));
            } else if (action === "Open file") {
              vscode.env.openExternal(vscode.Uri.file(path));
            }
          } catch (error: unknown) {
            const err = error as { message?: string; name?: string };
            // Silently exit on user cancellation — no error popup. Honors the
            // contract: user clicked the X, user gets nothing in their face.
            if (err.name === "AbortError" || token.isCancellationRequested) {
              return;
            }
            const msg = err.message || "unknown error";
            // Heuristic: if the CLI returned a gate-rejection message that
            // slipped past isProActivated (e.g., expired between probe and
            // call), surface the same upgrade prompt.
            if (/pro|premium|license|activate|signature/i.test(msg)) {
              vscode.window.showWarningMessage(
                `OpsContext: Score report rejected — ${msg}`,
                "Reactivate",
              ).then((choice) => {
                if (choice === "Reactivate") {
                  vscode.env.openExternal(
                    vscode.Uri.parse("https://api.compr.ch/contextengine/pricing"),
                  );
                }
              });
            } else {
              vscode.window.showErrorMessage(
                `OpsContext: Score report failed — ${msg}`,
              );
            }
          }
        },
      );
    }),
  );

  // -----------------------------------------------------------------------
  // contextengine.setup — One-click install for non-tech users.
  // -----------------------------------------------------------------------
  // Refactored 2026-06-24 (audit B2): previously dispatched a single
  // `npm && opscontext && opscontext` chain into a fresh terminal with
  // zero pre-checks, no per-step error capture, and no rollback. That
  // dumped non-tech users at a `$` prompt with red text whenever Node
  // was missing, npm hit EACCES, or a partial re-run tripped over an
  // existing LaunchAgent. The new flow lives in `setupOrchestrator.ts`
  // and runs every step as its own `cp.execFile` with output streaming
  // into a dedicated "OpsContext Setup" output channel.
  //
  // On non-darwin platforms we still surface a friendly modal explaining
  // the LaunchAgent step will be skipped — preserves the prior behaviour
  // contract of "setup at least informs you on Linux/Windows" while
  // letting Mac users (the target persona) get the full happy path.
  //
  // 🔒 LOCKED [B2-SETUP-EXECFILE] — 2026-06-24
  // ⛔ NEVER replace this with a terminal.sendText chain again — that
  //     was the user-trust regression the 2026-06-23 audit flagged as
  //     blocker B2. cp.execFile + OutputChannel is the path.
  // WHY: terminal.sendText has no exit-code visibility, no per-step
  //      progress, no idempotency, and surfaces npm WARN spam that
  //      non-tech users read as "something broke".
  // FIX: route every step through runStep() in setupOrchestrator.ts.
  context.subscriptions.push(
    vscode.commands.registerCommand("contextengine.setup", async () => {
      void client.emitEvent("vscode.tool_call", { tool: "contextengine.setup", trigger: "command-palette" });
      await runSetup(outputChannel);
    }),
  );

  // -----------------------------------------------------------------------
  // contextengine.uninstall — Clean-slate reset.
  // -----------------------------------------------------------------------
  // Added 2026-06-24 (audit B2 follow-up). Users hitting a half-installed
  // state need a single command to wipe the LaunchAgent + Claude hook +
  // npm package so the next `OpsContext: Set up` runs from zero. The old
  // flow had nothing here — users had to know to run `opscontext
  // uninstall-autostart` etc. manually, which is exactly the gap the
  // one-click install was meant to close.
  context.subscriptions.push(
    vscode.commands.registerCommand("contextengine.uninstall", async () => {
      void client.emitEvent("vscode.tool_call", { tool: "contextengine.uninstall", trigger: "command-palette" });
      await runUninstall(outputChannel);
    }),
  );
}

// ---------------------------------------------------------------------------
// Drift Log Helper — read audit.log tail, filter to drift.detected, render
// ---------------------------------------------------------------------------

async function showDriftLog(
  outputChannel: vscode.OutputChannel
): Promise<void> {
  // Inline-imported to avoid a top-level dependency on `fs` from the
  // extension entry point (matches existing pattern — fs is only imported
  // by the modules that need it).
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");

  const auditPath = path.join(
    process.env.CONTEXTENGINE_HOME || path.join(os.homedir(), ".contextengine"),
    "audit.log"
  );

  outputChannel.clear();
  outputChannel.appendLine("═══════════════════════════════════════");
  outputChannel.appendLine("  OpsContext — Drift Alert History");
  outputChannel.appendLine("═══════════════════════════════════════");
  outputChannel.appendLine("");

  if (!fs.existsSync(auditPath)) {
    outputChannel.appendLine(`  (no audit log yet at ${auditPath})`);
    outputChannel.appendLine("");
    outputChannel.appendLine("═══════════════════════════════════════");
    outputChannel.show();
    return;
  }

  const raw = fs.readFileSync(auditPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const drifts: Array<{ ts: string; kind: string; severity: string; reason: string }> = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as {
        ts: string;
        event: string;
        payload: { kind: string; severity: string; reason: string };
      };
      if (rec.event !== "drift.detected") continue;
      drifts.push({
        ts: rec.ts,
        kind: rec.payload.kind,
        severity: rec.payload.severity,
        reason: rec.payload.reason,
      });
    } catch {
      // Skip non-JSON / partial lines.
    }
  }

  if (drifts.length === 0) {
    outputChannel.appendLine("  ✅ No drift events recorded.");
  } else {
    // Show most-recent first, cap to 200 for sanity.
    const recent = drifts.slice(-200).reverse();
    outputChannel.appendLine(`  ${recent.length} drift event(s) (most recent first):`);
    outputChannel.appendLine("");
    for (const d of recent) {
      const icon = d.severity === "critical" ? "🚨" : d.severity === "warn" ? "⚠️" : "ℹ️";
      outputChannel.appendLine(`  ${icon} ${d.ts}  [${d.kind}]  ${d.severity}`);
      outputChannel.appendLine(`     ${d.reason}`);
      outputChannel.appendLine("");
    }
  }

  outputChannel.appendLine("═══════════════════════════════════════");
  outputChannel.show();
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
      title: "OpsContext: Pushing to remotes…",
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
    "OpsContext: Push complete. See Output for details."
  );
}

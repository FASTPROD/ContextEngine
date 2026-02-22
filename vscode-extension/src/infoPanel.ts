/**
 * Info Panel — WebView panel explaining what ContextEngine monitors.
 *
 * Opened by clicking the ℹ️ status bar icon. Educates users (and agents)
 * about the full enforcement protocol — not just git dirty files, but
 * documentation freshness, learnings, sessions, and end-of-session checks.
 *
 * This is the "break the ice" panel that builds trust by showing exactly
 * what ContextEngine does to combat agent memory loss.
 *
 * @module infoPanel
 */

import * as vscode from "vscode";
import { type GitSnapshot } from "./gitMonitor";

// ---------------------------------------------------------------------------
// Info Status Bar Item — the ℹ️ icon next to the main CE indicator
// ---------------------------------------------------------------------------

export class InfoStatusBarController implements vscode.Disposable {
  private _item: vscode.StatusBarItem;

  constructor() {
    this._item = vscode.window.createStatusBarItem(
      "contextengine.info",
      vscode.StatusBarAlignment.Left,
      49 // just after the main CE status bar item (priority 50)
    );

    this._item.text = "$(info)";
    this._item.tooltip = "ContextEngine — What do we check?";
    this._item.command = "contextengine.showInfo";
    this._item.name = "ContextEngine Info";

    const config = vscode.workspace.getConfiguration("contextengine");
    if (config.get<boolean>("enableStatusBar", true)) {
      this._item.show();
    }
  }

  refreshConfig(): void {
    const config = vscode.workspace.getConfiguration("contextengine");
    if (config.get<boolean>("enableStatusBar", true)) {
      this._item.show();
    } else {
      this._item.hide();
    }
  }

  dispose(): void {
    this._item.dispose();
  }
}

// ---------------------------------------------------------------------------
// Info Panel WebView
// ---------------------------------------------------------------------------

let currentPanel: vscode.WebviewPanel | undefined;

export function showInfoPanel(
  context: vscode.ExtensionContext,
  snapshot?: GitSnapshot
): void {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    if (snapshot) {
      currentPanel.webview.html = getInfoHtml(snapshot);
    }
    return;
  }

  currentPanel = vscode.window.createWebviewPanel(
    "contextengine.info",
    "ContextEngine — What We Check",
    vscode.ViewColumn.One,
    { enableScripts: false }
  );

  currentPanel.webview.html = getInfoHtml(snapshot);

  currentPanel.onDidDispose(() => {
    currentPanel = undefined;
  });
}

export function updateInfoPanel(snapshot: GitSnapshot): void {
  if (currentPanel) {
    currentPanel.webview.html = getInfoHtml(snapshot);
  }
}

// ---------------------------------------------------------------------------
// HTML Content
// ---------------------------------------------------------------------------

function getInfoHtml(snapshot?: GitSnapshot): string {
  const totalDirty = snapshot?.totalDirty ?? 0;
  const projects = snapshot?.projects ?? [];

  // Build live status rows
  let statusRows = "";
  for (const p of projects) {
    const icon = p.dirty === 0 ? "✅" : "⚠️";
    const cls = p.dirty === 0 ? "clean" : "dirty";
    statusRows += `
      <tr class="${cls}">
        <td>${icon} ${escHtml(p.name)}</td>
        <td><code>${escHtml(p.branch)}</code></td>
        <td>${p.dirty}</td>
      </tr>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ContextEngine — What We Check</title>
  <style>
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 24px 32px;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
    }
    h1 { color: var(--vscode-textLink-foreground); font-size: 1.6em; margin-bottom: 4px; }
    h2 { color: var(--vscode-textLink-foreground); font-size: 1.2em; margin-top: 28px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 4px; }
    .subtitle { color: var(--vscode-descriptionForeground); font-size: 0.95em; margin-bottom: 20px; }
    .card {
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.04));
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      padding: 16px 20px;
      margin: 12px 0;
    }
    table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    th { text-align: left; padding: 6px 12px; border-bottom: 2px solid var(--vscode-widget-border); font-size: 0.85em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
    td { padding: 6px 12px; border-bottom: 1px solid var(--vscode-widget-border); }
    tr.dirty td { color: var(--vscode-errorForeground); }
    tr.clean td { color: var(--vscode-testing-iconPassed, #4caf50); }
    code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
    .check-item { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--vscode-widget-border); }
    .check-item:last-child { border-bottom: none; }
    .check-icon { font-size: 1.3em; flex-shrink: 0; }
    .check-label { font-weight: 600; }
    .check-desc { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 0.8em;
      font-weight: 600;
    }
    .badge-free { background: #2ea04370; color: #4caf50; }
    .badge-pro { background: #e6a81770; color: #ffc107; }
    .hero { text-align: center; padding: 16px 0; }
    .hero-stat { font-size: 2.5em; font-weight: 700; }
    .hero-clean { color: var(--vscode-testing-iconPassed, #4caf50); }
    .hero-dirty { color: var(--vscode-errorForeground, #f44336); }
    a { color: var(--vscode-textLink-foreground); }
  </style>
</head>
<body>

  <h1>🛡️ ContextEngine</h1>
  <p class="subtitle">
    Below is the list of what we check and do to support the memory loss of your AI agents.
  </p>

  <!-- Live Status -->
  <div class="hero">
    <div class="hero-stat ${totalDirty === 0 ? "hero-clean" : "hero-dirty"}">
      ${totalDirty === 0 ? "✅ All Clean" : `⚠️ ${totalDirty} Uncommitted`}
    </div>
  </div>

  ${
    projects.length > 0
      ? `
  <div class="card">
    <table>
      <thead>
        <tr><th>Project</th><th>Branch</th><th>Dirty Files</th></tr>
      </thead>
      <tbody>${statusRows}</tbody>
    </table>
  </div>`
      : ""
  }

  <!-- What We Check -->
  <h2>📋 What ContextEngine Monitors</h2>

  <div class="card">
    <div class="check-item">
      <span class="check-icon">📂</span>
      <div>
        <div class="check-label">Uncommitted Git Changes <span class="badge badge-free">FREE</span></div>
        <div class="check-desc">
          Scans all workspace repos every 2 minutes. Warns when files accumulate without commits.
          Escalates from yellow → red → popup notifications. Agents see this and act.
        </div>
      </div>
    </div>

    <div class="check-item">
      <span class="check-icon">📝</span>
      <div>
        <div class="check-label">Documentation Freshness <span class="badge badge-free">FREE</span></div>
        <div class="check-desc">
          Checks if <code>copilot-instructions.md</code>, <code>SKILLS.md</code>, and
          <code>CLAUDE.md</code> were updated in the current session. Stale docs = agents
          lose context next session.
        </div>
      </div>
    </div>

    <div class="check-item">
      <span class="check-icon">🧠</span>
      <div>
        <div class="check-label">Learnings Saved <span class="badge badge-free">FREE</span></div>
        <div class="check-desc">
          Tracks whether the agent called <code>save_learning</code> during the session.
          Every reusable pattern, fix, or discovery should be saved as a permanent learning
          so future agents don't repeat mistakes.
        </div>
      </div>
    </div>

    <div class="check-item">
      <span class="check-icon">💾</span>
      <div>
        <div class="check-label">Session Context Saved <span class="badge badge-free">FREE</span></div>
        <div class="check-desc">
          Checks if the agent called <code>save_session</code> to persist decisions, progress,
          and active tasks. Without this, the next session starts from scratch.
        </div>
      </div>
    </div>

    <div class="check-item">
      <span class="check-icon">🚀</span>
      <div>
        <div class="check-label">Git Push to Remotes <span class="badge badge-free">FREE</span></div>
        <div class="check-desc">
          Verifies that commits are pushed to all configured remotes (origin, gdrive, etc.).
          Committed but unpushed work is still at risk.
        </div>
      </div>
    </div>

    <div class="check-item">
      <span class="check-icon">📊</span>
      <div>
        <div class="check-label">Project Health Score <span class="badge badge-pro">PRO</span></div>
        <div class="check-desc">
          Scores your project on AI-readiness (0-100%): documentation quality,
          infrastructure setup, code quality, and security posture. Letter grade A+ to F.
        </div>
      </div>
    </div>

    <div class="check-item">
      <span class="check-icon">🔍</span>
      <div>
        <div class="check-label">Compliance Audit <span class="badge badge-pro">PRO</span></div>
        <div class="check-desc">
          Checks port conflicts, git hooks, .env files, Docker config, PM2 setup,
          EOL runtimes, outdated deps — everything an agent might misconfigure.
        </div>
      </div>
    </div>
  </div>

  <!-- End-of-Session Protocol -->
  <h2>🏁 End-of-Session Protocol</h2>
  <p>
    Before ending ANY coding session, the agent <strong>MUST</strong> complete this checklist.
    The extension enforces it with escalating reminders:
  </p>

  <div class="card">
    <div class="check-item">
      <span class="check-icon">1️⃣</span>
      <div>
        <div class="check-label">Update <code>copilot-instructions.md</code></div>
        <div class="check-desc">Add new facts, architecture changes, decisions from this session</div>
      </div>
    </div>
    <div class="check-item">
      <span class="check-icon">2️⃣</span>
      <div>
        <div class="check-label">Update <code>SKILLS.md</code></div>
        <div class="check-desc">Document new capabilities the agent demonstrated</div>
      </div>
    </div>
    <div class="check-item">
      <span class="check-icon">3️⃣</span>
      <div>
        <div class="check-label">Save learnings</div>
        <div class="check-desc">Call <code>save_learning</code> for every reusable pattern or fix</div>
      </div>
    </div>
    <div class="check-item">
      <span class="check-icon">4️⃣</span>
      <div>
        <div class="check-label">Commit with descriptive message</div>
        <div class="check-desc">Not "fix stuff" — real commit messages that future agents can search</div>
      </div>
    </div>
    <div class="check-item">
      <span class="check-icon">5️⃣</span>
      <div>
        <div class="check-label">Push to all remotes</div>
        <div class="check-desc">origin (GitHub) + backup remotes (gdrive, etc.)</div>
      </div>
    </div>
    <div class="check-item">
      <span class="check-icon">6️⃣</span>
      <div>
        <div class="check-label">Save session</div>
        <div class="check-desc">Persist decisions, progress, and blockers for the next agent</div>
      </div>
    </div>
  </div>

  <!-- How It Works -->
  <h2>⚙️ How It Works</h2>
  <div class="card">
    <p><strong>MCP Server</strong> (reactive) — agents call tools like <code>search_context</code>,
    <code>save_learning</code>, <code>save_session</code>. The server nudges when agents go
    15+ tool calls without saving.</p>

    <p><strong>VS Code Extension</strong> (proactive) — monitors git status on a timer,
    shows the status bar indicator, fires notification popups, provides
    <code>@contextengine</code> in Copilot Chat. This is what you're looking at.</p>

    <p><strong>Together</strong> — the MCP server provides the knowledge base and persistence,
    the extension provides the visibility and enforcement. Agents can't ignore what's
    always visible in the status bar.</p>
  </div>

  <p style="text-align: center; margin-top: 24px; color: var(--vscode-descriptionForeground);">
    ContextEngine v0.2.0 · <a href="https://marketplace.visualstudio.com/items?itemName=css-llc.contextengine">Marketplace</a>
    · <a href="https://github.com/FASTPROD/ContextEngine">GitHub</a>
    · <a href="https://www.npmjs.com/package/@compr/contextengine-mcp">npm</a>
  </p>

</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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
    { enableScripts: true }
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ContextEngine — Agent Memory &amp; Compliance</title>
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
    .badge-pro { background: #e6a81770; color: #ffc107; cursor: pointer; text-decoration: none; }
    .badge-pro:hover { background: #e6a817a0; }
    a { color: var(--vscode-textLink-foreground); }
    .firewall-hero {
      text-align: center;
      padding: 20px;
      margin: 8px 0 20px;
      background: linear-gradient(135deg, rgba(76,175,80,0.08), rgba(33,150,243,0.06));
      border: 1px solid var(--vscode-widget-border);
      border-radius: 8px;
    }
    .firewall-hero .shield { font-size: 3em; }
    .firewall-title { font-size: 1.4em; font-weight: 700; margin: 8px 0 4px; }
    .firewall-status { font-size: 0.95em; color: var(--vscode-testing-iconPassed, #4caf50); }
    .analogy-box {
      background: linear-gradient(135deg, rgba(33,150,243,0.06), rgba(33,150,243,0.02));
      border: 1px solid var(--vscode-widget-border);
      border-radius: 8px;
      padding: 16px 20px;
      margin: 12px 0;
    }
    .analogy-box p { margin: 8px 0; }
    .analogy-box strong { color: var(--vscode-textLink-foreground); }
    .step-flow {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin: 16px 0;
      flex-wrap: wrap;
    }
    .step-pill {
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 0.85em;
      font-weight: 600;
    }
    .step-green { background: #2ea04340; color: #4caf50; }
    .step-yellow { background: #ffc10740; color: #ffc107; }
    .step-orange { background: #ff980040; color: #ff9800; }
    .step-red { background: #f4433640; color: #f44336; }
    .step-arrow { color: var(--vscode-descriptionForeground); font-size: 1.2em; }
    .mini-status {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.85em;
      font-weight: 600;
    }
    .mini-clean { background: #2ea04330; color: #4caf50; }
    .mini-dirty { background: #f4433630; color: #f44336; }
    .cta-box {
      text-align: center;
      padding: 20px;
      margin: 16px 0;
      background: linear-gradient(135deg, rgba(255,193,7,0.08), rgba(255,193,7,0.02));
      border: 1px solid #ffc10740;
      border-radius: 8px;
    }
    .cta-button {
      display: inline-block;
      padding: 10px 28px;
      background: #ffc107;
      color: #000;
      font-weight: 700;
      font-size: 1em;
      border-radius: 6px;
      text-decoration: none;
      margin-top: 8px;
    }
    .cta-button:hover { background: #ffca28; }
    .cta-subtitle { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 6px; }
  </style>
</head>
<body>

  <h1>🛡️ ContextEngine</h1>
  <p class="subtitle">
    Persistent memory and compliance enforcement for AI coding agents.
    <br>What VS Code doesn't do — we do.
  </p>

  <!-- ======================================================== -->
  <!-- HERO: Protocol Firewall                                   -->
  <!-- ======================================================== -->
  <div class="firewall-hero">
    <div class="shield">🛡️</div>
    <div class="firewall-title">Protocol Firewall</div>
    <div class="firewall-status">Active on all 17 MCP tools</div>
  </div>

  <!-- ======================================================== -->
  <!-- PLAIN-ENGLISH EXPLANATION                                 -->
  <!-- ======================================================== -->
  <h2>🤔 What is the Protocol Firewall?</h2>

  <div class="analogy-box">
    <p>
      Think of it like a <strong>speed camera for your AI agent</strong>.
    </p>
    <p>
      When you hire a real developer, they naturally remember lessons, save their work,
      and document what they did. AI agents don't — they <strong>forget everything</strong>
      the moment the conversation ends.
    </p>
    <p>
      The Protocol Firewall <strong>watches what the agent does</strong> during a session.
      If the agent isn't saving learnings, isn't committing code, isn't updating documentation —
      the firewall <strong>progressively reduces the quality of answers</strong> the agent gets back.
    </p>
    <p>
      First a gentle reminder. Then a visible warning. Then it actually
      <strong>cuts the data short</strong>, making it impossible for the agent to work
      effectively without doing the housekeeping first.
    </p>
    <p>
      <strong>Why this works:</strong> Rules in documents can be ignored. Extension notifications
      can be dismissed. But an agent can't ignore getting truncated data from its own tools.
      It's the only mechanism that truly makes AI agents comply.
    </p>
  </div>

  <div style="text-align: center; margin: 16px 0;">
    <div class="step-flow">
      <span class="step-pill step-green">✅ Silent</span>
      <span class="step-arrow">→</span>
      <span class="step-pill step-yellow">📝 Footer reminder</span>
      <span class="step-arrow">→</span>
      <span class="step-pill step-orange">⚠️ Header warning</span>
      <span class="step-arrow">→</span>
      <span class="step-pill step-red">🚫 Data truncated</span>
    </div>
    <div style="color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 4px;">
      Escalation resets when the agent does the right thing (saves learnings, commits, etc.)
    </div>
  </div>

  <!-- ======================================================== -->
  <!-- WHAT CE UNIQUELY PROVIDES (not in VS Code natively)       -->
  <!-- ======================================================== -->
  <h2>🧠 What ContextEngine Does (that VS Code Doesn't)</h2>

  <div class="card">
    <div class="check-item">
      <span class="check-icon">🛡️</span>
      <div>
        <div class="check-label">Protocol Firewall <span class="badge badge-free">FREE</span></div>
        <div class="check-desc">
          Wraps every tool response. Monitors 4 obligations: learnings saved, session saved,
          git committed, docs updated. Escalates enforcement automatically.
        </div>
      </div>
    </div>

    <div class="check-item">
      <span class="check-icon">🧠</span>
      <div>
        <div class="check-label">Persistent Memory (Learnings) <span class="badge badge-free">FREE</span></div>
        <div class="check-desc">
          Agents discover patterns, fixes, and rules — these are saved permanently and
          auto-surface in future sessions. Your agent never makes the same mistake twice.
        </div>
      </div>
    </div>

    <div class="check-item">
      <span class="check-icon">💾</span>
      <div>
        <div class="check-label">Session Continuity <span class="badge badge-free">FREE</span></div>
        <div class="check-desc">
          Decisions, progress, and blockers are saved between conversations.
          The next agent picks up exactly where the last one left off.
        </div>
      </div>
    </div>

    <div class="check-item">
      <span class="check-icon">🔍</span>
      <div>
        <div class="check-label">Knowledge Search <span class="badge badge-free">FREE</span></div>
        <div class="check-desc">
          Hybrid keyword + AI-powered search across all your project docs, learnings,
          git history, and operational data. One query, all context.
        </div>
      </div>
    </div>

    <div class="check-item">
      <span class="check-icon">📝</span>
      <div>
        <div class="check-label">Documentation Freshness <span class="badge badge-free">FREE</span></div>
        <div class="check-desc">
          Detects when code was committed but <code>copilot-instructions.md</code>,
          <code>SKILLS.md</code>, or <code>CLAUDE.md</code> weren't updated.
          Stale docs = agents lose context next session.
        </div>
      </div>
    </div>

    <div class="check-item">
      <span class="check-icon">📊</span>
      <div>
        <div class="check-label">Project Health Score <a href="https://api.compr.ch/contextengine/pricing" class="badge badge-pro">PRO</a></div>
        <div class="check-desc">
          AI-readiness score (0-100%): documentation, infrastructure, code quality,
          and security. Know exactly what to improve for better agent performance.
        </div>
      </div>
    </div>

    <div class="check-item">
      <span class="check-icon">🔎</span>
      <div>
        <div class="check-label">Compliance Audit <a href="https://api.compr.ch/contextengine/pricing" class="badge badge-pro">PRO</a></div>
        <div class="check-desc">
          Checks port conflicts, git hooks, .env files, Docker config, PM2 setup,
          EOL runtimes, outdated deps — across all your projects at once.
        </div>
      </div>
    </div>
  </div>

  <!-- ======================================================== -->
  <!-- GIT STATUS — compact, secondary                           -->
  <!-- ======================================================== -->
  <h2>📂 Git Status</h2>
  <div class="card" style="text-align: center; padding: 12px 20px;">
    <span class="mini-status ${totalDirty === 0 ? "mini-clean" : "mini-dirty"}">
      ${totalDirty === 0 ? "✅ All clean" : `⚠️ ${totalDirty} uncommitted`}
    </span>
    <span style="color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-left: 8px;">
      See VS Code Source Control panel for details
    </span>
  </div>

  <!-- ======================================================== -->
  <!-- END-OF-SESSION PROTOCOL                                   -->
  <!-- ======================================================== -->
  <h2>🏁 What the Agent Must Do Before Ending</h2>
  <p style="color: var(--vscode-descriptionForeground); font-size: 0.9em;">
    The Protocol Firewall enforces this automatically — no need to remind the agent yourself.
  </p>

  <div class="card">
    <div class="check-item">
      <span class="check-icon">1️⃣</span>
      <div>
        <div class="check-label">Save learnings</div>
        <div class="check-desc">Every reusable pattern or fix becomes permanent memory for future agents</div>
      </div>
    </div>
    <div class="check-item">
      <span class="check-icon">2️⃣</span>
      <div>
        <div class="check-label">Update documentation</div>
        <div class="check-desc"><code>copilot-instructions.md</code> and <code>SKILLS.md</code> — so the next agent has full context</div>
      </div>
    </div>
    <div class="check-item">
      <span class="check-icon">3️⃣</span>
      <div>
        <div class="check-label">Commit &amp; push</div>
        <div class="check-desc">With a descriptive message — not "fix stuff" but real context that's searchable</div>
      </div>
    </div>
    <div class="check-item">
      <span class="check-icon">4️⃣</span>
      <div>
        <div class="check-label">Save session</div>
        <div class="check-desc">Persist decisions, progress, and blockers so the next session picks up seamlessly</div>
      </div>
    </div>
  </div>

  <!-- ======================================================== -->
  <!-- UPGRADE CTA                                               -->
  <!-- ======================================================== -->
  <div class="cta-box">
    <div style="font-size: 1.3em; font-weight: 700;">⭐ Unlock PRO Features</div>
    <p class="cta-subtitle">Project scoring, compliance audit, port conflict detection, multi-project discovery.</p>
    <div style="margin: 12px 0;">
      <strong>Pro</strong> $2/mo · <strong>Team</strong> $12/mo · <strong>Enterprise</strong> $36/mo
    </div>
    <a class="cta-button" href="https://api.compr.ch/contextengine/pricing">Get ContextEngine PRO →</a>
    <p class="cta-subtitle">Already have a key? Run <code>npx @compr/contextengine-mcp activate</code></p>
  </div>

  <p style="text-align: center; margin-top: 24px; color: var(--vscode-descriptionForeground);">
    ContextEngine v0.5.0 · <a href="https://marketplace.visualstudio.com/items?itemName=css-llc.contextengine">Marketplace</a>
    · <a href="https://www.npmjs.com/package/@compr/contextengine-mcp">npm</a>
  </p>

</body>
</html>`;
}

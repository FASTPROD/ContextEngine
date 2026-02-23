# ContextEngine — VS Code Extension

**AI Agent Compliance.** Persistent memory, enforcement nudges, and session management for AI coding agents.

## Why

AI coding agents (Copilot, Claude, Cursor) are powerful but forgetful. They don't commit code, they don't save context, and they don't follow protocol. ContextEngine won't make them perfect — but it adds the guardrails that make the difference between a productive session and a mess.

## Features

### 🛡️ Git Status Monitor
Continuous monitoring of uncommitted changes across all workspace projects. Status bar shows real-time count. Notifications fire when changes accumulate without commits.

### 💬 Chat Participant — `@contextengine`
Talk to ContextEngine directly from Copilot Chat:

| Command | What it does |
|---------|-------------|
| `@contextengine /status` | Session health dashboard — uncommitted files, project status |
| `@contextengine /commit fix: resolve login bug` | Stage + commit all changes with your message |
| `@contextengine /search deployment process` | Search the knowledge base |
| `@contextengine /remind` | Full enforcement checklist — what's missing before you end |
| `@contextengine /sync` | Check CE doc freshness per project — shows stale/missing docs |

### 📊 Status Bar
Persistent indicator showing:
- ✅ `CE` — all clean
- ⚠️ `CE: 5` — uncommitted files (yellow warning)
- 🔴 `CE: 12` — critical, commit now (red alert)

Click for detailed breakdown with action buttons.

### ℹ️ Info Panel
Click the ℹ️ status bar icon for a WebView panel showing:
- What ContextEngine monitors (7-item checklist with FREE/PRO badges)
- End-of-session protocol steps
- CE Doc Sync status
- Architecture overview

### 🔔 Smart Notifications
- Warning when uncommitted files exceed threshold (configurable)
- Escalating urgency — gentle at 5 files, urgent at 10+
- **Doc staleness alerts** — fires when code is committed but CE docs (copilot-instructions, SKILLS.md, SCORE.md) haven't been updated (15-min cooldown)
- Action buttons: "Commit All", "Show Status", "Run Sync"
- 5-minute cooldown between notifications (no spam)

### 🖥️ Terminal Watcher *(v0.4.0)*
Monitors all terminal command completions via VS Code Shell Integration API:
- Classifies commands: git, npm, build, deploy, test, ssh
- Fires notifications on success/failure
- Auto-triggers git rescan after git commands
- 30-second cooldown per category (no notification flood)

### 🪝 Pre-Commit Hook *(v0.4.0)*
Bundled at `hooks/pre-commit` — warns (never blocks) when code is staged but CE docs are stale (>4h) or missing. Install:
```bash
cp hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

### ⌨️ Commands
| Command | Description |
|---------|-------------|
| `ContextEngine: Commit All Changes` | Stage + commit across all workspace projects |
| `ContextEngine: Show Session Status` | Detailed status in Output panel |
| `ContextEngine: End Session Checklist` | Run end-of-session protocol |
| `ContextEngine: Search Knowledge Base` | Search ContextEngine knowledge |
| `ContextEngine: CE Doc Sync` | Check doc freshness across all projects |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `contextengine.gitCheckInterval` | `120` | Git scan interval in seconds |
| `contextengine.enableNotifications` | `true` | Show notification warnings |
| `contextengine.enableStatusBar` | `true` | Show status bar indicator |
| `contextengine.autoCommitReminder` | `true` | Remind to commit when files accumulate |
| `contextengine.maxDirtyFilesBeforeWarning` | `5` | Uncommitted file threshold for warnings |

## How It Works

The extension delegates to the [ContextEngine MCP](https://www.npmjs.com/package/@compr/contextengine-mcp) CLI for knowledge operations (search, sessions, learnings). Git operations use native `git` commands directly.

This separation means:
- **Extension stays lightweight** — no heavy dependencies (embeddings, BM25)
- **Always works** — git monitoring works even without ContextEngine CLI installed
- **Full power when available** — search, sessions, end-session checks when CLI is installed

## Privacy

**ContextEngine runs 100% on your machine.** No project data — code, learnings, sessions, git history, dependencies — is ever sent to an external server. The only network calls are license validation for PRO users (license key + machine ID hash). See the [full privacy details](https://github.com/FASTPROD/ContextEngine#privacy--data-security).

## Requirements

- VS Code 1.93+
- Git installed and available in PATH
- (Optional) `@compr/contextengine-mcp` npm package for search/session features

## License

BSL-1.1 (Business Source License) — see [LICENSE](https://github.com/FASTPROD/ContextEngine/blob/main/LICENSE)

© 2026 FASTPROD / compr.ch

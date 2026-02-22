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

### 📊 Status Bar
Persistent indicator showing:
- ✅ `CE` — all clean
- ⚠️ `CE: 5` — uncommitted files (yellow warning)
- 🔴 `CE: 12` — critical, commit now (red alert)

Click for detailed breakdown with action buttons.

### 🔔 Smart Notifications
- Warning when uncommitted files exceed threshold (configurable)
- Escalating urgency — gentle at 5 files, urgent at 10+
- Action buttons: "Commit All", "Show Status"
- 5-minute cooldown between notifications (no spam)

### ⌨️ Commands
| Command | Description |
|---------|-------------|
| `ContextEngine: Commit All Changes` | Stage + commit across all workspace projects |
| `ContextEngine: Show Session Status` | Detailed status in Output panel |
| `ContextEngine: End Session Checklist` | Run end-of-session protocol |
| `ContextEngine: Search Knowledge Base` | Search ContextEngine knowledge |

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

## Requirements

- VS Code 1.93+
- Git installed and available in PATH
- (Optional) `@compr/contextengine-mcp` npm package for search/session features

## License

BSL-1.1 (Business Source License) — see [LICENSE](https://github.com/FASTPROD/ContextEngine/blob/main/LICENSE)

© 2026 FASTPROD / compr.ch

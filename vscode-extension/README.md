# OpsContext — VS Code Extension

**AI Agent Compliance.** Persistent memory, enforcement nudges, and session management for AI coding agents.

> Previously published as **ContextEngine** — same extension, same install ID (`css-llc.contextengine`), same `@contextengine` chat handle, same settings keys. Auto-update brings you the OpsContext rebrand; your keybindings and configuration continue to work unchanged. See [CHANGELOG.md](CHANGELOG.md) for the 0.8.0 entry.

## Why

AI coding agents (Copilot, Claude, Cursor) are powerful but forgetful. They don't commit code, they don't save context, and they don't follow protocol. OpsContext won't make them perfect — but it adds the guardrails that make the difference between a productive session and a mess.

## Features

### 🛡️ Git Status Monitor
Continuous monitoring of uncommitted changes across all workspace projects. Status bar shows real-time count. Notifications fire when changes accumulate without commits.

### 💬 Chat Participant — `@contextengine`
Talk to OpsContext directly from Copilot Chat:

| Command | What it does |
|---------|-------------|
| `@contextengine /status` | Session health dashboard — uncommitted files, project status |
| `@contextengine /commit fix: resolve login bug` | Stage + commit all changes with your message |
| `@contextengine /search deployment process` | Search the knowledge base |
| `@contextengine /remind` | Full enforcement checklist — what's missing before you end |
| `@contextengine /sync` | Check doc freshness per project — shows stale/missing docs |

*(The chat handle stays `@contextengine` so your saved transcripts and muscle memory keep working.)*

### 📊 Status Bar
Persistent indicator showing:
- ✅ `CE` — all clean
- ⚠️ `CE: 5` — uncommitted files (yellow warning)
- 🔴 `CE: 12` — critical, commit now (red alert)

Click for detailed breakdown with action buttons. *(Status-bar text uses `CE` for compactness; the brand is OpsContext.)*

### ℹ️ Info Panel
Click the ℹ️ status bar icon for a WebView panel showing:
- What OpsContext monitors (7-item checklist with FREE/PRO badges)
- End-of-session protocol steps
- Doc Sync status
- Architecture overview

### 🔔 Smart Notifications
- Warning when uncommitted files exceed threshold (configurable)
- Escalating urgency — gentle at 5 files, urgent at 10+
- **Doc staleness alerts** — fires when code is committed but docs (copilot-instructions, SKILLS.md, SCORE.md) haven't been updated (15-min cooldown)
- Action buttons: "Commit All", "Show Status", "Run Sync"
- 5-minute cooldown between notifications (no spam)

### 🖥️ Terminal Watcher *(v0.4.0, upgraded v0.6.2)*
Monitors all terminal command completions via VS Code Shell Integration API:
- **Smart classification**: git, npm, build, deploy, test, database, python, ssh
- **Credential redaction** — passwords, tokens, API keys masked as `***` in Output log
- **Stuck-pattern detection** — alerts after 3+ consecutive same-type failures (e.g. "Agent appears stuck: 3× git failures (SIGINT/cancelled)")
- **Comment filtering** — shell comment lines (`# ...`) silently ignored
- Fires notifications on success/failure
- Auto-triggers git rescan after git commands
- 30-second cooldown per category (no notification flood)

### 🪝 Pre-Commit Hook *(v0.4.0, upgraded v1.20.0)*
Bundled at `hooks/pre-commit` — **BLOCKS commits** (exit 1) when code is staged but docs are stale (>4h) or missing. Agents ignore warnings — only hard blocks prevent compliance drift. Install:
```bash
cp hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

### ⌨️ Commands
| Command | Description |
|---------|-------------|
| `OpsContext: Commit All Changes` | Stage + commit across all workspace projects |
| `OpsContext: Show Session Status` | Detailed status in Output panel |
| `OpsContext: End Session Checklist` | Run end-of-session protocol |
| `OpsContext: Search Knowledge Base` | Search OpsContext knowledge |
| `OpsContext: Sync Docs` | Check doc freshness across all projects |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `contextengine.gitCheckInterval` | `120` | Git scan interval in seconds |
| `contextengine.enableNotifications` | `true` | Show notification warnings |
| `contextengine.enableStatusBar` | `true` | Show status bar indicator |
| `contextengine.autoCommitReminder` | `true` | Remind to commit when files accumulate |
| `contextengine.maxDirtyFilesBeforeWarning` | `5` | Uncommitted file threshold for warnings |

*(Setting keys stay `contextengine.*` — your existing `settings.json` continues to work after the rebrand.)*

## How It Works

The extension delegates to the [OpsContext MCP](https://www.npmjs.com/package/@compr/opscontext-mcp) CLI for knowledge operations (search, sessions, learnings). Git operations use native `git` commands directly.

This separation means:
- **Extension stays lightweight** — no heavy dependencies (embeddings, BM25)
- **Always works** — git monitoring works even without the OpsContext CLI installed
- **Full power when available** — search, sessions, end-session checks when CLI is installed

## Privacy

**OpsContext runs 100% on your machine.** No project data — code, learnings, sessions, git history, dependencies — is ever sent to an external server. The only network calls are license validation for PRO users (license key + machine ID hash). See the [full privacy details](https://www.npmjs.com/package/@compr/opscontext-mcp#privacy--data-security).

## Requirements

- VS Code 1.93+
- Git installed and available in PATH
- (Optional) `@compr/opscontext-mcp` npm package for search/session features

## License

BSL-1.1 (Business Source License) — see [LICENSE](https://www.npmjs.com/package/@compr/opscontext-mcp)

© 2026 FASTPROD / compr.ch

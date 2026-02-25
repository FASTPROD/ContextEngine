# Changelog

All notable changes to the ContextEngine VS Code Extension.

## [0.6.7] — 2026-02-25

### Added
- **Output file logger** — mirrors all Output channel content to `~/.contextengine/output.log` with timestamps. Agents in any project can read the log via `read_file` — no copy-paste needed.
- Automatic log rotation at 512 KB (keeps most recent 384 KB).
- Session markers in log file for boundary detection.

## [0.6.6] — 2026-02-25

### Fixed
- **Credential redaction** — broadened from 8 to 10 patterns: `WORD_API_KEY=`, `WORD_SECRET_KEY=`, vendor key prefixes (`gsk_`, `sk-live_`, `ghp_`, etc.). Fixes PGPASSWORD and GROQ_API_KEY leaking in Output panel.
- `.git/hooks/` path operations (cp, chmod, cat) now classified as `[git]` instead of `[other]`.

## [0.6.5] — 2026-02-25

### Fixed
- **Log dedup** — StatsPoller uses fingerprint comparison, only fires events when values change. Git scan uses fingerprint, only logs when dirty count changes. Eliminates 99% of duplicate log lines.
- Terminal watcher: `tsc --noEmit` → build, `npm version` → npm, `code --install-extension` → npm, `npx @vscode/vsce` → npm.

## [0.6.0] — 2026-02-24

### Added
- **Value meter status bar** — shows MCP session value: recalls, saves, time saved. Falls back to git status when no session active.
- **Live stats dashboard** — info panel shows real-time session metrics.
- **Stats poller** — reads `~/.contextengine/session-stats.json` every 15s.

## [0.3.0] — 2026-02-22

### Added
- **PRO upgrade flow** — PRO badges in info panel are now clickable → opens pricing page.
- Golden CTA box in info panel: plan prices, "Get ContextEngine PRO →" button, activate instructions.
- Links to pricing page (`compr.ch/contextengine/pricing`).

### Changed
- License updated to BSL-1.1 (was AGPL-3.0).
- Info panel WebView now has `enableScripts: true` for link handling.

## [0.2.0] — 2026-02-22

### Added
- **Info panel WebView** — ℹ️ status bar icon, monitoring checklist with FREE/PRO badges.
- End-of-session protocol checklist (6 steps).
- "How It Works" section explaining MCP server + extension architecture.
- Live git status table in info panel.

## [0.1.0] — 2026-02-22

### Added
- Initial release.
- **Git status monitor** — scans all workspace repos every 2 minutes.
- **CE:N status bar** — live uncommitted file count (green → yellow → red).
- **`@contextengine` chat participant** — `/status`, `/commit`, `/search`, `/remind`.
- **Escalating notifications** — warnings with 5-minute cooldown.
- **Commit All command** — one-click commit across all repos.
- 5 configurable settings (interval, notifications, status bar, auto-remind, threshold).

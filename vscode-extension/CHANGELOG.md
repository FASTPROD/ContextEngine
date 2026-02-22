# Changelog

All notable changes to the ContextEngine VS Code Extension.

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

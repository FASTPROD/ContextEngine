# Changelog

All notable changes to the OpsContext VS Code Extension (previously ContextEngine).

## [0.8.2] — 2026-06-11 — HTML Score Report button in the info panel

### Added
- **"Generate HTML Score Report" button inside the `ℹ️ OpsContext — Dashboard` WebView panel**. The 0.8.1 release made the report invokable from the Command Palette; 0.8.2 makes it invokable from the existing dashboard the user already has open. The button delegates to the same `contextengine.scoreHtml` command — same handler, two surfaces. DRY.
- **WebView ↔ extension messaging wired up**: `webview.onDidReceiveMessage` handler in `src/infoPanel.ts` routes `{command: 'scoreHtml'}` to the existing command and `{command: 'openPricing'}` to the pricing page. Same pattern is reusable for any future WebView-side button.
- **Upgrade CTA button** (the "Get OpsContext PRO →" link in the same panel) converted from `<a href>` to a `<button>` that posts a message → opens external. Consistent click handling, cleaner WebView CSP posture.

### Why patch, not minor
Pure UX surfacing. The actual feature (HTML score report generation) shipped in 0.8.1; 0.8.2 just adds a second entry point in a panel the user already opens. No new APIs, no contract changes, no behavior change for users who only used the Command Palette.

## [0.8.1] — 2026-06-11 — Closeable paid-feature gap: HTML Score Report command

### Added
- **`OpsContext: Generate HTML Score Report (PRO)`** in the Command Palette (`Cmd+Shift+P`). Closes the visible-paid-feature gap from 0.8.0 — the pricing page advertises *"HTML score reports — ✓"* for PRO but until now there was no clickable path to invoke it. Users had to know to open a terminal and run `npx @compr/opscontext-mcp score --html`.
- Command flow:
  1. Pre-flight PRO check via `contextengine status` so the upgrade flow LEADS instead of trailing a confusing error.
  2. If not PRO → warning notification with three actions: **Get a Pro key** (opens pricing page), **Already have a key? Activate** (surfaces the `activate <key> <email>` command), **Dismiss**.
  3. If PRO → progress notification, generates the HTML via the CLI (`score [project] --html --no-save`), CLI auto-opens it in the default browser.
  4. Post-generation notification offers **Reveal in Finder** + **Open file** actions for the generated `tmpdir()/contextengine-score.html`.
- Late-bind fallback: if the CLI returns a gate-rejection message AFTER the pre-flight passed (e.g., license expired between probe and call), surface the same upgrade prompt with a **Reactivate** action.
- New CLI client functions: `generateHtmlScoreReport(projectName?)` and `isProActivated()` in `src/contextEngineClient.ts`.

### Why patch, not minor
This is a polish release that fills a UX gap in 0.8.0 — no new APIs, no contract changes, no behavior change for existing users. Adding a single command is the textbook patch-level change.

## [0.8.0] — 2026-06-11 — Renamed to OpsContext

This is a user-visible rebrand release. Back-compat is preserved across every interface that matters:

### What changed for users
- **displayName** in the Marketplace → "OpsContext — AI Agent Compliance"
- **Command titles** in the palette → "OpsContext: Commit All Changes", etc.
- **Status bar text**, output channel name, notifications, info panel WebView → "OpsContext"
- **Chat participant fullName** in `@contextengine` → "OpsContext"
- **CLI delegate** in `src/contextEngineClient.ts` → switched from `@compr/contextengine-mcp` to `@compr/opscontext-mcp` (LOCKed; the old npm package is now deprecated)
- **README + CTA links** → point at the new npm name; pricing URL stays at `https://api.compr.ch/contextengine/pricing` (the only path the activation server actually serves)
- **Info panel footer** now reads the extension version dynamically from `packageJSON.version` so it never drifts from the published version again (the old `v0.6.0` hardcoded footer is gone — it had drifted from 0.7.1)

### What deliberately stays unchanged (back-compat)
- **Marketplace extension ID**: `css-llc.contextengine` — auto-updates work; nobody has to reinstall.
- **Command IDs**: `contextengine.commitAll`, `contextengine.showStatus`, `contextengine.endSession`, `contextengine.search`, `contextengine.showInfo`, `contextengine.sync` — existing keybindings continue to work.
- **Configuration keys**: `contextengine.gitCheckInterval`, `contextengine.enableNotifications`, `contextengine.enableStatusBar`, `contextengine.autoCommitReminder`, `contextengine.maxDirtyFilesBeforeWarning` — existing `settings.json` files continue to apply.
- **Chat handle**: `@contextengine` — saved transcripts and muscle memory unchanged.
- **Status bar abbreviation**: `CE` — kept for compactness; the brand is OpsContext.

### Why
The npm package `@compr/contextengine-mcp` was renamed to `@compr/opscontext-mcp@2.0.0` on 2026-06-10 as part of a strategic pivot to "OpsContext for AI Agents — the ops + compliance layer Claude Code can't grow natively". The 2.0.1 release on 2026-06-11 retired legacy SHA-256 license signatures. This extension delegates to that CLI, so they need to ship together — keeping the extension on the old name would silently break the PRO/search/sync features once the deprecated package stops being installable.



## [0.7.1] — 2026-03-03

### Added
- **Session save overdue warning** — status bar shows `⚠️ SAVE SESSION` with warning background when the MCP server's 10-minute session save timer expires. Tooltip shows "OVERDUE — save now!" row.
- `sessionOverdue` field consumed from `session-stats.json` (written by MCP server v1.22.1+).
- Fingerprint-based polling includes `sessionOverdue` — fires event on state change.

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

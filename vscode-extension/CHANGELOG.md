# Changelog

All notable changes to the OpsContext VS Code Extension (previously ContextEngine).

## [0.11.1] — 2026-06-26 — Info panel tool count is now dynamic (no more "17 MCP tools" drift)

### Fixed

- **Info panel hardcoded "Active on all 17 MCP tools"** — the displayed count was hardcoded at the moment the panel was authored. The actual MCP server shipped tool #21 (`drift_status`) in `@compr/opscontext-mcp@2.1.0`; the panel never updated. Two occurrences in `src/infoPanel.ts` (hero + plain-English explanation block).

### Added

- **`src/serverMeta.ts`** — synchronous reader for `~/.contextengine/server-meta.json`. The file is written on startup by `@compr/opscontext-mcp@>=2.1.3` (single source of truth = `src/tools-manifest.ts` in the npm package). Falls back to "Active on all MCP tools" (no count) when the file is absent — graceful degradation for users on older MCP server versions or first-run before the daemon has fired.

### Why this fix shape

The previous "fix" was conceptually "remember to update the panel when tools change." That's not a fix — it's a backlog item that ages into a bug. The 2.1.3 + 0.11.1 paired release breaks the drift class structurally:

- Adding a tool requires editing `src/tools-manifest.ts` in the npm package.
- A regression test in the npm package asserts `ALL_TOOLS.length === count(server.tool(...) in index.ts)`.
- The extension reads from `server-meta.json` which derives from the same manifest.

No human discipline needed. CI red on miss.

---

## [0.11.0] — 2026-06-24 — Drift alerts in VS Code UI + robust one-click setup (audit B2)

Folded two features into one 0.11.0 release because neither shipped before
the 2026-06-23 fresh-user audit:
1. L1→L2→L3 drift-pipeline surface in the editor (was the original 0.11.0
   scope).
2. A robust one-click setup that doesn't dump non-tech users at a `$`
   prompt with red text when Node is missing or a re-run trips over an
   existing LaunchAgent. The previous "Set up" command (introduced in
   0.10.0) chained `npm install -g … && opscontext install-autostart &&
   opscontext install-claude-hook` straight to `terminal.sendText` with
   zero pre-checks, no per-step exit-code capture, no rollback, and no
   idempotency — the audit's blocker B2.

### Added — Setup hardening (audit B2)
- **`src/setupOrchestrator.ts`** — new module owning `runSetup` and
  `runUninstall`. Every step runs as its own `cp.execFile` (no terminal,
  no shell) with stdout/stderr streamed into a dedicated
  **"OpsContext Setup"** output channel.
- **Pre-flight: Node toolchain check** — `which node` + `which npm`
  (uses `where` on Windows) before kicking off step 1. If either is
  missing, surfaces a modal with **[Open Download Page]** that calls
  `vscode.env.openExternal('https://nodejs.org/en/download')` instead of
  letting npm fail with `zsh: command not found`.
- **Pre-flight: daemon health probe** — hits
  `http://127.0.0.1:7842/health` with a 1-second timeout (uses Node's
  built-in `http` module — no new deps). On HTTP 200, modal-prompts
  "OpsContext server is already running. Run setup anyway?" If the user
  cancels, the next-steps modal still appears so they get the
  **[Open claude.ai]** / **[Try @contextengine in Copilot Chat]**
  buttons.
- **Per-step progress** — three sequential `execFile` invocations under
  one `vscode.window.withProgress` with messages "Downloading OpsContext
  server (1/3)…", "Setting up auto-start (2/3)…", "Wiring Claude Code
  hook (3/3)…".
- **Idempotency heuristics** — step 2 (install-autostart) and step 3
  (install-claude-hook) recognise "already exists" / "already installed"
  / "plist already" in stderr and surface a friendly "no changes
  needed" line in the output channel instead of escalating to an error.
- **Per-step failure UX** — on any hard failure, a single notification
  fires with **[Open Output]** + **[Dismiss]** actions; the [Open
  Output] action focuses the "OpsContext Setup" channel rather than
  leaving the user staring at a notification that lost context.
- **macOS gating** — `install-autostart` is skipped with a friendly note
  on non-darwin platforms. Steps 1 and 3 still run.
- **Success modal** — replaces the old "wait for the Web Store" dead-end
  echo with a single modal: **[Open claude.ai]** /
  **[Try @contextengine in Copilot Chat]** / **[Done]**.
- **`contextengine.uninstall` command** — registered in `extension.ts`
  + `package.json` `contributes.commands`. Confirmation modal →
  `opscontext uninstall-autostart` → `opscontext uninstall-claude-hook`
  → `npm uninstall -g @compr/opscontext-mcp`, each tolerating
  already-removed pieces. Final modal surfaces "OpsContext uninstalled".

### Why fold instead of bumping to 0.12.0
0.11.0 was not yet published to the marketplace at the time of the audit
fix (no `contextengine-0.11.0.vsix` artefact, no `vscode:publish` run).
Bundling the setup hardening into 0.11.0 saves the marketplace
ceremony of two back-to-back releases without breaking any contract
(both changes are additive; nothing existing was removed or renamed).

### Added — Drift alerts (original 0.11.0 scope, unchanged)
- **`src/driftAlertPoller.ts`** — new `vscode.Disposable` that tails
  `~/.contextengine/audit.log` on a 15 s interval, parses every new
  `drift.detected` record (the same record `opscontext watch` writes via the
  detector's `safeAppend` call), and forwards survivors to
  `NotificationManager.showDriftAlert`. Three-layer dedup: byte-offset cursor
  (persisted in `workspaceState`) → per-record hash LRU (in-memory, 500) →
  per-kind 5 min throttle (critical bypasses).
- **`NotificationManager.showDriftAlert`** — added to `src/notifications.ts`.
  Routes severity → VS Code dialog tier: `info` → info popup, `warn` →
  warning popup, `critical` → modal warning. Actions: **Show Audit Log** /
  **Mute this kind** / **Dismiss**.
- **`contextengine.showDriftLog`** command — target for the "Show Audit Log"
  action; renders the last 200 `drift.detected` records to the OpsContext
  output channel, newest first.
- **`contextengine.alertHistory`** command — palette-driven entry to the same
  drift history viewer.
- **`contextengine.enableDriftAlerts`** setting (boolean, default `true`) —
  drift-specific opt-out. When disabled, the poller still tails (EventEmitter
  still fires for future surfaces like the info panel) but no popups appear.
- **`src/driftAlertPoller.test.ts`** — first test file inside
  `vscode-extension/`, using Node's built-in `node:test` + `node:assert` (no
  new dev dependencies).

### Layer story
- L1 (since 2.1.0): `opscontext watch` CLI runs the 8-heuristic detector and
  writes `drift.detected` records into `~/.contextengine/audit.log`.
- L2 (NEW — 0.11.0): `DriftAlertPoller` tails that log and forwards records.
- L3 (NEW — 0.11.0): `NotificationManager.showDriftAlert` surfaces them as
  in-editor popups.

### Why minor (0.10 → 0.11)
Net-new in-editor capability. No breaking changes.

## [0.9.0] — 2026-06-23 — Cross-surface event emitters → OpsContext audit log

### Added
- **VS Code → OpsContext event capture** — the extension now writes audit-log events for every meaningful user interaction:
  - `vscode.prompt_submit` — fires when the user invokes the `@contextengine` chat participant (any command or freeform prompt). Payload includes the surface, command, prompt text (truncated to 4 KB), and char_count.
  - `vscode.tool_call` — fires when the user invokes any Command Palette entry (`OpsContext: Commit All`, `Show Session Status`, `End Session Checklist`, `Search Knowledge Base`, `What We Check`, `Sync Docs`, `Generate HTML Score Report`). Payload includes the command id + the trigger source.
- **Fire-and-forget delivery via the `contextengine emit-event` CLI** (new in `@compr/opscontext-mcp@2.1.0`). The extension's `contextEngineClient.ts` now exports `emitEvent(kind, payload, actor?)` that shells out asynchronously — never blocks the chat response, never surfaces errors to the user (if the CLI is missing or the audit log is unreachable, the event drops silently and the UI is unaffected).
- **End-to-end flow now closed**: every interaction with OpsContext via VS Code (chat panel, command palette, dashboard button) lands in the same hash-chained `~/.contextengine/audit.log` that the Chrome extension writes to. `contextengine watch` and the `drift_status` MCP tool see them all.

### Why minor (0.8 → 0.9)
- Net-new capability: an extension that previously had no telemetry now has structured audit-log events for every user interaction.
- No breaking changes — all existing commands, settings, keybindings, and the `@contextengine` chat handle continue to work identically.
- Bumps the minor digit per semver because adding an event-emission contract is a feature, not a fix.

### Privacy posture (unchanged from prior releases)
- Events go ONLY to the local audit log (`~/.contextengine/audit.log`). No outbound traffic.
- The same redaction discipline that protects Chrome captures applies: prompt text is truncated to 4 KB and passes through the secret-pattern scrubbers in the existing audit pipeline.
- The user can disable event emission entirely by uninstalling `@compr/opscontext-mcp` (the CLI shell-out becomes a silent no-op and the UI degrades gracefully).

### Required companion release
- `@compr/opscontext-mcp@2.1.0` ships the `emit-event` CLI that this extension shells out to. The extension still works against 2.0.2 (events become silent no-ops), but you'll want both upgraded together to get the full audit-log flow.

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

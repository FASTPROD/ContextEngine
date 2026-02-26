# Changelog

All notable changes to ContextEngine (MCP server + CLI) are documented here.

## [1.20.2] — 2026-02-26

### Fixed
- **MCP config schema** — `.vscode/mcp.json` corrected from `mcpServers` to `servers`, added `"type": "stdio"`. MCP was disconnected from Copilot Chat without this fix.
- Removed deprecated MCP config from `.code-workspace` settings.
- **Multi-window output.log** — `outputLogger.ts` now tags every line with workspace name (e.g. `[ContextE]`, `[compR]`) to disambiguate shared log from multiple VS Code windows.

### Added
- 3 new test suites: `cli.test.ts` (8 tests), `sessions.test.ts` (16 tests), `firewall.test.ts` (8 tests).
- **57 tests across 6 files** (was 25 in 3 files). Score: 95% A+.
- PM2 `ecosystem.config.cjs` for local dev orchestration.

## [1.20.1] — 2026-02-25

### Fixed
- **Pre-commit hook now BLOCKS** (exit 1) — agents ignore warnings, only hard gates prevent compliance drift.

### VS Code Extension v0.6.2–v0.6.7
- Terminal watcher — 9 categories, 10 credential redaction patterns, stuck-pattern detection (3+ failures).
- Log dedup (v0.6.5) — fingerprint-based, 99% output noise reduction.
- Output file logger (v0.6.7) — mirrors Output panel to `~/.contextengine/output.log` for agent analysis.
- Credential redaction broadened to `WORD_API_KEY=` patterns + vendor prefixes (gsk_, sk-live_, ghp_, etc.).

## [1.20.0] — 2026-02-25

### Added
- **Value Meter** — status bar shows recalls, saves, estimated time saved.
- **Live stats dashboard** — ℹ️ info panel shows real-time session metrics.
- **CLI `stats` command** — reads `~/.contextengine/session-stats.json` for live metrics.
- Stats written by Protocol Firewall via `flushStats()` (debounced every 10s).

## [1.19.0–1.19.1] — 2026-02-24

### Added
- **Protocol Firewall** — escalating compliance enforcement on all 17 tool responses.
- **Learning quality gates** — min 15 chars, auto-categorization, import filters.
- **Auto-import learnings** from discovered markdown sources during reindex.
- **Delta module obfuscation** — terser mangle+compress, 46–72% size reduction.
- Privacy & Data Security section in README.
- GitHub repo made PUBLIC.

## [1.18.0] — 2026-02-23

### Security
- **Project-scoped learnings** — `listLearnings()` and `learningsToChunks()` now accept `projects[]` param. Only returns learnings matching active workspace project names + universal (no project set). Prevents cross-project IP leakage.
- MCP: `activeProjectNames` state populated from `loadProjectDirs()` during reindex, passed to all learnings calls.
- CLI: `cliListLearnings()` and `initEngine()` scope by project via `loadProjectDirs()`.

### Improved
- **`end-session` CLI** — comprehensive pre-flight with 4 sections: (1) git status with branch names, (2) doc freshness (copilot-instructions, SKILLS.md, SCORE.md), (3) learnings stats (total, categories, scoped vs hidden), (4) sessions (count, 3 most recent with age).

### VS Code Extension v0.4.0
- **`/sync` chat command** — checks CE doc freshness per project, shows stale/missing docs with actionable steps.
- **`contextengine.sync` command** — Output channel report with "Open Chat" action.
- **Doc staleness notifications** — fires warning when code committed but CE docs not updated (15-min cooldown).
- **Pre-commit hook** — `hooks/pre-commit` warns about stale CE docs when code files are staged (never blocks).
- **CE doc freshness in GitSnapshot** — `checkCEDocFreshness()` tracks copilot-instructions, SKILLS.md, SCORE.md age per project.
- **Terminal watcher** — monitors command completions via Shell Integration API (`onDidEndTerminalShellExecution`). Classifies commands (git/npm/build/deploy/test/ssh), fires notifications on success/failure, auto-rescans git status after git commands. 30s cooldown per category.
- Philosophy: **event-driven compliance** (hooks + scan-cycle triggers), not memory-driven.

## [1.17.0] — 2026-02-22

### Changed
- **License: AGPL-3.0 → BSL-1.1** — Business Source License with non-compete clause. Converts to AGPL-3.0 on Feb 22, 2030.
- **README overhaul** — added VS Code Extension section, PRO Features comparison table, pricing CTA, marketplace badge.

### Added
- Pricing page (`server/public/pricing.html`) — dark-themed, responsive, 3-tier cards (Pro $2/Team $12/Enterprise $36).
- `/contextengine/pricing` route on activation server.
- Info panel upgrade flow — PRO badges are clickable → pricing page, golden CTA box with plan prices.
- Pricing page billing toggle (monthly/annual) + JavaScript checkout flow via `/contextengine/create-checkout-session`.
- Success page (`server/public/success.html`) — post-checkout landing with activation instructions.
- `/contextengine/success` route on activation server.
- PM2 ecosystem.config.cjs on VPS with Stripe test key (`stripeEnabled: true`).

### Fixed
- Excluded `test.js` and `test-sessions.js` from npm package (dev artifacts were shipping to users).

## [1.16.0] — 2026-02-21

### Added
- **5 new CLI commands**: `save-session`, `load-session`, `list-sessions`, `end-session`, `import-learnings`.
- Non-interactive mode (`--yes` / `-y` / `!process.stdin.isTTY`).
- Auto-session inject on MCP startup (loads most recent session <72h).
- Enforcement nudge: reminds agents to `save_session` after 15+ tool calls.
- Git status warnings every 2 minutes of tool activity.
- Context-aware scoring: stub Dockerfiles get minimal credit, managed platforms get full infra points.
- `import_learnings` MCP tool — bulk-import from Markdown or JSON.
- `delete_learning` MCP tool.

## [1.15.0] — 2026-02-20

### Added
- **Activation / licensing system** — license validation, AES-256-CBC delta decryption, machine fingerprinting, daily heartbeat.
- **Activation server** (`server/`) — Express + SQLite3 + Helmet, port 8010.
- **Stripe integration** — checkout sessions, webhook handler, license provisioning, SMTP email delivery.
- **Delta modules** — premium code extracted and encrypted per-machine.
- 4 gated PRO tools: `score_project`, `run_audit`, `check_ports`, `list_projects`.
- Rate limiting (5 req/min), CORS whitelist, graceful shutdown.
- Machine fingerprint: `SHA-256(platform|arch|homedir|user)`.

## [1.14.0] — 2026-02-19

### Added
- **VS Code Extension v0.1.0** — git monitor, status bar, chat participant, notifications.
- VS Code Extension v0.2.0 — info panel WebView with monitoring checklist.
- `@contextengine` chat participant with `/status`, `/commit`, `/search`, `/remind` commands.
- Escalating notification system with cooldown.

## [1.0.0–1.13.x]

### Core
- MCP server with stdio transport.
- BM25 keyword + semantic search (Xenova `all-MiniLM-L6-v2`).
- Auto-discovery of `copilot-instructions.md`, `CLAUDE.md`, `.cursorrules`, `AGENTS.md`.
- Code parsing (TS/JS/Python function/class extraction).
- Operational collectors: git, Docker, PM2, nginx, cron, package.json.
- Session persistence (`save_session`, `load_session`, `list_sessions`).
- Learnings store (append-only, category-validated, dedup).
- Plugin adapters (Notion, RSS, custom).
- CLI with 15 subcommands.
- AI-readiness scoring (12 checks, weighted rubric, A+ to F).
- Compliance audit (security, performance, DX, architecture).
- Port conflict detection across projects.
- 25 vitest tests.
- GitHub Actions CI (Node 18/20/22).

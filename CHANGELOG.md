# Changelog

All notable changes to ContextEngine (MCP server + CLI) are documented here.

## [1.17.0] — 2026-02-22

### Changed
- **License: AGPL-3.0 → BSL-1.1** — Business Source License with non-compete clause. Converts to AGPL-3.0 on Feb 22, 2030.
- **README overhaul** — added VS Code Extension section, PRO Features comparison table, pricing CTA, marketplace badge.

### Added
- Pricing page (`server/public/pricing.html`) — dark-themed, responsive, 3-tier cards (Pro $2/Team $12/Enterprise $36).
- `/contextengine/pricing` route on activation server.
- Info panel upgrade flow — PRO badges are clickable → pricing page, golden CTA box with plan prices.

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

# Copilot Instructions — ContextEngine

## Project Context
- **TypeScript MCP Server** — queryable knowledge base for AI coding agents
- **GitHub**: FASTPROD/ContextEngine
- **Version**: v1.14.1
- **Branch**: `main`
- **npm**: `@compr/contextengine-mcp`
- **License**: BSL-1.1 (Business Source License)

## Architecture
- MCP protocol over `stdio` transport — works with Claude Desktop, VS Code Copilot, Cursor, etc.
- **CLI**: 9 subcommands — `search`, `list-sources`, `list-projects`, `score`, `list-learnings`, `audit`, `activate`, `deactivate`, `status` (no MCP required)
- Dual search: BM25 keyword (instant) + semantic embeddings (Xenova `all-MiniLM-L6-v2`, ~200ms from cache)
- Sources auto-discovered: `copilot-instructions.md`, `CLAUDE.md`, `SKILLS.md`, `contextengine.json`, session docs
- Operational context: git log, branch, recent commits, file tree, dependency versions
- Learnings store: append-only JSON in `~/.contextengine/learnings.json`
- Plugin adapters: `adapters/` — Claude Desktop, VS Code, Cursor auto-config

## Activation / Licensing System (v1.14.1)
- **Client** (`src/activation.ts`): License validation, AES-256-CBC delta decryption, machine fingerprinting, daily heartbeat
- **Server** (`server/`): Express + SQLite3 + Helmet, port 8010
  - `POST /contextengine/activate` — validate license, return encrypted delta bundle
  - `POST /contextengine/heartbeat` — periodic license re-validation
  - `GET /contextengine/health` — status endpoint
- **Delta modules**: Premium code extracted by `gen-delta.ts` → encrypted per-machine (key = SHA-256(licenseKey + machineId))
- **Machine fingerprint**: `SHA-256(platform|arch|homedir|user)` — tied to physical machine
- **License format**: `CE-XXXX-XXXX-XXXX-XXXX` (16 hex chars + prefix)
- **Plans**: `pro` (2 machines), `team` (5), `enterprise` (10)
- **Gated tools**: `score_project`, `run_audit`, `check_ports`, `list_projects`
- **Gated CLI**: `score`, `audit`, `list-projects`
- **API base**: `CONTEXTENGINE_API` env var or `https://api.compr.ch/contextengine`
- **Offline grace**: 7 days without heartbeat before lockout

### Server Security (Feb 2026)
- **Rate limiting**: `express-rate-limit` — 5 req/min per IP on `/activate` and `/heartbeat`
- **CORS whitelist**: `compr.ch`, `compr.app`, `localhost` (regex) — NO wildcard
- **Graceful shutdown**: SIGTERM/SIGINT handlers close SQLite DB + HTTP server
- **Helmet**: Standard HTTP security headers
- **Input validation**: License format regex, machine ID length/charset checks
- **Audit logging**: All activation attempts logged with timestamp + IP
- **Parameterized SQL**: All queries use `?` placeholders (no string interpolation)

## Infrastructure
- **Production server**: Gandi VPS `92.243.24.157` (Debian 10, admin user)
- **SSH key**: `~/.ssh/id_ed25519` (has passphrase — interactive only, no CI automation)
- **Activation server path**: `/var/www/contextengine-server/`
- **PM2 process**: `contextengine-api` on port 8010
- **Nginx proxy**: `api.compr.ch/contextengine/` → `127.0.0.1:8010`
- **Same VPS as**: admin.CROWLR (Docker PHP 8.2), VOILA.tips (PHP 7.4)
- **CI**: GitHub Actions `.github/workflows/ci.yml` — Node 18/20/22, build + smoke test
- **Deploy**: `server/deploy.sh` — interactive rsync to VPS + PM2 + nginx config

## Source Files
| File | Purpose |
|---|---|
| `src/index.ts` | MCP server entry — tool registration, stdio transport |
| `src/cli.ts` | CLI entry — 9 subcommands (search, score, audit, activate, etc.) |
| `src/search.ts` | BM25 keyword + semantic search, temporal decay, chunk ranking |
| `src/sources.ts` | Auto-discovery of project docs, git context, dependency info |
| `src/learnings.ts` | Append-only learning store, category validation, dedup |
| `src/scoring.ts` | Project health scoring — 12 checks, weighted rubric |
| `src/audit.ts` | Beyond-A+ audit — security, performance, DX, architecture |
| `src/ports.ts` | Port conflict detector across projects |
| `src/embeddings.ts` | Xenova transformer embeddings, disk cache |
| `src/chunker.ts` | Markdown/code-aware chunking with 4-line overlap |
| `src/config.ts` | `contextengine.json` loader, project aliases |
| `src/activation.ts` | License validation, delta decryption, machine fingerprint, heartbeat |
| `server/src/server.ts` | Activation server — Express + SQLite3 + rate-limit + CORS + graceful shutdown |
| `server/src/seed.ts` | License key generator — `CE-XXXX-XXXX-XXXX-XXXX` format |
| `server/src/gen-delta.ts` | Delta module extractor — compiles premium modules from dist/ |
| `server/deploy.sh` | Production deploy script — rsync + PM2 + nginx config |
| `skills/contextengine/SKILL.md` | Bundled skill file — teaches agents how to use CE |
| `defaults/` | 30 starter learnings shipped with npm |

## MCP Tools Exposed (17 tools)
| Tool | Purpose | Gated? |
|---|---|---|
| `search` | BM25 + semantic search across all sources | Free |
| `list_sources` | Show discovered source files + chunk counts | Free |
| `get_project_context` | Git branch, recent commits, dependencies | Free |
| `save_learning` | Store a new operational learning | Free |
| `list_learnings` | Browse learnings by category | Free |
| `delete_learning` | Remove a learning by ID | Free |
| `import_learnings` | Bulk-import learnings from Markdown or JSON files | Free |
| `score_project` | Score project health (12 checks) | Pro |
| `run_audit` | Beyond-A+ audit (security, perf, DX) | Pro |
| `check_ports` | Detect port conflicts across projects | Pro |
| `list_projects` | List all registered projects | Pro |
| `register_project` | Add a project to contextengine.json | Free |
| `configure_adapter` | Auto-configure Claude Desktop / VS Code / Cursor | Free |
| `get_skill` | Retrieve a bundled skill file | Free |
| `list_skills` | List available skill files | Free |
| `activate` | Activate Pro license on this machine | Free |
| `activation_status` | Check current license status | Free |

## Stats (as of v1.14.1)
- 7,527 lines of source code (6,946 src/ + 581 server/)
- 17 MCP tools (13 free + 4 gated)
- 5 direct deps, 2 dev deps, 0 npm vulnerabilities
- 171 learnings across 16 categories in store
- 30 bundled starter learnings ship with npm
- Keyword search: instant (BM25 with IDF)
- Semantic search: ~200ms from cache, ~15s first run
- CI: GitHub Actions — Node 18/20/22, build + smoke test

## Critical Rules
1. **NEVER commit `.contextengine/`** — user data directory (learnings, embeddings cache, activation state)
2. **BSL-1.1 license** — non-compete clause: no hosted/SaaS offering using this codebase
3. **Bundled defaults are immutable** — `defaults/*.json` ship with npm; user learnings go to `~/.contextengine/`
4. **Search ranking weights are IP** — do NOT expose exact BM25 tuning, decay constants, or boost factors in docs/README
5. **`contextengine.json` is optional** — all features work via auto-discovery; config only adds aliases and overrides
6. **Skill files follow strict schema** — `SKILL.md` must have `## When to use`, `## Key rules`, `## Examples` sections
7. **server/ is NOT published to npm** — `files` field in package.json restricts to `dist/`, `defaults/`, `skills/`, `examples/`
8. **Never expose scoring internals in README** — exact point values, category weights, anti-gaming methods are trade secrets
9. **SSH to Gandi VPS requires passphrase** — `~/.ssh/id_ed25519`, cannot be automated without ssh-agent. Use `server/deploy.sh` interactively.
10. **End-of-session protocol** — before ending ANY session, the agent MUST: (a) update `copilot-instructions.md` with new facts, (b) create/update `SKILLS.md`, (c) call `save_learning` for each reusable pattern, (d) update `SCORE.md`, (e) commit with descriptive message, (f) push to all remotes.
11. **⛔ MANDATORY: `save_learning` in real-time** — every reusable pattern, fix, or discovery MUST be saved via `save_learning` tool AS SOON AS it is identified. Do NOT batch them. Do NOT defer to end-of-session. Each learning must be saved within the same turn it is discovered.

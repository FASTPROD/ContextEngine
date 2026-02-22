# ContextEngine — Skills & Capabilities

## Core Technologies
- **TypeScript** (ES2022, strict mode) — entire codebase, ~8,000 lines
- **MCP Protocol** (Model Context Protocol) — stdio transport, JSON-RPC 2.0, 17 tools
- **Node.js 18+** — ESM modules, native crypto, child_process for git

## Search & NLP
- **BM25** — keyword search with IDF weighting, temporal decay (90-day half-life)
- **Semantic Embeddings** — Xenova `all-MiniLM-L6-v2`, 384-dim vectors, cosine similarity
- **Chunking** — Markdown-aware section splitting with 4-line overlap at boundaries

## Security & Cryptography
- **AES-256-CBC** — delta module encryption (key = SHA-256 of licenseKey + machineId)
- **Machine Fingerprinting** — SHA-256 hash of platform, arch, homedir, username
- **Express Security** — Helmet headers, CORS whitelist, rate limiting (express-rate-limit)
- **Input Validation** — license format regex, charset/length checks on all user input
- **Parameterized SQL** — all SQLite queries use `?` placeholders

## Server & Infrastructure
- **Express 4** — activation/licensing server, 5 endpoints (activate, heartbeat, health, checkout, webhook)
- **SQLite3** (better-sqlite3) — license database, synchronous API
- **PM2** — process manager on Gandi VPS (Debian 10)
- **Nginx** — reverse proxy with path-based routing (`/contextengine/` → port 8010)
- **GitHub Actions CI** — Node 18/20/22 matrix, build + lint + test + smoke
- **Let's Encrypt SSL** — certbot auto-renewal on `api.compr.ch`

## Stripe Payment Integration
- **Stripe SDK v14** — checkout session creation, webhook handler (signature verification)
- **Webhook events** — `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`
- **License provisioning** — auto-seeds license on payment, dedup via email+plan match
- **Email delivery** — Nodemailer v6, Gandi SMTP (`mail.gandi.net:465`), HTML templates
- **Graceful degradation** — server runs without `STRIPE_SECRET_KEY` (payment endpoints not mounted)
- **Plan mapping** — `metadata.plan_key` in Stripe checkout → `PLAN_CONFIG` → maxMachines + months

## npm Publishing
- **Scoped package** — `@compr/contextengine-mcp` on npmjs.com
- **BSL-1.1 license** — Business Source License (non-compete clause)
- **Selective files** — only `dist/`, `defaults/`, `skills/`, `examples/` published
- **Bundled defaults** — 30 starter learnings ship with npm

## Deploy Automation
- **Root `deploy.sh`** — unified script: `npm` (publish), `server` (VPS rsync + PM2), `all`
- **VPS auth** — sshpass password-based SSH (key passphrase lost)
- **rsync excludes** — `node_modules/`, `data/`, `delta-modules/` preserved on server
- **Post-deploy** — `npm install` + `npx tsc` + gen-delta on VPS, PM2 restart

## CLI Capabilities (v1.16.0)
- **15 subcommands** — `search`, `list-sources`, `list-projects`, `score`, `list-learnings`, `save-learning`, `save-session`, `load-session`, `list-sessions`, `end-session`, `import-learnings`, `audit`, `activate`, `deactivate`, `status`
- **Session management** — `save-session`, `load-session`, `list-sessions` bring session persistence to CLI (was MCP-only before v1.16.0)
- **End-session protocol** — `end-session` checks uncommitted git changes + doc freshness across all projects, exits code 1 on failures
- **Non-interactive mode** — `--yes` / `-y` flag or piped input (`!process.stdin.isTTY`) auto-accepts all prompts; enables agent automation without `yes |` hacks
- **Import learnings** — `import-learnings <file>` bulk-imports from Markdown or JSON
- **No MCP required** — CLI works standalone, useful as fallback when MCP not connected
- **Learning fallback** — `node dist/cli.js save-learning "rule" -c category -p project --context "..."` when MCP tools unavailable

## Agent Enforcement (v1.16.0)
- **Session nudge** — after every 15 MCP tool calls without `save_session`, appends a reminder to `search_context` and `list_sources` responses
- **Auto-session inject** — on MCP startup, loads the most recent session (<72 hours old) and injects it into search chunks, providing continuity without requiring explicit `load_session`
- **Protocol compliance** — nudge resets when agent calls `save_session`, rewarding good behavior

## Development Patterns
- **Zero-config** — auto-discovers project docs, git context, deps without setup
- **Plugin adapters** — auto-configure Claude Desktop, VS Code, Cursor
- **Append-only store** — learnings in `~/.contextengine/learnings.json`, never overwritten
- **Activation gate** — premium tools check license before execution
- **Offline grace** — 7-day window without heartbeat before lockout
- **Delta modules** — premium code extracted, AES-encrypted per-machine, decrypted at runtime

## Key Learnings Applied
- SSH keys with passphrases block CI/agent automation — use deploy scripts
- `cors({ origin: true })` reflects ANY origin — always use explicit whitelist
- `express-rate-limit` pattern: separate limiter instances per route group
- `better-sqlite3` is synchronous — no async/await needed, simpler error handling
- Heredoc in zsh terminals can corrupt with special characters — use file-based approach
- Stripe apiVersion must match SDK's `LatestApiVersion` type — check `node_modules/stripe/types/lib.d.ts`
- Stripe webhook needs `express.raw()` registered BEFORE `express.json()` middleware
- Session protocol rules in copilot-instructions are necessary but insufficient — agents skip housekeeping under task focus
- Non-interactive CLI detection: `!process.stdin.isTTY || --yes || -y` covers pipes, cron, and CI
- Enforcement nudges in tool responses are more effective than rules in docs — agents actually read tool output

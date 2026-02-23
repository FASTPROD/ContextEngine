# Copilot Instructions — ContextEngine

## Project Context
- **TypeScript MCP Server** — queryable knowledge base for AI coding agents
- **GitHub**: FASTPROD/ContextEngine
- **Version**: v1.18.0
- **Branch**: `main`
- **npm**: `@compr/contextengine-mcp`
- **VS Code Extension**: `css-llc.contextengine` — https://marketplace.visualstudio.com/items?itemName=css-llc.contextengine
- **License**: BSL-1.1 (Business Source License)

## Architecture
- MCP protocol over `stdio` transport — works with Claude Desktop, VS Code Copilot, Cursor, etc.
- **CLI**: 15 subcommands — `search`, `list-sources`, `list-projects`, `score`, `list-learnings`, `save-learning`, `audit`, `activate`, `deactivate`, `status`, `save-session`, `load-session`, `list-sessions`, `end-session`, `import-learnings` (no MCP required)
- Dual search: BM25 keyword (instant) + semantic embeddings (Xenova `all-MiniLM-L6-v2`, ~200ms from cache)
- Sources auto-discovered: `copilot-instructions.md`, `CLAUDE.md`, `SKILLS.md`, `contextengine.json`, session docs
- Operational context: git log, branch, recent commits, file tree, dependency versions
- Learnings store: append-only JSON in `~/.contextengine/learnings.json`
- Plugin adapters: `adapters/` — Claude Desktop, VS Code, Cursor auto-config

## Activation / Licensing System (v1.15.0)
- **Client** (`src/activation.ts`): License validation, AES-256-CBC delta decryption, machine fingerprinting, daily heartbeat
- **Server** (`server/`): Express + SQLite3 + Helmet, port 8010
  - `POST /contextengine/activate` — validate license, return encrypted delta bundle
  - `POST /contextengine/heartbeat` — periodic license re-validation
  - `GET /contextengine/health` — status endpoint
- **Delta modules**: Premium code extracted by `gen-delta.ts` -> encrypted per-machine (key = SHA-256(licenseKey + machineId))
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

### Stripe Payment Integration (Feb 21, 2026)
- **Server module**: `server/src/stripe.ts` — Checkout session creation, webhook handler, license provisioning, email delivery
- **Webhook**: `POST /contextengine/webhook` — receives Stripe events (raw body, registered BEFORE express.json middleware)
- **Checkout**: `POST /contextengine/create-checkout-session` — creates Stripe Checkout URL for a plan
- **Events handled**: `checkout.session.completed` (auto-seed license + email key), `customer.subscription.deleted` (deactivate), `invoice.payment_failed` (log)
- **License email**: HTML template via Gandi SMTP (`mail.gandi.net:465`)
- **Graceful degradation**: Server runs without `STRIPE_SECRET_KEY` — payment endpoints simply not mounted
- **Plans**: Pro ($2/mo, 2 machines), Team ($12/mo, 5 machines), Enterprise ($36/mo, 10 machines)
- **Price IDs**: 6 env vars (`STRIPE_PRICE_PRO_MONTHLY`, `..._ANNUAL`, etc.) — set from Stripe Dashboard
- **License dedup**: If same email+plan already has active license, extends expiry instead of creating duplicate
- **stripe_mapping table**: Tracks `subscription_id → license_id` for cancellation handling
- **⚠ Stripe SDK API version**: Must match `LatestApiVersion` in `node_modules/stripe/types/lib.d.ts` — stripe@14.25 expects `2023-10-16`
- **Pricing page JS**: `server/public/pricing.html` has billing toggle (monthly/annual) + `checkout()` function that POSTs to `/contextengine/create-checkout-session` with `{planKey, successUrl, cancelUrl}` and redirects to Stripe checkout URL
- **Success page**: `server/public/success.html` served at `/contextengine/success` — post-checkout landing with activation instructions
- **Status (Feb 22)**: `stripeEnabled: true` (test key set), but no Stripe prices created yet — checkout returns "Invalid plan" until `STRIPE_PRICE_*` env vars have real price IDs. Products/prices/webhook deferred to STRIPE-BACKEND project.

### Project-Scoped Learnings (v1.18.0 Security Fix)
- **Problem**: `list_learnings` MCP tool, CLI `list-learnings`, and `learningsToChunks()` (search index injection) exposed ALL learnings from ALL projects to any agent — cross-project IP leakage risk
- **Fix**: `listLearnings()` and `learningsToChunks()` now accept `projects?: string[]` param. When provided, only returns learnings matching active workspace project names + universal (no project set) learnings
- **MCP**: `activeProjectNames` state populated from `loadProjectDirs()` during reindex, passed to all learnings calls
- **CLI**: `cliListLearnings()` and `initEngine()` scope by project via `loadProjectDirs()`
- **Result**: 249 total learnings → ~238 visible per workspace (project-specific learnings from other projects hidden)

## Infrastructure
- **Production URL**: `https://api.compr.ch/contextengine/` (live, SSL)
- **Production server**: Gandi VPS `92.243.24.157` (Debian 10 Buster, admin user)
- **SSH**: Password auth — `sshpass -p '<REDACTED_PASSWORD>' ssh -o PubkeyAuthentication=no -o StrictHostKeyChecking=no admin@92.243.24.157` (SSH key passphrase lost)
- **Server path**: `/var/www/contextengine-server/` (code + node_modules + dist/ + delta-modules/)
- **Dist path**: `/var/www/contextengine-dist/` (main ContextEngine compiled output, for gen-delta)
- **Delta modules**: `/var/www/contextengine-server/delta-modules/` — agents.mjs (66.9KB), collectors.mjs (22.3KB), search-adv.mjs (3.6KB)
- **License DB**: `/var/www/contextengine-server/data/licenses.db` (seeded: `CE-F03F-0457-F812-B486`, enterprise, 10 machines, expires 2027-02-20)
- **Process**: PM2 `contextengine-api` on port 8010, managed via `ecosystem.config.cjs`
- **PM2 config**: `/var/www/contextengine-server/ecosystem.config.cjs` — env vars (STRIPE_SECRET_KEY, SMTP_*, PORT). Must use `.cjs` extension (package.json has `"type": "module"`, PM2 require() fails with `.js`). Restart with `npx pm2 restart ecosystem.config.cjs` to pick up env changes, then `npx pm2 save`.
- **Port**: 8010 (localhost only, proxied via nginx)
- **Nginx**: `/etc/nginx/sites-enabled/api.compr.ch` — `proxy_pass http://127.0.0.1:8010` for `/contextengine/`
- **SSL**: Let's Encrypt via certbot, cert at `/etc/letsencrypt/live/api.compr.ch/`, expires 2026-05-22
- **DNS**: `api.compr.ch` A record -> `92.243.24.157` (Gandi DNS)
- **better-sqlite3**: Pinned to v9.4.3 on VPS (g++ 8.3 = C++17 max, v11+ needs C++20)
- **Same VPS as**: admin.CROWLR (Docker PHP 8.2), VOILA.tips (PHP 7.4)
- **CI**: GitHub Actions `.github/workflows/ci.yml` — Node 18/20/22, lint + build + test + smoke
- **Deploy**: `./deploy.sh [npm|server|all]` — dual-mode: npm publish + VPS rsync (sshpass password auth)
- **File transfer workaround**: rsync/scp frequently hang on this VPS. Use `cat local/file | sshpass ... ssh admin@host 'cat > remote/file'` instead. SSH command execution works fine.

### VPS Deployment (2026-02-21)
- rsync'd server/ -> `/var/www/contextengine-server/`, dist/ -> `/var/www/contextengine-dist/`
- `npm install` on VPS (better-sqlite3@9.4.3 pinned for C++17 compatibility)
- `npx tsc` on VPS (cosmetic type errors from missing @types/* — JS emits fine)
- gen-delta: `CONTEXTENGINE_DIST=/var/www/contextengine-dist node dist/gen-delta.js 1.15.0`
- License seeded: `node dist/seed.js yannick@compr.ch enterprise 12`
- Health: `curl https://api.compr.ch/contextengine/health` -> `{"status":"healthy","deltaModules":3,"activeLicenses":1,"stripeEnabled":true}`
- Pricing: `https://api.compr.ch/contextengine/pricing` (live, JS-powered checkout buttons)
- Success: `https://api.compr.ch/contextengine/success` (post-checkout landing page)

## Source Files
| File | Purpose |
|---|---|
| `src/index.ts` | MCP server entry — tool registration, stdio transport |
| `src/cli.ts` | CLI entry — 15 subcommands (search, score, sessions, audit, activate, etc.) |
| `src/search.ts` | BM25 keyword + semantic search, temporal decay, chunk ranking |
| `src/sources.ts` | Auto-discovery of project docs, git context, dependency info |
| `src/learnings.ts` | Append-only learning store, category validation, dedup, project-scoped filtering |
| `src/scoring.ts` | Project health scoring — 12 checks, weighted rubric |
| `src/audit.ts` | Beyond-A+ audit — security, performance, DX, architecture |
| `src/ports.ts` | Port conflict detector across projects |
| `src/embeddings.ts` | Xenova transformer embeddings, disk cache |
| `src/chunker.ts` | Markdown/code-aware chunking with 4-line overlap |
| `src/config.ts` | `contextengine.json` loader, project aliases |
| `src/activation.ts` | License validation, delta decryption, machine fingerprint, heartbeat |
| `server/src/server.ts` | Activation server — Express + SQLite3 + Stripe webhook + rate-limit + CORS + graceful shutdown |
| `server/src/stripe.ts` | Stripe payment — checkout sessions, webhook handler, license provisioning, SMTP email |
| `server/src/seed.ts` | License key generator — `CE-XXXX-XXXX-XXXX-XXXX` format |
| `server/src/gen-delta.ts` | Delta module extractor — reads `CONTEXTENGINE_DIST` env var, falls back to `../../dist` |
| `server/deploy.sh` | Production deploy script — rsync + PM2 + nginx config |
| `server/public/pricing.html` | Pricing page — billing toggle + Stripe checkout JS |
| `server/public/success.html` | Post-checkout success page with activation instructions |
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

## Stats (as of v1.18.0)
- ~9,400 lines of source code (~7,400 src/ + ~1,050 server/ + ~900 vscode-extension/)
- 17 MCP tools (13 free + 4 gated)
- 15 CLI subcommands (10 original + 5 new in v1.16.0)
- 5 direct deps, 2 dev deps, 0 npm vulnerabilities
- 252 learnings across 17 categories in store
- 30 bundled starter learnings ship with npm
- 25 vitest tests (search 11, activation 8, learnings 6)
- ESLint typescript-eslint flat config (0 errors, 36 warnings)
- Keyword search: instant (BM25 with IDF)
- Semantic search: ~200ms from cache, ~15s first run
- CI: GitHub Actions — Node 18/20/22, lint + build + test + smoke
- Score: 89% A (30/30 doc, 22/30 infra, 17/20 quality, 20/20 security)
- VS Code Extension: v0.3.0 published on marketplace (css-llc.contextengine)
- Pricing page: https://api.compr.ch/contextengine/pricing (live, static HTML)
- E2E activation test: ✅ All 4 Pro tools verified, heartbeat confirmed (Feb 21, 2026)

## Critical Rules
1. **NEVER commit `.contextengine/`** — user data directory (learnings, embeddings cache, activation state)
2. **BSL-1.1 license** — non-compete clause: no hosted/SaaS offering using this codebase
3. **Bundled defaults are immutable** — `defaults/*.json` ship with npm; user learnings go to `~/.contextengine/`
4. **Search ranking weights are IP** — do NOT expose exact BM25 tuning, decay constants, or boost factors in docs/README
5. **`contextengine.json` is optional** — all features work via auto-discovery; config only adds aliases and overrides
6. **Skill files follow strict schema** — `SKILL.md` must have `## When to use`, `## Key rules`, `## Examples` sections
7. **server/ is NOT published to npm** — `files` field in package.json restricts to `dist/`, `defaults/`, `skills/`, `examples/`
8. **Never expose scoring internals in README** — exact point values, category weights, anti-gaming methods are trade secrets
9. **SSH to Gandi VPS** — Use `sshpass -p '<REDACTED_PASSWORD>' ssh -o PubkeyAuthentication=no -o StrictHostKeyChecking=no admin@92.243.24.157`. SSH key passphrase is lost. For rsync: exclude `node_modules/`, `data/`, `delta-modules/`.
10. **End-of-session protocol** — before ending ANY session, the agent MUST: (a) update `copilot-instructions.md` with new facts, (b) create/update `SKILLS.md`, (c) call `save_learning` for each reusable pattern, (d) update `SCORE.md`, (e) commit with descriptive message, (f) push to all remotes.
11. **MANDATORY: `save_learning` in real-time** — every reusable pattern, fix, or discovery MUST be saved via `save_learning` tool AS SOON AS it is identified. Do NOT batch them. Do NOT defer to end-of-session. Each learning must be saved within the same turn it is discovered. **If MCP is not connected**, use the CLI fallback: `node dist/cli.js save-learning "rule text" -c category -p project --context "details"` in terminal. NEVER silently skip learnings.

## v1.16.0 — Agent DX Improvements (Feb 2026)
### New CLI Commands (5)
- `contextengine save-session <name> <key> <value>` — persist session data to `~/.contextengine/sessions/`. Supports `--stdin` for piped input.
- `contextengine load-session <name>` — restore a session (was MCP-only before v1.16.0)
- `contextengine list-sessions` — list all saved sessions with entry counts
- `contextengine end-session` — comprehensive pre-flight: (1) git status with branch names, (2) doc freshness (copilot-instructions, SKILLS.md, SCORE.md), (3) learnings stats (total, categories, scoped vs hidden), (4) sessions (count, 3 most recent with age); exits code 1 on failures
- `contextengine import-learnings <file>` — bulk-import learnings from Markdown or JSON

### Non-Interactive Mode
- Detected via `!process.stdin.isTTY || --yes || -y`
- All `init` prompts auto-accept defaults when non-interactive
- Enables agent automation without `yes |` pipe hacks

### Auto-Session Inject (MCP)
- On MCP startup, loads the most recent session (<72 hours old)
- Injects session content into search chunks as searchable context
- Provides continuity without requiring explicit `load_session`

### Enforcement Nudge (MCP)
- Tracks tool call count + whether `save_session` has been called
- After every 15 tool calls without `save_session`, appends a reminder to `search_context` and `list_sources` responses
- At 30 calls, escalates to 🚨 URGENT tone
- Every 2 minutes of tool activity, checks git status across workspace projects and warns about uncommitted changes
- Nudge resets when agent calls `save_session`

### Context-Aware Scoring (v1.16.0)
- Docker/containerization points now check file content quality, not just existence
- Stub Dockerfiles (< 3 effective lines) and empty docker-compose (no `image:` or `build:`) get minimal credit (1 pt vs 5)
- Projects deploying via managed platforms (Vercel, Netlify, Render, Fly) get full infrastructure points without needing Docker
- Prevents agents from creating dummy files to game the score

## VS Code Extension (v0.4.0)
- **Marketplace**: https://marketplace.visualstudio.com/items?itemName=css-llc.contextengine
- **Publisher**: `css-llc` (Azure DevOps org `css-llc`, personal MS account `ymolinier@hotmail.com`)
- **PAT**: stored in Azure DevOps — Marketplace → Manage scope, 1-year expiry
- **Source**: `vscode-extension/` (7 TypeScript source files, ~1,100 lines)
- **Icon**: Red compr.app logo (256x256 PNG, from `COMPR-app/pwa_assets/compr/logo512.png` hue-shifted)

### Extension Architecture
| File | Purpose |
|---|---|
| `vscode-extension/src/extension.ts` | Entry point — activation, command registration, wiring |
| `vscode-extension/src/gitMonitor.ts` | Periodic git status scanning, `GitSnapshot` type, `onSnapshot()` event |
| `vscode-extension/src/statusBar.ts` | `StatusBarController` — persistent CE:N indicator with escalating colors |
| `vscode-extension/src/infoPanel.ts` | `InfoStatusBarController` — ℹ️ icon, WebView panel with monitoring checklist |
| `vscode-extension/src/notifications.ts` | Escalating warning notifications with cooldown |
| `vscode-extension/src/chatParticipant.ts` | `@contextengine` chat participant — `/status`, `/commit`, `/search`, `/remind`, `/sync` |
| `vscode-extension/src/contextEngineClient.ts` | CLI delegation for search/sessions + direct git operations + CE doc freshness |

### Extension Features
- **CE:N status bar** — live count of uncommitted files across all workspace repos (green→yellow→red)
- **ℹ️ info panel** — WebView showing what ContextEngine monitors (7-item checklist with FREE/PRO badges), end-of-session protocol, architecture overview
- **`@contextengine` chat** — Chat Participant with 5 slash commands for agent interaction
- **`/sync` command** — (v0.4.0) Checks CE doc freshness per project, shows which docs are stale or missing
- **Doc staleness notifications** — (v0.4.0) Fires warning when code committed but CE docs not updated (15-min cooldown)
- **`contextengine.sync` command** — (v0.4.0) Output channel report of CE doc freshness with "Open Chat" action
- **Notifications** — Escalating warnings when files are uncommitted (5-min cooldown)
- **Commit All** — One-click commit across all workspace repos

### Pre-Commit Hook (v0.4.0)
- **File**: `hooks/pre-commit` — checks CE doc freshness when code files are staged
- **Behavior**: WARNS (does not block) when copilot-instructions.md, SKILLS.md, or SCORE.md are stale (>4h) or missing
- **Install**: `cp hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`
- **Philosophy**: Event-driven compliance (hooks + extension triggers), not memory-driven (hoping agent remembers)

### Publishing Workflow
```bash
cd vscode-extension
npx @vscode/vsce package        # → contextengine-X.Y.Z.vsix
echo '<PAT>' | npx @vscode/vsce publish  # → marketplace
code --install-extension contextengine-X.Y.Z.vsix  # local test
```

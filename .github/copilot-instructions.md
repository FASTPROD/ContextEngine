# Copilot Instructions — ContextEngine

## Project Context
- **TypeScript MCP Server** — queryable knowledge base for AI coding agents
- **GitHub**: FASTPROD/ContextEngine (PUBLIC repo)
- **Version**: v1.22.0
- **Branch**: `main`
- **npm**: `@compr/contextengine-mcp`
- **VS Code Extension**: `css-llc.contextengine` — https://marketplace.visualstudio.com/items?itemName=css-llc.contextengine
- **License**: BSL-1.1 (Business Source License)

## Architecture
- MCP protocol over `stdio` transport — works with Claude Desktop, VS Code Copilot, Cursor, etc.
- **CLI**: 16 subcommands — `search`, `list-sources`, `list-projects`, `score`, `list-learnings`, `save-learning`, `audit`, `activate`, `deactivate`, `status`, `save-session`, `load-session`, `list-sessions`, `end-session`, `import-learnings`, `stats` (no MCP required)
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
- **Delta modules**: Premium code extracted by `gen-delta.ts`, **obfuscated with terser** (mangle toplevel, 2-pass compress, strip comments), then encrypted per-machine (key = SHA-256(licenseKey + machineId))
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
- **Plans**: Pro (CHF 2/mo, 2 machines), Team (CHF 12/mo, 5 machines), Enterprise (CHF 36/mo, 10 machines)
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
- **SSH**: Password auth — `sshpass -p '<VPS_PASSWORD>' ssh -o PubkeyAuthentication=no -o StrictHostKeyChecking=no admin@92.243.24.157` (SSH key passphrase lost)
- **Server path**: `/var/www/contextengine-server/` (code + node_modules + dist/ + delta-modules/)
- **Dist path**: `/var/www/contextengine-dist/` (main ContextEngine compiled output, for gen-delta)
- **Delta modules**: `/var/www/contextengine-server/delta-modules/` — agents.mjs (35.8KB, obfuscated), collectors.mjs (7.8KB, obfuscated), search-adv.mjs (1.0KB, obfuscated)
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
| `src/cli.ts` | CLI entry — 16 subcommands (search, score, sessions, audit, activate, stats, etc.) |
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
| `src/firewall.ts` | Protocol Firewall — escalating compliance enforcement on all tool responses |
| `server/src/server.ts` | Activation server — Express + SQLite3 + Stripe webhook + rate-limit + CORS + graceful shutdown |
| `server/src/stripe.ts` | Stripe payment — checkout sessions, webhook handler, license provisioning, SMTP email |
| `server/src/seed.ts` | License key generator — `CE-XXXX-XXXX-XXXX-XXXX` format |
| `server/src/gen-delta.ts` | Delta module extractor + terser obfuscation — reads `CONTEXTENGINE_DIST` env var, falls back to `../../dist` |
| `server/deploy.sh` | Production deploy script — rsync + PM2 + nginx config |
| `server/public/pricing.html` | Pricing page — billing toggle + Stripe checkout JS |
| `server/public/success.html` | Post-checkout success page with activation instructions |
| `skills/contextengine/SKILL.md` | Bundled skill file — teaches agents how to use CE |
| `defaults/` | 30 starter learnings shipped with npm |

## MCP Tools Exposed (18 tools)
| Tool | Purpose | Gated? |
|---|---|---|
| `search_context` | BM25 + semantic search across all sources | Free |
| `list_sources` | Show discovered source files + chunk counts | Free |
| `read_source` | Read full content of a discovered source file | Free |
| `reindex` | Force re-discovery and re-indexing of all sources | Free |
| `save_learning` | Store a new operational learning | Free |
| `list_learnings` | Browse learnings by category | Free |
| `delete_learning` | Remove a learning by ID | Free |
| `import_learnings` | Bulk-import learnings from Markdown or JSON files | Free |
| `score_project` | Score project health (12 checks) | Pro |
| `run_audit` | Beyond-A+ audit (security, perf, DX) | Pro |
| `check_ports` | Detect port conflicts across projects | Pro |
| `list_projects` | List all registered projects | Pro |
| `save_session` | Save key-value entry to a named session | Free |
| `load_session` | Restore a saved session | Free |
| `list_sessions` | List all saved sessions | Free |
| `end_session` | End-of-session protocol enforcer | Free |
| `activate` | Activate Pro license on this machine | Free |
| `activation_status` | Check current license status | Free |

## Stats (as of v1.22.0)
- ~12,800 lines of source code (~8,200 src/ + ~1,100 server/ + ~3,500 vscode-extension/)
- 18 MCP tools (14 free + 4 gated)
- 16 CLI subcommands (10 original + 5 new in v1.16.0 + stats in v1.20.0)
- 5 direct deps, 2 dev deps, 0 npm vulnerabilities
- 1,023 learnings across 20 categories in store
- 14 bundled starter learnings ship with npm (trimmed from 30 to prevent dedup re-merge)
- 81 vitest tests across 6 files (search 11, activation 8, learnings 6, cli 8, sessions 16, firewall 36)
- ESLint typescript-eslint flat config (0 errors, 36 warnings)
- Keyword search: instant (BM25 with IDF)
- Semantic search: ~200ms from cache, ~15s first run
- CI: GitHub Actions — Node 18/20/22, lint + build + test + smoke
- Score: 95% A+ (30/30 doc, 25/30 infra, 20/20 quality, 20/20 security)
- VS Code Extension: v0.6.7 published on marketplace (css-llc.contextengine)
- Pricing page: https://api.compr.ch/contextengine/pricing (live, static HTML)
- E2E activation test: ✅ All 4 Pro tools verified, heartbeat confirmed (Feb 23, 2026)
- Protocol Firewall: round-based 3-strike enforcement + auto-inject learnings + cross-window state
- Delta obfuscation: terser mangle+compress, 46-72% size reduction
- Auto-import: learnings extracted from doc sources during reindex + end-session
- Privacy section: README documents local-first architecture, server never receives code/learnings
- Learning quality gates: min 15 chars, auto-categorize "other", import filters (v1.19.1)
- Learnings store: 1,023 quality rules (post-dedup + junk purge)
- GitHub repo: PUBLIC, 9 topics, v1.22.0 release published
- Credentials: extracted to `.copilot-credentials.md` (gitignored, never committed)
- npm: 1,233 weekly downloads

## 🔒 Locked Files — DO NOT Modify Without Explicit User Request
| File | Lock Date | What's Verified | Tests |
|---|---|---|---|
| `src/activation.ts` | 2026-03-03 | License validation, AES-256-CBC delta decryption, machine fingerprint, daily heartbeat | E2E verified Feb 23 2026, all 4 Pro tools |
| `src/firewall.ts` | 2026-03-03 | Protocol Firewall: round-based escalation, auto-inject learnings, cross-window state, 10-min session timer | 36 tests (16 unit + 5 round + 7 injection + 3 cross-window + 5 session timer) |
| `src/search.ts` | 2026-03-03 | BM25 keyword search with IDF, temporal decay, lock marker detection | 11 search tests |
| `src/embeddings.ts` | 2026-03-03 | Xenova all-MiniLM-L6-v2 local CPU embeddings, disk cache, non-blocking startup | Stable since v1.0 |
| `src/learnings.ts` | 2026-03-03 | Learning store: quality gates (min 15 chars), auto-categorize, dedup, project-scoped filtering | 6 learnings tests |
| `src/sessions.ts` | 2026-03-03 | Session persistence: save/load/list/delete, auto-session inject on MCP startup | 16 session tests |

## AI Agent Rework Prevention Protocol
1. **Check the LOCKED FILES table above before editing ANY `src/` file** — if the file is listed, DO NOT modify it unless the user explicitly requests a change to that specific file.
2. **Check the ALREADY IMPLEMENTED table below before implementing ANY feature** — if it's listed, it's done. Do not re-implement, re-audit, or "improve" it.
3. **Read search results carefully** — if a result shows `🔒 LOCKED — DO NOT re-audit`, treat it as read-only context. Do not open the file to fix or improve it.
4. **After completing any new feature**, add `// LOCKED — verified <date> — <description>` at the top of modified files, update the LOCKED FILES table, and add an entry to ALREADY IMPLEMENTED.
5. **If you must modify a locked file** (user explicitly requests it), remove the old lock marker, make the change, add a new lock marker with the current date, and update the LOCKED FILES table.

## Already Implemented — DO NOT Re-implement
| Feature | Version | Date | Files | Status |
|---|---|---|---|---|
| Protocol Firewall (3-strike escalation) | v1.19.0 | Feb 2026 | `src/firewall.ts` | ✅ LOCKED — 31 tests |
| License activation + delta decryption | v1.15.0 | Feb 2026 | `src/activation.ts` | ✅ LOCKED — E2E verified |
| BM25 + semantic hybrid search | v1.0.0 | Jan 2026 | `src/search.ts`, `src/embeddings.ts`, `src/index.ts` | ✅ LOCKED — 11 search tests |
| Learning store + quality gates | v1.19.1 | Feb 2026 | `src/learnings.ts` | ✅ LOCKED — 6 tests |
| Session persistence + auto-inject | v1.16.0 | Feb 2026 | `src/sessions.ts` | ✅ LOCKED — 16 tests |
| Lock marker detection in search | v1.21.2 | Mar 2026 | `src/ingest.ts`, `src/code-chunker.ts`, `src/search.ts`, `src/index.ts` | ✅ 8 patterns, 🔒 prefix |
| Stripe payment integration | v1.19.0 | Feb 2026 | `server/src/stripe.ts`, `server/src/server.ts` | ✅ Webhook + checkout + email |
| VS Code extension (value meter + terminal watcher) | v0.6.7 | Feb 2026 | `vscode-extension/src/` (10 files) | ✅ Published on marketplace |
| Pre-commit secret scanner | v1.21.1 | Feb 2026 | `hooks/pre-commit`, `hooks/pre-commit-secrets` | ✅ 15+ patterns, deployed to 20 repos |
| Cross-window firewall state | v1.21.0 | Feb 2026 | `src/firewall.ts` | ✅ LOCKED — 3 cross-window tests |
| Auto-import learnings from doc sources | v1.19.1 | Feb 2026 | `src/learnings.ts` | ✅ LOCKED — runs during reindex + end-session |
| npm metadata + portfolio links | v1.21.1 | Mar 2026 | `package.json`, `README.md` | ✅ Published to npm |
| A-to-Z audit fixes (12 bugs) | v1.22.0 | Mar 2026 | `src/index.ts`, `src/cli.ts`, `src/firewall.ts`, `src/ingest.ts`, `SKILL.md`, `CLAUDE.md` | ✅ Published to npm |
| 10-min session save timer | v1.22.0 | Mar 2026 | `src/firewall.ts` | ✅ 5 tests, commit/push reminder |

## Critical Rules
1. **NEVER commit `.contextengine/`** — user data directory (learnings, embeddings cache, activation state)
2. **BSL-1.1 license** — non-compete clause: no hosted/SaaS offering using this codebase
3. **Bundled defaults are immutable** — `defaults/*.json` ship with npm; user learnings go to `~/.contextengine/`
4. **Search ranking weights are IP** — do NOT expose exact BM25 tuning, decay constants, or boost factors in docs/README
5. **`contextengine.json` is optional** — all features work via auto-discovery; config only adds aliases and overrides
6. **Skill files follow strict schema** — `SKILL.md` must have `## When to use`, `## Key rules`, `## Examples` sections
7. **server/ is NOT published to npm** — `files` field in package.json restricts to `dist/`, `defaults/`, `skills/`, `examples/`
8. **Never expose scoring internals in README** — exact point values, category weights, anti-gaming methods are trade secrets
9. **Never expose Protocol Firewall internals in README** — exact escalation thresholds, scoring formula, truncation limits, exempt tool list, and cache intervals are trade secrets
10. **SSH to Gandi VPS** — Use `sshpass -p '<VPS_PASSWORD>' ssh -o PubkeyAuthentication=no -o StrictHostKeyChecking=no admin@92.243.24.157`. SSH key passphrase is lost. For rsync: exclude `node_modules/`, `data/`, `delta-modules/`.
11. **AUTOMATIC post-commit checkpoint — DO NOT DEPRIORITIZE** — After EVERY commit+push, the agent MUST AUTOMATICALLY run `end_session` as a verification checkpoint. This is NOT optional cleanup — it IS part of every task. A push without `end_session` verification is an **incomplete task**. The full protocol: (a) update `copilot-instructions.md` with new facts, (b) create/update `SKILLS.md`, (c) call `save_learning` for each reusable pattern, (d) update `SCORE.md`, (e) commit with descriptive message, (f) push to all remotes, (g) run `end_session` to verify nothing was missed. **Known agent bias**: agents optimize for "complete the explicit request" and treat CE protocol as "surrounding discipline" they can skip once todos are marked done. This is wrong — the task is not done until `end_session` passes. The .gitignore gap, the stale doc, the missing learning — these are ONLY caught by `end_session`. Do not wait to be reminded.
12. **Every project workspace needs `.vscode/mcp.json`** — MCP servers are NOT configured globally in VS Code user settings (deprecated). Each workspace must have its own `.vscode/mcp.json` with the ContextEngine stdio config. Without it, agents in that project have zero access to the knowledge base. **MUST use absolute node path** (not bare `node`) to avoid shell-env resolution failures. See admin.CROWLR, FASTPROD, PLANK.io, CROWLR.io, FC_project, COMPR-app, EXO, GOOGLE Analytics, shop.invoc.io for examples.
13. **MANDATORY: `save_learning` in real-time** — every reusable pattern, fix, or discovery MUST be saved via `save_learning` tool AS SOON AS it is identified. Do NOT batch them. Do NOT defer to end-of-session. Each learning must be saved within the same turn it is discovered. **If MCP is not connected**, use the CLI fallback: `node dist/cli.js save-learning "rule text" -c category -p project --context "details"` in terminal. NEVER silently skip learnings.
14. **NEVER write secrets in code or docs** — passwords, API keys, tokens, and credentials must ONLY go in `.copilot-credentials.md` or `.env` (both gitignored). Documentation must use `*(see .copilot-credentials.md)*` placeholders. The pre-commit hook scans for 15+ secret patterns and BLOCKS commits containing them. All 20 git repos have the hook installed. To update patterns, edit `hooks/pre-commit-secrets` and redeploy.
15. **Secret prevention for agents** — when an agent needs to reference a password or key in a command, use environment variables (`SSHPASS='<password>' sshpass -e`) or read from `.copilot-credentials.md`. NEVER hardcode secrets in shell commands that get logged, in markdown docs, or in `copilot-instructions.md`. Use `<VPS_PASSWORD>`, `<STRIPE_KEY>`, `<DB_PASSWORD>` as placeholders. The terminal watcher redacts known patterns but prevention > redaction.
16. **`--no-verify` is FORBIDDEN** — agents must NEVER use `git commit --no-verify` or `git push --no-verify` to bypass pre-commit hooks. If a hook blocks a commit, **fix the issue the hook identified** (update stale docs, remove secrets, etc.), then commit normally. The terminal watcher detects `--no-verify` usage and fires a red alert. GitHub Actions CI also checks doc freshness server-side — `--no-verify` bypasses local hooks but NOT CI. Treating compliance gates as obstacles to route around is a policy violation.
17. **NEVER skip CE checks because "the task is done"** — Completing the user's explicit request is NOT the end of the task. Agents have a documented bias: they mark todos as "completed" after pushing code and mentally treat the work as finished, skipping `end_session`, `score_project`, and doc updates. This is the #1 compliance failure mode. The pattern "commit → push → stop" is ALWAYS wrong. The correct pattern is "commit → push → `end_session` → verify → fix anything it catches → re-commit if needed." Treat `end_session` as automatic as `git push` itself — not something the user has to ask for.

## v1.22.0 — A-to-Z Audit Fixes (Mar 2026)
### Bugs Fixed (12 total)
1. **`generateMcpJson()` broken args** — `node -y` is invalid (`-y` is npx flag). Fixed to use `npx` as command.
2. **McpServer version hardcoded "1.16.0"** — now reads `package.json` at startup via `PKG_VERSION`.
3. **`list_sources` version hardcoded "v1.19.1"** — now uses `PKG_VERSION`.
4. **`activeProjectNames` never set in `main()`** — learnings project scoping was defeated (all learnings visible to all projects). Fixed: set outside `collectOps` block.
5. **`estimateTimeSaved()` always ~6min** — nudges counted as value (3 baseline per session = 3 min inflation). Auto-injected learnings double-counted via `searchRecalls`. Fixed: removed nudge counting, subtract `learningsInjected` from recalls.
6. **`delete_learning` not registered as MCP tool** — imported but `server.tool()` call missing. Now tool #18.
7. **`firewall.setProjectDirs()` skipped when `collectOps=false`** — moved outside condition block in `main()`.
8. **`autoImportFromSources()` not called in `main()`** — only ran during `reindex()`. Now also runs on startup.
9. **Redundant `loadProjectDirs()` calls** — deduplicated: single call shared across ops + code collection.
10. **Dead `accepted` variable in `ingest.ts`** — computed but never used. Removed.
11. **SKILL.md tool count wrong (15→18)** — added `activate`, `activation_status`, `delete_learning`.
12. **License inconsistency** — SKILL.md and CLAUDE.md said "AGPL-3.0" but actual license is BSL-1.1. Fixed.

## v1.19.0 — Protocol Firewall (Feb 2026)
### Architecture
- **File**: `src/firewall.ts` — `ProtocolFirewall` class
- **Design**: Wraps EVERY tool response via `respond(toolName, text, contextHint?)` helper in `index.ts`
- **Replaces**: Old `maybeNudge()` system (only on 2/17 tools, zero consequences)
- **Exempt tools**: Compliance actions (save_learning, save_session, end_session, etc.) pass through unmodified
- **Obligations tracked**: learnings saved, session saved, git status, doc freshness
- **Escalation levels**: silent → footer → header → degraded (output truncation)
- **⚠️ IP PROTECTION**: Do NOT expose thresholds, scoring formula, truncation limits, or exempt tool list in README/docs

### CSP Fix (Pricing Page)
- Helmet default CSP blocked inline scripts — checkout buttons were completely broken
- Extracted `<script>` from pricing.html → `public/pricing.js` (external file)
- Added `express.static` route: `/contextengine/static/` → `public/`
- Configured Helmet CSP directives: `script-src 'self'`, `style-src 'unsafe-inline'`, `connect-src` for Stripe

## v1.21.0 — Auto-Inject Learnings & Cross-Window State (Feb 2026)
### Learning Auto-Injection
- **Mechanism**: `buildLearningInjection()` in `src/firewall.ts` — searches learnings by context hint, prepends top 3 to tool response
- **Callback pattern**: `setLearningSearchFn(fn)` avoids circular imports — index.ts wires up `searchLearnings()` at startup
- **Context hints**: `respond()` passes tool-specific hints (query text, project name, audit scope) to `wrap()`
- **Compartmentalization**: Output separates project-specific learnings (`[Project/category]`) from universal ones (`[category]`)
- **Caching**: Results cached per round (`injectionCache` + `injectionCacheRound`) — same hint in same round = no re-search
- **Tracking**: `learningsInjected` counter exposed in `getState()`, bumps `searchRecalls` for value meter
- **Limit**: `INJECT_MAX = 3` learnings per response

### Cross-Window Firewall State
- **Problem**: Crashed VS Code window restarted MCP → firewall reset to round 0, agent escaped enforcement
- **Fix**: `loadPriorState()` reads `session-stats.json` on construction, resumes round/escalation counters
- **Guards**: Only resumes if prior session was recent (<5 min), different PID (not same process), valid JSON
- **Constructor**: `new ProtocolFirewall({ skipRestore?: boolean })` — testing uses `skipRestore: true`
- **Log**: `[ContextEngine] 🔄 Resumed firewall state from prior session (round N, M rounds since save)`

### Round-Based Escalation (refined)
- Rounds tracked via `ROUND_GAP_MS = 30_000` (30s gap between non-exempt calls = new round)
- `roundsSinceSessionSave` drives escalation: 2=footer, 3=header, 4+=degraded
- `save_session` resets `roundsSinceSessionSave` to 0 and `roundAtLastSave` to current round
- All constants and thresholds are IP-protected (trade secrets)

### Test Coverage
- 31 firewall tests (was 15): 16 unit, 5 round escalation, 7 injection, 3 cross-window
- 76 total tests across 6 files (was 60)

## v1.20.0 — Value Meter & Session Stats (Feb 2026)
### Session Stats File
- **Path**: `~/.contextengine/session-stats.json` — written by firewall, polled by extension
- **Writer**: `flushStats()` in `src/firewall.ts` — debounced every 10s via `scheduleStatsFlush()`
- **Reader**: `StatsPoller` in `vscode-extension/src/statsPoller.ts` — polls every 15s, `isActive` true if updated within 5min
- **Fields**: `toolCalls`, `learningsSaved`, `sessionSaved`, `uptimeMinutes`, `nudgesIssued`, `searchRecalls`, `truncations`, `estimatedTimeSavedMinutes`, `lastUpdated`
- **Time-saved heuristic**: `recall×2min + nudge×1min + save×1min + session×3min` (in `estimateTimeSaved()`)

### CLI `stats` Command
- **Function**: `cliStats()` in `src/cli.ts` — reads `session-stats.json`, prints all metrics with emoji formatting
- **Fallback**: "No active session stats found" if file missing or never written

### VS Code Extension Value Meter (v0.6.0, log dedup v0.6.5)
- **Status bar**: `CE ~12min saved` or `CE 8🔍 3💾` (recalls + saves), falls back to git dirty count when no MCP session
- **Info panel**: 4 big counters (MIN SAVED / RECALLS / SAVED / TOOL CALLS) + detail row (nudges, truncations, uptime)
- **Wiring**: `extension.ts` connects `StatsPoller.onStats` → `statusBar.updateStats()` + `updateInfoPanel()`
- **Log dedup (v0.6.5)**: StatsPoller uses fingerprint comparison (`toolCalls|recalls|saved|timeSaved|nudges|truncations`) — only fires `onStats` when values change. Git scan logging uses `lastGitFingerprint` — only logs when dirty count/projects change. StatusBar per-update logging removed (parent already logs on change).

## v1.19.1 — Auto-Import, Quality Gates & Delta Obfuscation (Feb 2026)
### Learning Quality Gates
- **Constant**: `MIN_RULE_LENGTH = 15` in `src/learnings.ts` — rejects rules shorter than 15 chars
- **saveLearning()**: Throws `Error("Rule must be at least 15 characters")` for short rules; auto-corrects `"other"` category via `inferCategory()`
- **inferCategory()**: New function with 30+ keyword→category mappings (e.g. nginx→infrastructure, React→frontend, SQL→database)
- **MCP handler**: `save_learning` in `src/index.ts` wrapped in try-catch — surfaces rejection message to agent as `❌ Learning rejected: ...`
- **Import filters**: `flushRule()`, `importFromJson()`, `importFromMarkdown()` all enforce MIN_RULE_LENGTH + try-catch to prevent import crashes
- **Purge results**: 1,626 → 1,500 (dedup) → 942 (junk < 15 chars removed), 190 reclassified from "other" to proper categories

### Auto-Import Learnings from Doc Sources
- **Function**: `autoImportFromSources()` in `src/learnings.ts`
- **Trigger**: Called automatically during `reindex()` (MCP startup + file changes) and `cliEndSession()` (CLI end-session)
- **Behavior**: Scans all discovered markdown source files, extracts rules via `importLearningsFromFile()`, dedup built-in
- **Returns**: `{ total, imported, updated }` counts
- **Philosophy**: "needs to be automated - not relying on users or agents!" — user mandate

### Delta Module Obfuscation (terser)
- **File**: `server/src/gen-delta.ts` — added `import { minify } from "terser"`
- **Pipeline**: Read compiled JS → terser minify (mangle toplevel, 2-pass compress, strip comments, module mode) → write .mjs
- **Results**: agents.mjs 46% smaller, collectors.mjs 65% smaller, search-adv.mjs 72% smaller
- **Properties not mangled** (`properties: false`) — required for exported function names to work
- **Manifest**: `obfuscated: true` flag added
- **Deployed**: VPS delta-modules regenerated with obfuscation, PM2 restarted

### Privacy & Data Security (README)
- Added comprehensive section to main README before License
- Two tables: "What stays on your machine" (7 items) + "What the activation server receives" (3 items, PRO only)
- Bold: "The server NEVER receives: project names, file contents, learnings, sessions, git history, dependencies, code, .env variables"
- Extension README links to full details

### GitHub Repository Visibility
- Repo `FASTPROD/ContextEngine` is **PUBLIC** (changed Feb 24, 2026)
- 9 topics: mcp, mcp-server, ai-agents, knowledge-base, vscode, claude-desktop, cursor, typescript, local-first
- v1.19.1 GitHub Release published with release notes

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

## VS Code Extension (v0.6.7)
- **Marketplace**: https://marketplace.visualstudio.com/items?itemName=css-llc.contextengine
- **Publisher**: `css-llc` (Azure DevOps org `css-llc`, personal MS account `ymolinier@hotmail.com`)
- **PAT**: stored in Azure DevOps — Marketplace → Manage scope, 1-year expiry
- **Source**: `vscode-extension/` (10 TypeScript source files, ~1,700 lines)
- **Icon**: Red compr.app logo (256x256 PNG, from `COMPR-app/pwa_assets/compr/logo512.png` hue-shifted)

### Extension Log Dedup (v0.6.5)
- **Problem**: StatsPoller fired `onStats` every 15s even when nothing changed → hundreds of identical `Stats poll:` + `Status bar: stats update` lines in Output. Git scan logged every 120s even when dirty count unchanged.
- **Fix**: Fingerprint-based dedup at the event source:
  - `StatsPoller._lastFingerprint` — string concat of key stats, only fires event when fingerprint differs
  - `extension.ts` `lastGitFingerprint` — only logs git scan when `totalDirty|projectCount|projectNames` changes
  - `StatusBar` — removed per-update `_log?.appendLine()` calls (redundant with parent logging on change)
- **Pattern**: Polling architectures must deduplicate at event source — cheap fingerprint string comparison eliminates 99% of log noise

### Terminal Watcher Categories (v0.6.5)
- 9 categories: git, npm, build, deploy, test, database, python, ssh, other
- v0.6.5 additions: `tsc --noEmit` → build, `npm version` → npm, `code --install-extension` → npm, `npx @vscode/vsce` → npm
- 10 credential redaction patterns (passwords, tokens, API keys, SSH passphrases, vendor key prefixes)
- Stuck-pattern detection: threshold 3 identical commands before alerting

### Extension Architecture
| File | Purpose |
|---|---|
| `vscode-extension/src/extension.ts` | Entry point — activation, command registration, wiring |
| `vscode-extension/src/gitMonitor.ts` | Periodic git status scanning, `GitSnapshot` type, `onSnapshot()` event |
| `vscode-extension/src/statusBar.ts` | `StatusBarController` — value meter (recalls/saves/time saved) with git fallback |
| `vscode-extension/src/infoPanel.ts` | `InfoStatusBarController` — ℹ️ icon, WebView dashboard with live stats + monitoring checklist |
| `vscode-extension/src/notifications.ts` | Escalating warning notifications with cooldown |
| `vscode-extension/src/chatParticipant.ts` | `@contextengine` chat participant — `/status`, `/commit`, `/search`, `/remind`, `/sync` |
| `vscode-extension/src/contextEngineClient.ts` | CLI delegation for search/sessions + direct git operations + CE doc freshness |
| `vscode-extension/src/terminalWatcher.ts` | Terminal command completion monitor — classifies commands, fires notifications, triggers git rescan |
| `vscode-extension/src/statsPoller.ts` | Polls `~/.contextengine/session-stats.json` for live MCP session metrics |
| `vscode-extension/src/outputLogger.ts` | Mirrors OutputChannel to `~/.contextengine/output.log` — enables agent log analysis |

### Output File Logger (v0.6.7)
- **File**: `vscode-extension/src/outputLogger.ts` — `LoggedOutputChannel` class
- **Problem**: VS Code provides no API to read OutputChannel history — agents couldn't analyze Output panel content without user copy-paste
- **Solution**: Wraps `vscode.OutputChannel`, mirrors every `appendLine()` to `~/.contextengine/output.log` with `[HH:MM:SS]` timestamps
- **Log path**: `~/.contextengine/output.log` — readable by agents in ANY project via `read_file`
- **Rotation**: Truncates oldest lines when file exceeds 512 KB (keeps most recent 384 KB)
- **Session markers**: Writes `═══` separator with ISO timestamp on each activation
- **Graceful failure**: If disk write fails, the real OutputChannel still works
- **Debounced writes**: Buffers lines and flushes every 2 seconds to reduce I/O
- **Static accessor**: `LoggedOutputChannel.logPath` returns the file path for logging at startup

### Extension Features
- **Value meter status bar** — (v0.6.0) shows MCP session value: recalls, saves, time saved. Falls back to git status when no session active
- **Live stats dashboard** — (v0.6.0) info panel shows real-time session metrics (tool calls, recalls, nudges, truncations, estimated time saved)
- **Stats poller** — (v0.6.0) reads `~/.contextengine/session-stats.json` every 15s, written by MCP server firewall
- **ℹ️ info panel** — WebView with Protocol Firewall hero (plain-English "speed camera" analogy), escalation flow visualization, live value meter
- **`@contextengine` chat** — Chat Participant with 5 slash commands for agent interaction
- **`/sync` command** — (v0.4.0) Checks CE doc freshness per project, shows which docs are stale or missing
- **Doc staleness notifications** — (v0.4.0) Fires warning when code committed but CE docs not updated (15-min cooldown)
- **`contextengine.sync` command** — (v0.4.0) Output channel report of CE doc freshness with "Open Chat" action
- **Terminal watcher** — (v0.4.0) Monitors command completions via Shell Integration API, fires notifications for git/npm/deploy/build/test, auto-rescans git after commits
- **Notifications** — Escalating warnings when files are uncommitted (5-min cooldown)
- **Commit All** — One-click commit across all workspace repos

### Pre-Commit Hook (v0.4.0, upgraded v1.20.0)
- **File**: `hooks/pre-commit` — checks CE doc freshness when code files are staged
- **Behavior**: **BLOCKS** (exit 1) when copilot-instructions.md, SKILLS.md, or SCORE.md are stale (>4h) or missing. Override: `git commit --no-verify`
- **Rationale**: Agents ignore warnings (exit 0) but cannot bypass blocks — proven across ContextEngine + STRIPE backend projects
- **Validated**: v0.6.5 commit blocked successfully (SKILLS.md + SCORE.md >24h stale) — `touch` + re-commit worked
- **Install**: `cp hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`
- **Philosophy**: Mechanical enforcement > memory-driven compliance. Agents create rules retroactively when caught — only hard gates prevent drift.
- **⚠ zsh `$path` gotcha**: NEVER use `path` as a variable name in zsh scripts — `$path` is a special tied variable to `$PATH` (lowercase array). Overwriting it destroys PATH for the rest of the script. Use `candidate_path` or `file_path` instead.

### Credential Redaction (v0.6.6)
- **Problem**: PGPASSWORD, GROQ_API_KEY, and other secrets visible in plain text in Output panel logs
- **Fix**: Broadened redaction patterns from 8 to 10:
  - `WORD_API_KEY=`, `WORD_SECRET_KEY=`, `WORD_SECRET=`, `WORD_ACCESS_TOKEN=`, `WORD_API_SECRET=` — catches any env var pattern
  - Known vendor key prefixes: `gsk_`, `sk-live_`, `sk-test_`, `ghp_`, `glpat-`, `xoxb-`, `xoxp-` — auto-redacted regardless of context
- **Classification fix**: `.git/hooks/` path operations (cp, chmod, cat) now classified as `[git]` instead of `[other]`
- **Lesson**: Credential redaction patterns must cover `WORD_KEY=value` format, not just `api_key=value`

### MCP Bootstrapping (v0.6.6)
- **Problem**: ContextEngine MCP was only configured in the ContextEngine workspace itself — agents in other projects had zero tools
- **Fix**: Added `.vscode/mcp.json` to all project workspaces: admin.CROWLR, FASTPROD, PLANK.io, CROWLR.io, FC_project, COMPR-app, EXO
- **Critical**: VS Code DEPRECATED `mcp` in user `settings.json` — message: "MCP servers should no longer be configured in user settings"
- **Config location**: `.vscode/mcp.json` per workspace (NOT user settings.json)
- **Template**: `{"servers":{"contextengine":{"type":"stdio","command":"/Users/yan/.nvm/versions/node/v20.19.4/bin/node","args":["/Users/yan/Projects/ContextEngine/dist/index.js"]}}}`
- **⚠ MUST use absolute node path** — bare `node` causes `spawn node ENOENT` when VS Code fails to resolve shell environment

### Multi-Window Output Logs (v0.6.7+)
- **Problem**: Multiple VS Code windows all write to `~/.contextengine/output.log` — stats events looked like dedup failures but were correct per-instance behavior from different windows
- **Fix**: `outputLogger.ts` tags every line with `[wsTag]` derived from first workspace folder name (e.g. `[ContextE]`, `[compR]`, `[no-ws]`)
- **Session marker** also includes `[wsTag]` for disambiguation
- **Lesson**: Shared log files from multiple processes MUST include a source identifier — fingerprint dedup is per-instance, not cross-instance

### MCP Config Schema Fix (v1.20.2)
- **Problem**: `.vscode/mcp.json` used `mcpServers` key — VS Code expects `servers` with `"type": "stdio"`
- **Fix**: Changed key from `mcpServers` → `servers`, added `"type": "stdio"`, lowercased tool name to `contextengine`
- **Workspace settings**: Removed deprecated MCP config from `ContextEngine.code-workspace` `settings.mcp` block
- **README**: Updated Quick Start to recommend per-project `.vscode/mcp.json` instead of global user config
- **Lesson**: VS Code deprecated MCP in user `settings.json` and global `mcp.json`. Per-workspace `.vscode/mcp.json` with `servers` key is the correct location.

### MCP Node Resolution Fix (Feb 27, 2026)
- **Problem**: VS Code intermittently fails to resolve shell environment → `spawn node ENOENT` → MCP server won't start → all chat windows lost
- **Error**: "Unable to resolve your shell environment in a reasonable time" + "The command 'node' needed to run contextengine was not found"
- **Root cause**: VS Code launches MCP servers before nvm/shell init completes — bare `node` command not on PATH
- **Fix**: Changed ALL 9 workspace `.vscode/mcp.json` files to use absolute node path: `/Users/yan/.nvm/versions/node/v20.19.4/bin/node`
- **Also fixed**: 6 workspaces still used old `mcpServers` key (admin.CROWLR, COMPR-app, CROWLR.io, EXO, FC_project, shop.invoc.io); 2 used `npx` (shop.invoc.io, PLANK.io) — all now use `servers` + `type:stdio` + absolute path + local dist
- **Lesson**: NEVER use bare `node` or `npx` in `.vscode/mcp.json` on nvm-managed systems. Always use the absolute path from `which node`. Dev machines should point to local `dist/index.js` (instant startup, always latest), not `npx` (slow, stale).

### Post-Commit Hook
- **File**: `hooks/post-commit` — auto-pushes to `origin` and `gdrive` remotes after every commit
- **Design**: Push runs in background subshell (`( ... ) &`) — commit returns instantly, no terminal tool timeouts
- **History**: Pre-v1.18.1 the hook was synchronous (3-10s blocking), causing VS Code terminal tool "cancelled" reports. Fixed by backgrounding.
- **STRIPE-BACKEND project**: Stripe products/prices/webhook management lives in a separate `~/Projects/STRIPE backend/` project, not in this repo

### Pre-Commit Hook (v0.4.0, upgraded v1.20.0, secret scanner v1.21.1)
- **File**: `hooks/pre-commit` — CE doc freshness + secret scanning. Combined hook for ContextEngine.
- **File**: `hooks/pre-commit-secrets` — standalone secret scanner for non-CE repos
- **Secret patterns**: 15+ regex patterns — Stripe keys, Google API keys, Groq, GitHub PATs, GitLab, Slack, AWS, SendGrid, sshpass, DB passwords
- **Behavior**: **BLOCKS** (exit 1) when staged files contain secrets. Also blocks if `.copilot-credentials.md` is staged.
- **Skip list**: `.copilot-credentials.md`, `.env`, `.env.local`, `.env.example`, `pre-commit` itself
- **Deployed**: All 20 git repos have the secret scanner installed in `.git/hooks/pre-commit`
- **Redeploy**: Update `hooks/pre-commit-secrets`, then run deploy script to copy to all repos
- **git filter-repo**: Feb 28, 2026 — purged `#Crowlr@2023` (23 instances) and `#GandiVps@2026#` from entire ContextEngine history (PUBLIC repo). All commit hashes rewritten. Force-pushed to origin.
- **Validated**: v1.21.1 test commit blocked successfully (sk_live_ pattern matched)
- **Override**: `git commit --no-verify` (requires explicit human decision)

### Publishing Workflow
```bash
cd vscode-extension
npx @vscode/vsce package        # → contextengine-X.Y.Z.vsix
echo '<PAT>' | npx @vscode/vsce publish  # → marketplace
code --install-extension contextengine-X.Y.Z.vsix  # local test
```

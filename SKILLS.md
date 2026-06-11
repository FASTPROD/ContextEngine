# SKILLS.md — ContextEngine

> Development guide for AI agents working on the ContextEngine codebase.

## When to use

- Modifying MCP server tools (20 tools in `src/index.ts` — `delete_session` + `audit_verify` added in 2026-06)
- Updating CLI subcommands (21 commands in `src/cli.ts` — `delete-session`, `audit-export`, `audit-verify`, `export-learnings`, `policy validate|show`, `hook secret-scan|doc-coverage` added 2026-06)
- Changing search/ranking logic (`src/search.ts`, `src/embeddings.ts`)
- Working on the learnings store (`src/learnings.ts`)
- Modifying the activation server (`server/src/server.ts`, `server/src/stripe.ts`)
- Updating the VS Code extension (`vscode-extension/src/`)
- Deploying to VPS or publishing to npm/marketplace

## Key rules

### Architecture
- MCP protocol over `stdio` — no HTTP server in the main package
- Dual search: BM25 keyword (instant) + semantic embeddings (Xenova `all-MiniLM-L6-v2`)
- Sources auto-discovered from 7 file patterns — `contextengine.json` is optional
- Learnings: append-only JSON in `~/.contextengine/learnings.json`
- Delta modules: premium code extracted by `gen-delta.ts`, encrypted per-machine (AES-256-CBC)

### Project-Scoped Learnings (v1.18.0)
- `listLearnings()` and `learningsToChunks()` accept `projects?: string[]`
- Only returns learnings matching active workspace project names + universal (no project)
- MCP: `activeProjectNames` state from `loadProjectDirs()` during reindex
- CLI: `cliListLearnings()` and `initEngine()` scope by project
- **NEVER expose all learnings without project scoping** — cross-project IP leakage risk

### Protocol Firewall (v1.19.0, round-based v1.21.0)
- **File**: `src/firewall.ts` — `ProtocolFirewall` class
- Wraps EVERY tool response via `respond(toolName, text, contextHint?)` helper in `index.ts`
- Replaced old `maybeNudge()` system (only on 2/17 tools, zero consequences)
- Tracks 4 obligations: learnings saved, session saved, git status, doc freshness
- **Interaction rounds**: non-exempt calls >30s apart = new round. Tracks `roundsSinceSessionSave`
- **3-strike session enforcement**: round 1 grace → round 2 footer → round 3 header → round 4+ degraded (truncation)
- **Auto-inject learnings**: `buildLearningInjection()` prepends top 3 relevant learnings to every non-exempt response
  - `setLearningSearchFn(fn)` avoids circular imports — wired in index.ts at startup
  - Context hints passed from tool args (query, project name, audit scope)
  - Separates project-specific (`[Project/category]`) from universal (`[category]`) learnings
  - Cached per round to avoid repeated searches
- **Cross-window state**: `loadPriorState()` reads `session-stats.json` on construction, resumes enforcement after crash
  - Only resumes if prior session <5 min old, different PID, valid JSON
  - `new ProtocolFirewall({ skipRestore: true })` for testing
- Learning warmup: 5 calls (was 10). CALLS_PER_LEARNING: 5 (was 15)
- Compliance-related tools (save_learning, save_session, etc.) are exempt — pass through unmodified
- `save_session` resets `roundsSinceSessionSave` to 0
- `firewall.setProjectDirs()` called during reindex and startup
- **⚠️ TRADE SECRET**: Do NOT expose exact thresholds, scoring formula, truncation limits, exempt tool list, or cache intervals in README/docs
- When modifying firewall: always test with `npx vitest run` — all 76 tests must pass
- The `respond()` helper in `index.ts` is the single integration point — all tools funnel through it

### Learning Quality Gates (v1.19.1)
- **Minimum rule length**: `MIN_RULE_LENGTH = 15` in `src/learnings.ts` — `saveLearning()` throws if rule < 15 chars
- **Auto-categorization**: `inferCategory()` maps 30+ keywords to proper categories when agent sends "other"
- **Import filters**: `importFromMarkdown()` and `importFromJson()` skip rules < 15 chars silently
- **MCP rejection**: `index.ts` `save_learning` handler has try-catch — surfaces rejection message to agents
- All H3 headings, bold bullets, inline-category bullets, and table rows in markdown import check MIN_RULE_LENGTH
- `flushRule()` has its own length check + try-catch to prevent import crashes

### Build & Test
- `npx tsc` — TypeScript compilation (strict mode)
- `npx vitest run` — 76 tests across 6 files (search, learnings, activation, cli, sessions, firewall)
- `npx eslint .` — typescript-eslint flat config
- Tests must pass before any commit

### npm Publishing
- Package: `@compr/contextengine-mcp`
- `npm publish --access public` (prepublishOnly runs `npm run build`)
- `files` field restricts to: `dist/`, `defaults/`, `skills/`, `examples/`
- **Sourcemaps EXCLUDED** from tarball (`!dist/**/*.map` in `files[]` + `dist/**/*.map` in `.npmignore`) — keeps tarball ~28% smaller and removes the de-obfuscation vector
- **No obfuscation step** — `scripts/obfuscate-firewall.mjs` removed in 2026-06 hygiene pass. Sourcemaps shipped alongside used to defeat it instantly; BSL-1.1 is the legal protection. Build is plain `tsc`.
- `server/` is NEVER published to npm

### VPS Deployment
- Credentials in `.copilot-credentials.md` (gitignored)
- rsync/scp hang — use `cat local | ssh 'cat > remote'` instead
- Server path: `/var/www/contextengine-server/`
- Dist path: `/var/www/contextengine-dist/`
- PM2: `ecosystem.config.cjs` (NOT `.js` — ESM incompatibility)
- better-sqlite3 pinned to v9.4.3 (VPS g++ 8.3 = C++17 max)
- After deploy: `npx pm2 restart ecosystem.config.cjs && npx pm2 save`

### VS Code Extension
- Source: `vscode-extension/` — 10 TypeScript files
- Publisher: `css-llc` (Azure DevOps PAT, `ymolinier@hotmail.com`)
- Package: `npx @vscode/vsce package` → `.vsix`
- Publish: `echo '<PAT>' | npx @vscode/vsce publish`
- Extension delegates to CLI — benefits from CLI fixes automatically
- Chat commands: `/status`, `/commit`, `/search`, `/remind`, `/sync`
- Doc freshness: `checkCEDocFreshness()` in contextEngineClient.ts — checks copilot-instructions, SKILLS.md, SCORE.md staleness
- Pre-commit hook: `hooks/pre-commit` — **BLOCKS** (exit 1) when CE docs stale >4h. Bypass exists at git level but is intentionally not advertised in hook output (anti-marketing).
- Terminal watcher: `terminalWatcher.ts` — 9 categories (git, npm, build, deploy, test, database, python, ssh, other), 10 credential redaction patterns, stuck-pattern detection
- Multi-window output.log: `outputLogger.ts` tags lines with `[wsTag]` (workspace name) to disambiguate shared log across windows

### MCP Configuration Per Workspace
- VS Code DEPRECATED MCP in user `settings.json` AND global `mcp.json` — use `.vscode/mcp.json` per workspace
- Schema: `{"servers":{"contextengine":{"type":"stdio","command":"/Users/yan/.nvm/versions/node/v20.19.4/bin/node","args":["..."]}}}` (NOT `mcpServers`)
- **MUST use absolute node path** — bare `node` causes `spawn node ENOENT` on nvm-managed systems
- Also check `.code-workspace` files for deprecated `settings.mcp` blocks — they override `.vscode/mcp.json`
- Without it, agents in that project have zero ContextEngine tools
- Every new project workspace needs this file — the bootstrapping gap means agents can't access the knowledge base that would tell them how to configure it

### Credential Redaction (v0.6.6)
- 10 patterns: WORD_API_KEY=, WORD_SECRET_KEY=, WORD_SECRET=, WORD_ACCESS_TOKEN=, WORD_API_SECRET=, vendor prefixes (gsk_, sk-live_, sk-test_, ghp_, glpat-, xoxb-, xoxp-), Bearer tokens, connection strings
- Always test redaction with real-world Output panel samples — `api_key=` is too narrow, need `WORD_API_KEY=` format
- `.git/hooks/` path operations classified as [git] not [other]

### Activation and licensing (`src/activation.ts` + `src/license-sig.ts` + `server/src/license-sig.ts`)
- **Three free tiers** unlock paid tools: PREMIUM_TOOLS = `score_project`, `run_audit`, `check_ports`, `list_projects`. Everything else is free.
- **PREMIUM_MODULES = `agents` + `search-adv`** only. Collectors deliberately ship to free users (the docstring at the top of `src/activation.ts` documents this — alignment with reality landed in the 2026-06 hygiene pass).
- **Activation flow** (`activate(key, email)`):
  1. POSTs `{key, email, machineId, version, platform, arch}` to `api.compr.ch/contextengine/activate`.
  2. Server validates the license against `licenses.db`, increments activation count, returns `{license, delta}` with the delta modules encrypted (AES-256-CBC; key = SHA-256(licenseKey + machineId), IV per-activation).
  3. Server signs the canonical license payload with **Ed25519** (LOCK `[LICENSE-SIG-SERVER]`); signature is 88-char base64.
  4. Client decrypts + installs delta modules under `~/.contextengine/delta/`, saves the license to `~/.contextengine/license.json`.
- **`loadLicense()` verification** has three outcomes via `verifyLicenseSignature()` in `src/license-sig.ts` (LOCK `[LICENSE-SIG]`):
  - `ed25519` → cryptographically verified, full trust.
  - `legacy-grandfathered` → **NO LONGER REACHABLE since the flag day was hit 2026-06-11 (2.0.1 release).** The 64-char hex shape now returns `ok: false` with a reactivation pointer in the reason string. The `legacy-grandfathered` variant is kept in the type union for backward compat with existing audit log records carrying `activation.legacy_signature` events from before the flag day.
  - reject → forged / tampered / wrong keypair / missing / **legacy SHA-256**. License dropped, `activation.signature_reject` audit event with reason.
- **Public key** is embedded at top of `src/license-sig.ts` (fingerprint `12d0c34c917a47fbed99945d2b7fb439`). Self-hosters override via `CE_LICENSE_PUBLIC_KEY` env var.
- **Private key** lives at `server/.secrets/ed25519-license-private.pem` on dev (gitignored, mode 0600). In production, mounted via `ED25519_PRIVATE_KEY_PATH` or `ED25519_PRIVATE_KEY_PEM` env var.
- **Canonical payload is byte-pinned** — `canonicalPayload()` is duplicated identically in client + server license-sig.ts. Each side has a test asserting a known-input → known-output reference string. Drift between the two is the one thing that silently breaks every license.
- **Deploy runbook**: `docs/deploy/ED25519_MIGRATION.md` covers private-key transfer to VPS, server deploy, live verification, rollback, and flag-day plan for retiring legacy-signature acceptance.
- **Adversarial test coverage** in `tests/license-sig.test.ts` pins the exact privilege-escalation scenarios the 2026-06 audit named: forged enterprise license without signature → rejected; guessed-zero signature → rejected; pro license with plan field rewritten after signing → rejected.

### Audit log (`src/audit.ts`)
- **Hash-chained JSONL** at `~/.contextengine/audit.log`. Each record `{ts, event, actor, payload, prev_hash, hash}`. Genesis hash is 64 zeros.
- **SHA-256 over canonical serialization** `{prev_hash, ts, event, actor, payload}` in that fixed key order. Any historical mutation breaks verification at the mutated index.
- **Compliance basis**: SOC2 CC7.2 (audit logging), ISO 27001 A.12.4.1 (event logs). The audit log is the bedrock for the compliance-report PDF/A export that's coming in P1 #5.
- **Privacy by construction**: records carry metadata only — IDs, categories, projects, lengths. Never the rule text, session value content, or license signature.
- **Wired at boundaries** of LOCKED files (didn't touch the locked algorithms): `learnings.ts` save/delete/import, `sessions.ts` save/delete, `activation.ts` activate/deactivate, `loadLicense()` signature_reject + legacy_signature.
- **`safeAppend()` isolates** audit failures from production hot paths — a failed append logs to stderr only, never throws upward.
- **Env-var injectable path** — `CONTEXTENGINE_HOME` overrides `homedir()/.contextengine`. Tests run in `mkdtempSync()` and never pollute the real `~/.contextengine`.
- **CLI** — `contextengine audit-export [--since DATE] [--until DATE] [--format jsonl|csv]` and `audit-verify` (exit code 2 on broken chain — CI/cron monitoring).
- **MCP tool** — `audit_verify` so agents can self-check.
- **LOCK `[AUDIT-CHAIN]`** protects: canonical serialization, SHA-256 chain, appendAudit-must-throw contract.

### Policy contract & hook checkers (`src/policy.ts` + `src/hooks.ts`)
- **`.contextengine/policy.json`** at repo root is the declarative contract that the policy-driven pre-commit checkers consume. Four sections:
  - `secret_patterns` — id-tagged regex rules (severity `block` | `warn`), optional `paths` glob scoping (e.g. JWT pattern scoped only to `docs/sessions/**/*.md`)
  - `doc_coverage` — source-subtree → doc-section mappings. Replaces the legacy 4-hour wall-clock staleness gate with diff-aware coverage.
  - `deploy_verify_hosts` — production hosts requiring a verification probe within N seconds of `git push`
  - `bypass_tokens` — documented escape hatches with reason + TTL (alternative to undocumented `--no-verify`)
- **CLI**: `contextengine policy validate <file>` (CI-friendly, exit 0/1), `contextengine policy show` (loads the active repo policy and pretty-prints it).
- **CLI hook checkers**: `contextengine hook secret-scan` and `contextengine hook doc-coverage` apply the policy against the staged git diff. Exit 0 clean / 1 on blocking violations. `CE_JSON=1` switches to one-line JSON for CI logs.
- **Redaction contract** (LOCKED in `src/hooks.ts`): `SecretViolation` records carry pattern_id + file + line ONLY. The matched value is NEVER serialized into output. Verified by a grep-the-serialized-output test.
- **Audit integration**: every blocking violation appends a `hook.block` record to `~/.contextengine/audit.log`. Field shape differs per check.
- **No policy file → no-op (exit 0)**. Repos without `.contextengine/policy.json` keep working unchanged; the legacy inline hook still runs its 17 patterns + gitleaks (if installed).
- **Status**: TypeScript path is fully wired into `hooks/pre-commit` (2026-06, part 3). The bash hook detects the CE CLI via `find_ce_cli()` (project-local `node_modules/.bin/contextengine` → global `contextengine` → none). When CLI + `policy.json` are both present, the hook runs the policy-driven scanners in addition to gitleaks (Layer 1) and the inline 17 CE patterns (Layer 3). For doc coverage, the policy-driven check is **authoritative** when a policy exists — the legacy 4h wall-clock check is suppressed (it was the workaround pattern). Repos without a policy keep the legacy 4h check unchanged. Migration is opt-in by authoring `.contextengine/policy.json`.

### Secret Scanner — two layers
- **gitleaks** (optional, recommended): if `command -v gitleaks` resolves, the pre-commit hook runs `gitleaks protect --staged --redact` first. ~150 audited patterns covering Azure, GCP, OpenAI, Anthropic, JWT, SSH keys, npm tokens, etc. Install: `brew install gitleaks` or https://github.com/gitleaks/gitleaks
- **CE in-house patterns** (always): 17 patterns covering Stripe, GitHub, GitLab, Slack, AWS, SendGrid, Square, Google API, Groq + project-specific shapes (`Cr0wlr_Pr0d_`, `C0ldEm@il_`) + the `.copilot-credentials.md` staging guard. Catches the project-shaped secrets gitleaks doesn't know about.
- Both layers can block. Order: gitleaks first (broad), CE patterns second (project-specific). The two are complementary, not redundant.

### Git Hooks & Terminal Patterns
- **Post-commit auto-push to gdrive**: lives in the global git template (`~/.git-template/hooks/post-commit`), NOT in this repo. The CE repo previously carried a 0-byte `hooks/post-commit` file that claimed to do this — removed in the 2026-06 hygiene pass. Don't add it back without making it actually do something.
- Push takes 3-10s → VS Code terminal tool reports "cancelled" — but commit AND push succeed
- **MANDATORY**: After ANY "cancelled" git commit, run `git log --oneline -1` to verify — NEVER re-attempt
- **Pre-commit hook** (`hooks/pre-commit`): **BLOCKS** (exit 1) when code staged but CE docs stale (>4h) or missing. Banner no longer advertises `--no-verify` (anti-marketing — every block teaching its bypass is negative product value).
- zsh script — NEVER use `path` as a variable name (zsh ties `$path` to `$PATH`)
- Use `candidate_path`, `file_path`, etc. instead — overwriting `$path` destroys PATH for the rest of the script

### AUTOMATIC Post-Commit Checkpoint — DO NOT SKIP
- After EVERY `git push`, run `end_session` automatically — this is part of the task, not optional cleanup
- The correct pattern: `commit → push → end_session → verify → fix anything it catches → re-commit if needed`
- The WRONG pattern: `commit → push → stop` (skipping verification)
- **Known agent failure mode**: agents mark todos as "completed" after pushing and mentally treat the task as done, skipping CE checks. This is the #1 compliance gap.
- `end_session` catches: .gitignore gaps, stale docs, missing learnings, uncommitted files, compliance drift
- Do NOT wait for the user to ask. Do NOT deprioritize because "the explicit request is done." The request includes verification.

### Polling & Event Source Dedup (v0.6.5)
- Polling-based architectures (StatsPoller, GitMonitor) must deduplicate at the event source
- Pattern: cheap fingerprint string comparison (`${key1}|${key2}|...`) — only fire events/log when fingerprint changes
- Eliminates 99% of log noise in VS Code Output panel
- Apply to: `onStats` events, git scan logging, status bar updates

### Output File Logger (v0.6.7)
- `LoggedOutputChannel` wraps `vscode.OutputChannel`, mirrors all writes to `~/.contextengine/output.log`
- Agents in any project can `read_file ~/.contextengine/output.log` for terminal/extension activity analysis
- Log has `[HH:MM:SS]` timestamps, session markers (`═══`), auto-rotation at 512 KB
- Debounced writes (2s) — not every appendLine triggers a disk write
- Graceful failure: if logging fails, real OutputChannel still works
- Constructor: `new LoggedOutputChannel(rawChannel)` — drop-in replacement

### Critical Constraints
- **NEVER commit `.contextengine/`** — user data directory
- **BSL-1.1 license** — no hosted/SaaS competitor allowed
- **Search ranking weights are trade secrets** — don't expose in docs/README
- **Scoring internals are trade secrets** — don't expose point values or anti-gaming methods
- **Protocol Firewall internals are trade secrets** — don't expose thresholds, scoring formula, truncation limits, exempt tool list, or cache intervals
- **Skill files require schema**: `## When to use`, `## Key rules`, `## Examples`

## Examples

### Adding a new MCP tool
```typescript
// In src/index.ts — register in the tools array
{ name: "my_tool", description: "...", inputSchema: { ... } }

// Handle in the CallToolRequest handler
case "my_tool": { /* implementation */ }
```

### Adding a new CLI subcommand
```typescript
// In src/cli.ts — add case in the switch
case "my-command":
  await myCommandHandler();
  break;

// Update help text in cliHelp()
```

### Saving a learning programmatically
```typescript
import { saveLearning } from './learnings.js';
await saveLearning({
  category: 'security',
  rule: 'Always project-scope learnings',
  context: 'Prevents cross-project IP leakage',
  project: 'ContextEngine'
});
```

### Deploying a single file to VPS
```bash
# See .copilot-credentials.md for SSH credentials
cat dist/file.js | sshpass -p '<PASSWORD>' ssh -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no admin@92.243.24.157 \
  'cat > /var/www/contextengine-dist/file.js'
```

---
*Last updated: 2026-02-27 — v1.21.0 auto-inject learnings, cross-window state, 76 tests, round-based 3-strike firewall*


## Pre-publish guard (added 2026-06-02)

- **`scripts/check-npm-token-expiry.mjs`** runs from `prepublishOnly` before every `npm publish`.
- **Source of truth**: `.npm-token-meta.json` at repo root. Update its `expiresAt` field every time the token rotates.
- **Exit codes**: 0 = ok (silent green or yellow banner if <14d), 1 = expired (publish blocked), 2 = meta file missing/invalid.
- **Manual run**: `npm run check-token` — useful for cron / pre-flight checks outside publish.
- **Rotation steps**: documented inline in `.npm-token-meta.json` under `rotationNotes` + in `.copilot-credentials.md` § "npm Publishing".

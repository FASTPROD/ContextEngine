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

### MULTI-AGENT COST — read this before fanning out

**Cost follows `calls × context`, not `calls × result`.** Every tool result stays in an agent's
context for the rest of its life, and every later turn re-reads the whole accumulation. A
5,936-line reference file searched 11 times is paid for **11 times inside one agent**.

Measured failure, real run: **300 agents, 21.5M tokens — 7.5% real output, 92.5% context
re-reads.** Median 11 tool calls and 73,675 context tokens per agent, to classify 24 products.

1. **Hand the agent what it needs; do not send it searching.** More than 2 tool calls per agent
   is an alarm, not a plan. Pre-computing the candidate set took one task from 8,984 → 1,932
   tokens per item — **4.6×, same model, same output quality**.
2. **Run ONE unit and read its consumption before scaling.** A quality canary is not a cost
   canary. `74k × 300 = 22M` was visible in two minutes, before spending any of it.
3. **Budget the fleet, not just the prompt.** 40 of 300 agents were lost to the session limit —
   13% of the spend bought nothing.

**Why this is dangerous:** the run looks healthy, the quality canary passes, and nothing in the
output hints at it. Cost has to be measured directly; it never shows up in the result.

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
- Package: `@compr/opscontext-mcp` (the `@compr/contextengine-mcp` name is deprecated and frozen at 1.23.1)
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
- Source: `vscode-extension/` — 11 TypeScript files (added `driftAlertPoller.ts` in 0.11.0)
- Publisher: `css-llc` (Azure DevOps PAT, `ymolinier@hotmail.com`)
- Package: `npx @vscode/vsce package` → `.vsix`
- Publish: `echo '<PAT>' | npx @vscode/vsce publish`
- Extension delegates to CLI — benefits from CLI fixes automatically
- Chat commands: `/status`, `/commit`, `/search`, `/remind`, `/sync`
- Doc freshness: `checkCEDocFreshness()` in contextEngineClient.ts — checks copilot-instructions, SKILLS.md, SCORE.md staleness
- Pre-commit hook: `hooks/pre-commit` — **BLOCKS** (exit 1) when CE docs stale >4h. Bypass exists at git level but is intentionally not advertised in hook output (anti-marketing).
- Terminal watcher: `terminalWatcher.ts` — 9 categories (git, npm, build, deploy, test, database, python, ssh, other), 10 credential redaction patterns, stuck-pattern detection
- Multi-window output.log: `outputLogger.ts` tags lines with `[wsTag]` (workspace name) to disambiguate shared log across windows

#### Drift alert layer (v0.11.0)
- `driftAlertPoller.ts` is a `vscode.Disposable` that tails `~/.contextengine/audit.log` (path resolved exactly like `src/audit.ts auditDir()` — env `CONTEXTENGINE_HOME` override + `homedir()/.contextengine` fallback) on a 15 s interval. Mirrors the `StatsPoller` pattern: immediate-first-poll then `setInterval`, EventEmitter for downstream consumers, dispose-stops-timer-and-emitter.
- Filters to `event === "drift.detected"` records (the same records `opscontext watch` writes via `safeAppend` in `src/detector.ts:387`). For each survivor, calls `NotificationManager.showDriftAlert(rec, opts)` which routes severity → VS Code dialog tier: `info` → info popup, `warn` → warning popup, `critical` → MODAL warning. Three actions: "Show Audit Log" → `contextengine.showDriftLog`, "Mute this kind" → adds `DriftKind` to a persisted mute set, "Dismiss" → no-op.
- Three-layer dedup (priority order): (1) byte-offset cursor persisted in `vscode.ExtensionContext.workspaceState` survives extension reload; (2) per-record hash LRU bounded at 500 catches fs-watch double-fires; (3) per-kind 5 min throttle suppresses non-critical repeats at the popup layer (critical always fires). Setting `contextengine.enableDriftAlerts` (boolean, default `true`) is the drift-specific opt-out — when disabled the poller still tails (EventEmitter still fires for future surfaces) but no popups appear.
- New commands: `contextengine.showDriftLog` (target for the popup's "Show Audit Log" action) + `contextengine.alertHistory` (palette entry, same implementation). Both render the last 200 drift records newest-first to the output channel.
- L1 (CLI watch → audit log) → L2 (this poller) → L3 (NotificationManager → VS Code UI). Before 0.11.0, drift signals were terminal-only or MCP-tool-only.
- **NEVER** touch `terminalWatcher.ts` when editing the drift surface — it observes a disjoint event source (terminal exit codes inside the VS Code process) and never reads `audit.log`. No dedup needed between the two; worst case is a user gets two related popups, which is acceptable.

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
- **Three free tiers** unlock paid tools: PREMIUM_TOOLS = `score_project`, `run_audit`, `check_ports`, `list_projects`. Everything else is free. The list is a re-export of `PREMIUM_TOOL_NAMES` from `src/tools-manifest.ts` (single source of truth that also feeds the VS Code info panel via `~/.contextengine/server-meta.json` — added in 2.1.3 to eliminate display drift on tool count).
- **PREMIUM_MODULES = `agents` + `search-adv`** only. Collectors deliberately ship to free users (the docstring at the top of `src/activation.ts` documents this — alignment with reality landed in the 2026-06 hygiene pass).
- **Activation flow** (`activate(key, email)`):
  1. POSTs `{key, email, machineId, version, platform, arch}` to `api.compr.ch/contextengine/activate`. **🔒 LOCK `[ACTIVATION-PAYLOAD-NO-USAGE-DATA]` (2026-06-24)** — these 6 fields are the COMPLETE payload, by deliberate product commitment. Adding a 7th field that reflects user usage (project paths, prompt text, tool inventory, learning IDs) breaks the marketing-data-isolation promise enshrined in `docs/about.md`. Any future feature that genuinely needs server-side telemetry MUST use a separate per-user opt-in endpoint, never bundle into this hot path.
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
- **🔒 LOCK `[DELTA-VERSION-PIN]` (2026-08-14)** — `loadDeltaModule()` refuses any cached delta whose `manifest.json` version differs from the running package, and reports the mismatch on stderr (`installedDeltaVersion()` exposes the cached value so callers report rather than guess). **Why:** `~/.contextengine/delta/` is written once at activation and never expires. The author's own machine held a **1.19.1** delta under a **2.3.1** package — two months and three sessions of scorer fixes out of date. The old `loadDeltaModule` checked no version at all and imported whatever `.mjs` was on disk, so wiring it up would have run the old scorer inside the new package for every licensed user: no error, no symptom, just quietly wrong scores. **The `[SCORE-CANARY]` cannot catch this** — a stale delta carries its own stale canary and its own stale pins, so it passes against itself. A stale module is an unknown, never a usable one.
- **`rubric.js` must stay in the `gen-delta` bundle** — `agents.mjs` does `import { RUBRIC } from "./rubric.js"`. An incomplete bundle either fails to import or silently resolves against the shipped copy, which would reintroduce exactly the divergence the pin exists to prevent.
- **Load path is still unproven.** `installDelta()` is exercised in production (this machine has a real cached bundle), but `loadDeltaModule()` has never been called by anything — `index.ts` and `cli.ts` import `./agents.js` statically. Before switching to dynamic gated loading: exclude `dist/agents.*`/`dist/rubric.*` from npm `files`, add real tests for install+load, and **re-run `gen-delta` and redeploy first** — otherwise every licensed machine sits on a refused stale delta and loses the PRO tools entirely.

### Audit log (`src/audit.ts`)
- **Hash-chained JSONL** at `~/.contextengine/audit.log`. Each record `{ts, event, actor, payload, prev_hash, hash}`. Genesis hash is 64 zeros.
- **SHA-256 over canonical serialization** `{prev_hash, ts, event, actor, payload}` in that fixed key order. Any historical mutation breaks verification at the mutated index.
- **Compliance basis**: produces evidence aligned with [SOC 2 CC7.2 (change monitoring)](docs/compliance/cc7.2.md) and [ISO 27001 A.12.4.1 (event logging)](docs/compliance/a.12.4.1.md). **Evidence artifacts, not a certification** — OpsContext is not itself SOC 2– or ISO 27001–certified; the log helps a deploying organization's auditor satisfy those controls. The audit log is the bedrock for the compliance-report PDF/A export that's coming in P1 #5.
- **Privacy by construction**: records carry metadata only — IDs, categories, projects, lengths. Never the rule text, session value content, or license signature.
- **Wired at boundaries** of LOCKED files (didn't touch the locked algorithms): `learnings.ts` save/delete/import, `sessions.ts` save/delete, `activation.ts` activate/deactivate, `loadLicense()` signature_reject + legacy_signature.
- **`safeAppend()` isolates** audit failures from production hot paths — a failed append logs to stderr only, never throws upward.
- **Env-var injectable path** — `CONTEXTENGINE_HOME` overrides `homedir()/.contextengine`. Tests run in `mkdtempSync()` and never pollute the real `~/.contextengine`.
- **CLI** — `contextengine audit-export [--since DATE] [--until DATE] [--format jsonl|csv]` and `audit-verify` (exit code 2 on tamper/orphan — CI/cron monitoring; forks warn but exit 0).
- **MCP tool** — `audit_verify` so agents can self-check.
- **Verification classifies three distinct findings** (v2.4.3, `[VERIFY-FORK-IS-NOT-TAMPER]`). The chain is append-only but **not guaranteed strictly linear** — concurrent processes can both append onto the same head, branching it. That is not tampering, and conflating the two once caused `audit-verify` to declare 316,000 valid records unverifiable:

  | Condition | Meaning | Verdict |
  |---|---|---|
  | record's own hash ≠ hash of its content | content was altered | **TAMPER** — `ok:false` |
  | `prev_hash` names a hash absent from the log | history deleted/truncated | **ORPHAN** — `ok:false` |
  | `prev_hash` names a *known earlier* head | two processes appended concurrently | **FORK** — warn, `ok:true` |

  `IntegrityReport` carries `tamperedIndices`, `orphanIndices`, `forkIndices`. Content is hashed against each record's **own** `prev_hash`, so one fork does not cascade into false tamper reports downstream. **Never rewrite the log to linearise forks** — that destroys the evidence the log exists to provide.
- **Head-of-chain read is O(1)** (`[AUDIT-TAIL-READ-IS-O1]`) — a 64 KB tail seek, not a whole-file read. The old full read ran *inside the append lock* at 215 ms on a 120 MB log and grew unbounded; now 0.3 ms.
- **No in-process head cache** (`[AUDIT-HEAD-FROM-DISK]`) — the head is read from disk under the lock on every append. The previous cache guarded itself with an *incremented* byte counter compared against real file size, making correctness depend on arithmetic about bytes we believed we wrote.
- **LOCK `[AUDIT-CHAIN]`** protects: canonical serialization, SHA-256 chain, appendAudit-must-throw contract. **LOCK `[AUDIT-001-WRITE-RACE-FIX]`** protects the cross-process file lock in `appendAudit()`.

### Rule parity (`policy.rule_parity`)
- **Problem it solves**: a rule can be written, reviewed and still be invisible. The trigger case: a multi-agent cost rule lived in `~/.claude/CLAUDE.md`, `AGENT_USAGE.md` and memory — but **not** in `.github/copilot-instructions.md`, which is the only one of those Cursor, Windsurf and Copilot read. No source file changed, so `doc_coverage` could never fire.
- **`doc_coverage` is source → doc. `rule_parity` is doc ↔ doc.** They are not interchangeable (`[RULE-PARITY-IS-DOC-TO-DOC]`).
- **Contract**: if `marker` appears in *any* file of `required_in`, it must appear in *all* of them. Present in none = not adopted yet = pass, unless `always_required: true`.
- **Literal substring, not regex** — a marker is a grep-able tag in the LOCK tradition; a regex would fail open on a typo.
- **Diff-aware** (`[RULE-PARITY-IS-DIFF-AWARE]`): fires only when the commit stages one of the governed docs — the moment parity can break and the author has the context. `--all` audits the whole repo for CI or a deliberate sweep.
- **Reads the INDEX, not the working tree** (`[RULE-PARITY-READS-THE-INDEX]`): a commit records the staged blob. The first implementation read the worktree, so staging a marker's *removal* while the worktree still held it passed the gate. `--all` reads the worktree by design — it answers "is the repo consistent now", not "is this commit consistent".
- **CLI**: `contextengine hook rule-parity [--all]`, `CE_JSON=1` for CI. Blocking violations append a `hook.block` audit record.

**Known limits — it proves presence, not agreement:**
| Case | Behaviour |
|---|---|
| Marker inside a code fence or as a "do not write this" example | Counts as present. Choose markers unlikely to appear in examples. |
| Same marker, contradictory rule text in each file | **Passes.** Parity of presence only; it cannot compare meaning. |
| Rule lives only outside the repo (e.g. `~/.claude/CLAUDE.md`) | Invisible. Only listed repo-relative paths are checked. |

### Policy contract & hook checkers (`src/policy.ts` + `src/hooks.ts`)
- **`.contextengine/policy.json`** at repo root is the declarative contract that the policy-driven pre-commit checkers consume. Five sections:
  - `secret_patterns` — id-tagged regex rules (severity `block` | `warn`), optional `paths` glob scoping (e.g. JWT pattern scoped only to `docs/sessions/**/*.md`)
  - `doc_coverage` — source-subtree → doc-section mappings. Replaces the legacy 4-hour wall-clock staleness gate with diff-aware coverage.
  - `deploy_verify_hosts` — production hosts requiring a verification probe within N seconds of `git push`
  - `commit_message_required` — staged-path → required-commit-message-pattern rules. Fires when a commit touches any matching path AND the commit message does not match `pattern`. Canonical example: `multi-agent-for-shared-infra` requires either `Multi-agent: wf_<id>` (citing a multi-agent diagnostic workflow per `docs/skills/CLAUDE_MULTI_AGENT_PROMPT.md`) OR an explicit `--skip-multi-agent-reason: <reason>` bypass (logged to audit log) before edits to shared production infra (`server/deploy.sh`, `server/ecosystem.config.*`, `**/nginx*.conf`, `compR.fr/deploy*.sh`, `compR.fr/setup-symlink-deploy.sh`). Origin: Session 15 / Sprint 16 — the multi-agent diagnostic (workflow `wdcraou93`) caught 5 design errors + 2 structural blockers in an Option B blue/green rollout that would otherwise have crashed sibling apps on a multi-tenant VPS. Schema lives in `src/policy.ts` (`CommitMessageRequiredSchema`); hook processor implementation is intentionally deferred to a follow-up.
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

## Stack and capabilities reference

_Merged from `.github/SKILLS.md` on 2026-08-14. Two files named SKILLS.md both got indexed and
scored, so an agent searching the knowledge base received two different authoritative-looking
answers with no way to choose. This file wins: the `doc_coverage` policy resolves here and 43
code references already point at it._

### Core Technologies
- **TypeScript** (ES2022, strict mode) — entire codebase, ~9,700 lines
- **MCP Protocol** (Model Context Protocol) — stdio transport, JSON-RPC 2.0, 17 tools
- **Node.js 18+** — ESM modules, native crypto, child_process for git

### Search & NLP
- **BM25** — keyword search with IDF weighting, temporal decay (90-day half-life)
- **Semantic Embeddings** — Xenova `all-MiniLM-L6-v2`, 384-dim vectors, cosine similarity
- **Chunking** — Markdown-aware section splitting with 4-line overlap at boundaries

### Security & Cryptography
- **AES-256-CBC** — delta module encryption (key = SHA-256 of licenseKey + machineId)
- **Machine Fingerprinting** — SHA-256 hash of platform, arch, homedir, username
- **Express Security** — Helmet headers, CORS whitelist, rate limiting (express-rate-limit)
- **Input Validation** — license format regex, charset/length checks on all user input
- **Parameterized SQL** — all SQLite queries use `?` placeholders

### Server & Infrastructure
- **Express 4** — activation/licensing server, 5 endpoints (activate, heartbeat, health, checkout, webhook)
- **SQLite3** (better-sqlite3) — license database, synchronous API
- **PM2** — process manager on Gandi VPS (Debian 10)
- **Nginx** — reverse proxy with path-based routing (`/contextengine/` → port 8010)
- **GitHub Actions CI** — Node 18/20/22 matrix, build + lint + test + smoke
- **Let's Encrypt SSL** — certbot auto-renewal on `api.compr.ch`

### Stripe Payment Integration
- **Stripe SDK v14** — checkout session creation, webhook handler (signature verification)
- **Webhook events** — `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`
- **License provisioning** — auto-seeds license on payment, dedup via email+plan match
- **Email delivery** — Nodemailer v6, Gandi SMTP (`mail.gandi.net:465`), HTML templates
- **Graceful degradation** — server runs without `STRIPE_SECRET_KEY` (payment endpoints not mounted)
- **Plan mapping** — `metadata.plan_key` in Stripe checkout → `PLAN_CONFIG` → maxMachines + months

### npm Publishing
- **Scoped package** — `@compr/opscontext-mcp` on npmjs.com
- **BSL-1.1 license** — Business Source License (non-compete clause)
- **Selective files** — only `dist/`, `defaults/`, `skills/`, `examples/` published
- **Bundled defaults** — 30 starter learnings ship with npm

### Deploy Automation
- **Root `deploy.sh`** — unified script: `npm` (publish), `server` (VPS rsync + PM2), `all`
- **VPS auth** — sshpass password-based SSH (key passphrase lost)
- **rsync excludes** — `node_modules/`, `data/`, `delta-modules/` preserved on server
- **Post-deploy** — `npm install` + `npx tsc` + gen-delta on VPS, PM2 restart

### CLI Capabilities (v1.16.0)
- **15 subcommands** — `search`, `list-sources`, `list-projects`, `score`, `list-learnings`, `save-learning`, `save-session`, `load-session`, `list-sessions`, `end-session`, `import-learnings`, `audit`, `activate`, `deactivate`, `status`
- **Session management** — `save-session`, `load-session`, `list-sessions` bring session persistence to CLI (was MCP-only before v1.16.0)
- **End-session protocol** — `end-session` checks uncommitted git changes + doc freshness across all projects, exits code 1 on failures
- **Non-interactive mode** — `--yes` / `-y` flag or piped input (`!process.stdin.isTTY`) auto-accepts all prompts; enables agent automation without `yes |` hacks
- **Import learnings** — `import-learnings <file>` bulk-imports from Markdown or JSON
- **No MCP required** — CLI works standalone, useful as fallback when MCP not connected
- **Learning fallback** — `node dist/cli.js save-learning "rule" -c category -p project --context "..."` when MCP tools unavailable

### Protocol Firewall (v1.19.0)
- **Replaces** old session nudge system (only on 2/17 tools, no real consequences)
- **Response wrapping** — every tool response passes through `ProtocolFirewall.wrap()` via a central `respond()` helper
- **4 obligations tracked** — learnings saved, session saved, git status, doc freshness
- **Escalating enforcement** — silent → footer reminder → header warning → degraded (output truncation)
- **Exempt tools** — compliance actions pass through unmodified (saving learnings shouldn't be penalized)
- **Context-aware scoring** — Docker points only awarded for real deployment use, not placeholder files; managed platforms (Vercel/Netlify/Render) get full credit

### Development Patterns
- **Zero-config** — auto-discovers project docs, git context, deps without setup
- **Plugin adapters** — auto-configure Claude Desktop, VS Code, Cursor
- **Append-only store** — learnings in `~/.contextengine/learnings.json`, never overwritten
- **Activation gate** — premium tools check license before execution
- **Offline grace** — 7-day window without heartbeat before lockout
- **Delta modules** — premium code extracted, AES-encrypted per-machine, decrypted at runtime
- **Dual doc-path resolution** — agent docs are scored wherever a project keeps them: `resolveDocPath()` in `src/agents.ts` checks `.github/` first (Copilot's official read path), repo root second. `contextengine init` writes `SKILLS.md` at the root, so a `.github/`-only lookup scores existing files as "Missing". LOCK `[DOC-PATH-DUAL]`, 7 tests in `tests/scoring.test.ts`.

### Key Learnings Applied
- SSH keys with passphrases block CI/agent automation — use deploy scripts
- `cors({ origin: true })` reflects ANY origin — always use explicit whitelist
- `express-rate-limit` pattern: separate limiter instances per route group
- `better-sqlite3` is synchronous — no async/await needed, simpler error handling
- Heredoc in zsh terminals can corrupt with special characters — use file-based approach
- Stripe apiVersion must match SDK's `LatestApiVersion` type — check `node_modules/stripe/types/lib.d.ts`
- Stripe webhook needs `express.raw()` registered BEFORE `express.json()` middleware
- A scorer that hardcodes one path for a doc the tool itself writes elsewhere reports "Missing" for files that exist — and the fleet learns to hand-correct the report instead of fixing the scorer
- Absence is not a verdict: `existsSync()` follows symlinks (dangling reads as absent) and `catch { return "" }` makes a failed command read as a clean empty result — both shipped bugs where the tool reported a confident wrong answer instead of "couldn't check"
- A guard written after a failure only stops that failure; a canary that pins every health signal and blocks writes on any drift is what catches the next one — CE's found an unrelated security-check bug on its first run
- Scoping a commit is not scoping a push: `git push` publishes every commit the branch has ahead of origin, so a carefully single-file commit can still publish unrelated work (2026-08-08, `shop.invoc.io`). In this workspace `.git/hooks/post-commit` already auto-pushes — commit and stop

### VS Code Extension (v0.4.1)
- **Marketplace publishing** — `css-llc.contextengine` via Azure DevOps PAT + vsce CLI
- **VS Code API** — StatusBarItem, WebviewPanel, ChatParticipant, EventEmitter, ExtensionContext
- **Git monitoring** — child_process `git status --porcelain` across all workspace repos, periodic timer
- **Status bar** — persistent CE:N indicator with threshold-based coloring (green→yellow→orange→red)
- **Info panel** — WebView HTML/CSS panel with VS Code theme CSS variables, live data injection
- **Chat Participant** — `@contextengine` with 5 slash commands (`/status`, `/commit`, `/search`, `/remind`, `/sync`)
- **Notifications** — escalating warnings with cooldown tracking
- **CLI delegation** — executes ContextEngine CLI for search, sessions, git operations
- **Terminal watcher** — monitors all terminal commands via Shell Integration API, fires notifications on completion
- **Doc freshness** — `/sync` command and notifications when code committed but CE docs not updated
- **Pre-commit hook** — `hooks/pre-commit` warns about stale CE docs (never blocks)
- **Post-commit hook** — `hooks/post-commit` auto-pushes in background subshell (`( ... ) &`)
- **Publishing workflow** — `vsce package` → `.vsix` → `echo PAT | vsce publish` → marketplace
- Session protocol rules in copilot-instructions are necessary but insufficient — agents skip housekeeping under task focus
- Non-interactive CLI detection: `!process.stdin.isTTY || --yes || -y` covers pipes, cron, and CI
- Enforcement nudges in tool responses are more effective than rules in docs — agents actually read tool output
- Protocol Firewall (response degradation) is the only mechanism that makes agents comply — extensions and rules can be ignored
- Helmet default CSP blocks inline scripts — extract JS to external files and configure CSP directives explicitly

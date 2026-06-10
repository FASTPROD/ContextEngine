# Changelog

All notable changes to OpsContext for AI Agents (previously ContextEngine — MCP server + CLI) are documented here.

## [2.0.0] — 2026-06-10 — Strategic pivot to "OpsContext for AI Agents"

**This is a positioning + package-name change. All features carry forward unchanged. No code behavior changes.**

> **Publish status: pending.** Same npm-token blocker as 1.24.0 — token needs to be reissued with publish scope. Once unblocked, publish under the new name as the 2.0.0 release. The old `@compr/contextengine-mcp@1.x.y` line should be `npm deprecate`'d with a one-line pointer at the new package.

### Renamed
- **npm package**: `@compr/contextengine-mcp` → `@compr/opscontext-mcp`. Description updated to reflect ops + compliance positioning. Keywords reordered to lead with `claude-code`, `audit-log`, `compliance`, `soc2`, `iso27001`, `policy-as-code` instead of the generic context/RAG vocabulary.
- **bin entries**: primary binary is `opscontext`; aliases `opscontext-mcp`, `contextengine`, `contextengine-mcp` ship too so existing `.vscode/mcp.json` configs pointing at the old binary names keep working.

### Repositioned (no code change)
- **README headline** rewritten: "OpsContext for AI Agents — the ops + compliance layer Claude Code can't grow natively." The "Why" section now leads with the honest gap (Claude Code reads your code; it cannot see what's running on your servers). All `npx @compr/contextengine-mcp` install commands updated to `@compr/opscontext-mcp`. A migration note at the top of README links the old name.
- **MARKETING.md** header rewritten with the new positioning + the "ContextEngine 1.x → OpsContext 2.0" migration story called out as part of the launch narrative. Install commands swapped. **Reddit post copy not yet rewritten** — those posts framed v1 around "persistent memory + Protocol Firewall"; rewriting the copy for the v2 launch is content-marketing work that benefits from a human voice pass.

### Deliberately NOT changed (scope discipline — preserves user data)
- **Storage paths** stay at `~/.contextengine/` — existing users' learnings, sessions, audit log, embedding cache, license remain accessible without migration.
- **`.contextengine/policy.json` repo path** stays — repos that already authored a policy.json under the contextengine name keep working.
- **`CONTEXTENGINE_HOME` env var** stays — migration to a new env var name is a separate follow-up commit with proper deprecation period.
- **`contextengine.json` config name** stays — same reasoning.
- **TypeScript code identifiers, class names, module names** stay — the rename is external identity only. Internal naming refactor is a separate commit.

### Migration story for users (what to put in npm deprecation notice + README)
- `npm install @compr/opscontext-mcp` is the new install. The 2.0.0 line is functionally identical to 1.24.0 — only the package name and headline change.
- For automated installs (CI configs, MCP client configs), update `@compr/contextengine-mcp` → `@compr/opscontext-mcp` everywhere.
- The bin aliases mean the old `contextengine` / `contextengine-mcp` commands still work if you already have them in scripts.
- Storage paths and policy locations are unchanged, so no data migration is needed.



## [1.24.0] — 2026-06-10 — P0 hygiene + audit log + quick wins + policy foundation + hook migration

> **Publish status: pending.** `npm publish` is currently blocked — the granular token `ContextEngine-Publish-GranularApr2026` returns a 404 PUT (npm's misleading code for "this token lacks publish permission on @compr/contextengine-mcp"). To unblock: log into npmjs.com → Settings → Access Tokens → reissue a granular token with **publish** scope on `@compr/contextengine-mcp`, update `~/.npmrc` + `.copilot-credentials.md` + `.npm-token-meta.json`, then `npm publish --access public`. All code in this release is ready; only the registry push is blocked.

**The pre-pivot release.** Last meaningful release under the `@compr/contextengine-mcp` name; the next major release will ship under the `@compr/opscontext-mcp` name as part of the strategic pivot to "OpsContext for AI Agents" (the ops/compliance layer Claude Code can't grow natively). All features in this release carry forward — only the package name and headline positioning change.

Highlights, in dependency order:

### Added (Ed25519 license signature — P0 #3 part 2)
- **`src/license-sig.ts`** (LOCK `[LICENSE-SIG]`) — Ed25519 verifier on the client. Embeds the production public key (fingerprint `12d0c34c917a47fbed99945d2b7fb439`); self-hosters override via `CE_LICENSE_PUBLIC_KEY` env var.
- **`server/src/license-sig.ts`** (LOCK `[LICENSE-SIG-SERVER]`) — Ed25519 signer on the server. Loads private key from `ED25519_PRIVATE_KEY_PEM` env, `ED25519_PRIVATE_KEY_PATH` env, or `server/.secrets/ed25519-license-private.pem` (default dev path, gitignored). **Refuses to start if the key is missing** — never silently degrades to no-signature mode.
- **`src/activation.ts` `loadLicense()`** — now calls `verifyLicenseSignature()`. Three outcomes:
  - `ed25519` → cryptographically verified, full trust.
  - `legacy-grandfathered` → pre-Ed25519 SHA-256 hash; allowed with a one-line warning so existing licensees don't lose access immediately. Audit event `activation.legacy_signature` recorded.
  - reject → forged / tampered / wrong keypair / missing. License rejected, `activation.signature_reject` audit event recorded with reason.
- **`server/src/server.ts`** — the activate handler now signs the canonical license payload with Ed25519 instead of an HMAC-shaped SHA-256 hash. Signature shape changes from 64-char hex to 88-char base64; the client distinguishes the two.
- **Canonical payload is byte-pinned** — `canonicalPayload()` is duplicated identically in both `src/license-sig.ts` and `server/src/license-sig.ts`. A test on each side asserts a known-input → known-output reference string to catch drift. Without this pin, any drift breaks every license issued after the divergence.
- **14 new license-sig tests** (`tests/license-sig.test.ts`) — canonical payload reference + key-order independence; public-key constant shape + fingerprint; verify ok / wrong-keypair-rejection / payload-tampering / empty-signature / garbage-signature / legacy-grandfathering / env-var override for self-hosters; plus **three adversarial "audit attack" tests** pinning the exact privilege-escalation scenarios the audit named — forged enterprise license without signature, guessed-zero signature, plan field rewritten after signing.
- **End-to-end roundtrip verified** with the actual production keypair: production private signs a payload, production public verifies, tampering with the `plan` field correctly fails verification.
- **`docs/deploy/ED25519_MIGRATION.md`** — full deploy runbook: pre-deploy checklist, private-key transfer, server deploy, live verification, rollback plan, flag-day plan for retiring legacy-signature acceptance.

**Status**: Server code, client code, tests, and migration doc all merged to `main`. **Production server NOT yet deployed.** Awaiting explicit authorization to deploy to `api.compr.ch` per the runbook in `docs/deploy/ED25519_MIGRATION.md`. Existing customers are unaffected until the server is updated; after the server deploys, new activations will be Ed25519-signed and existing pre-Ed25519 licenses will continue to work via the grandfather path until the documented flag day.



### Changed (hook migration — P1 #4 part 3)
- **`hooks/pre-commit`** now invokes the TypeScript policy-driven checkers from part 2 when both a CLI and a `.contextengine/policy.json` are present in the repo. Additive integration — gitleaks + policy scan + inline 17 CE patterns all run as complementary layers, first-to-block wins. For doc coverage, the policy-driven check is **authoritative** when a policy exists; the legacy 4-hour wall-clock check is suppressed (it was the workaround pattern that taught `touch SKILLS.md SCORE.md` as the rational answer).
- **`find_ce_cli()` helper** locates the CLI via `node_modules/.bin/contextengine` (project-local install, preferred) → `command -v contextengine` (global / npm-link). Does NOT fall back to `npx @compr/contextengine-mcp` — cold npx on every commit is ~2-3 s, too expensive for the hot path. Teams that want policy enforcement install CE in node_modules.
- **Repos without `.contextengine/policy.json` keep the legacy path unchanged** — same 17 inline patterns, same 4-hour wall-clock check. Migration is opt-in by authoring a policy file.
- **Legacy error banner gains a one-line migration nudge**: "💡 Author `.contextengine/policy.json` for diff-aware coverage instead of wall-clock staleness." Documents the upgrade path without forcing it.
- **End-to-end smoke-tested three scenarios** in ephemeral repos:
  1. No policy + missing CE docs → legacy 4 h gate blocks. ✓
  2. Policy + JWT-shape token in `docs/sessions/SESSION_99.md` → policy-driven secret-scan blocks (`[block] jwt_in_session_doc at docs/sessions/SESSION_99.md:1`), pattern correctly scoped only to `docs/sessions/**/*.md`. ✓
  3. Policy + clean code → both policy layers print `✅` and commit proceeds. ✓
- **Dogfooded**: `cp hooks/pre-commit .git/hooks/pre-commit` in CE itself; this very commit travels through the new hook end-to-end.

### Added (hook checkers — P1 #4 part 2)
- **`src/hooks.ts`** — TypeScript implementations of the policy-driven gates. Exports `getStagedFiles()` (parses `git diff --cached --unified=0` into structured `{path, addedLines:[{lineNumber, content}]}` records), `runSecretScan(policy, files)` (applies `policy.secret_patterns` with `paths` glob scoping), `runDocCoverage(policy, files, repoRoot)` (diff-aware doc-section coverage), plus a tiny in-house `globToRegExp()` and `hashDocSection()` foundation for the next-iteration anchor-hash check.
- **CLI `contextengine hook <secret-scan|doc-coverage>`** — reads `.contextengine/policy.json` from `git rev-parse --show-toplevel`, applies the relevant checker, exits 0 (clean) or 1 (blocking violations found). `CE_JSON=1` switches to one-line JSON for CI logs. No policy file → no-op (exit 0).
- **`hook.block` audit events** — every blocking violation appends a record to the tamper-evident audit log. Field shape differs per check (secret-scan: pattern_id + file + line; doc-coverage: source_paths + matched_files + requires_section + reason).
- **Redaction contract**: `SecretViolation` records carry the pattern id + file + line only. The matched secret value is NEVER serialized into the violation object, the human-readable output, or the JSON output. Verified by a test that grep-checks the serialized output for the matched substring.
- **25 hook tests** (`tests/hooks.test.ts`) — `globToRegExp` exact matching, `**` directory recursion, `?` single-char, regex meta escaping, anchoring; `runSecretScan` global + scoped patterns + line number reporting + the redaction-contract test; `runDocCoverage` for all four reasons (no rule fires, doc missing, doc staged → pass, doc unstaged → block, multi-rule collection); `hashDocSection` with anchor matching + mutation detection + missing anchor; formatter clean-state lines + JSON parseability; live `getStagedFiles` against an ephemeral git repo built with `mkdtempSync`.
- **LOCK [HOOK-CHECKERS]** block on `src/hooks.ts` — protects the redaction contract and the loud-failure-over-silent-skip principle.

**Smoke-tested end-to-end against CE's own policy** in an ephemeral repo: stage `docs/sessions/SESSION_99.md` with a JWT-shape token → `hook secret-scan` exits 1 with `[block] jwt_in_session_doc at docs/sessions/SESSION_99.md:1` (pattern scoped only to `docs/sessions/**`); stage `src/firewall.ts` without `SKILLS.md` → `hook doc-coverage` exits 1 with "doc file does not exist"; stage `SKILLS.md` alongside → both exit 0.

**Not in this commit** (next sprint): replacing the inline secret patterns in `hooks/pre-commit` with `contextengine hook secret-scan`. The TypeScript path is shippable + dogfoodable now; the bash hook stays as-is so existing installations keep working unchanged. Migration is a separate, fully-tested step.

### Added (policy contract foundation — P1 #4 part 1)
- **`src/policy.ts`** — declarative policy contract for hooks, CC PreToolUse, and future CI templates to consume. Schema v1 with four sections:
  - `secret_patterns` — id-tagged regex rules (severity `block` | `warn`), optional `paths` glob scoping (e.g. JWT pattern only applied to `docs/sessions/**/*.md` — the Apec-leak shape)
  - `doc_coverage` — source-subtree → doc-section mappings. Replaces the legacy 4-hour wall-clock staleness gate with diff-aware coverage.
  - `deploy_verify_hosts` — production hosts requiring a verification probe within N seconds of `git push`. Encodes `CLAUDE.md` "DEPLOY = VERIFY LIVE".
  - `bypass_tokens` — documented escape hatches with reason + TTL. Beats undocumented `touch foo.md` / `--no-verify` workarounds.
- **Zod-based validator** — `validatePolicy()` returns either a typed `Policy` or a structured list of `{path, message}` field-level errors. `parsePolicy()` adds the JSON-parse layer.
- **`loadRepoPolicy(repoRoot)`** — loads `<repo>/.contextengine/policy.json`, returns null when absent (hooks fall back to built-in defaults) or a `ValidationResult` so schema errors surface to the user instead of crashing.
- **CLI** — `contextengine policy validate <file>` and `contextengine policy show` (loads the active repo policy and pretty-prints all four sections with counts). Validate exit 0/1 for CI use.
- **`.contextengine/policy.json`** — CE now dogfoods its own policy. Three secret patterns (JWT-in-session-doc, anthropic, openai), four doc-coverage rules (firewall/activation block, audit/policy warn until SKILLS sections are written), one deploy-verify host (`api.compr.ch`), one bypass token (`emergency_hotfix` with 30-char reason minimum).
- **18 policy tests** (`tests/policy.test.ts`) — minimal-valid + fully-populated acceptance, default severity, default `within_seconds`, version/missing-field rejection, malformed JSON graceful failure, disk integration with `mkdtempSync` isolation, summary formatter.
- **LOCK [POLICY-CONTRACT]** block at top of `src/policy.ts` — version bumps and required-field additions both require migration paths.

**Status**: Schema + loader + validator + CLI ship in this release. **Hook integration (actually consuming the policy from pre-commit / CC hooks / CI templates) is the next sprint** — this release lets teams author + validate + review policies in PR ahead of the wiring.



### Added (quick-wins pass — P0 #4)
- **`contextengine export-learnings`** CLI — `--project NAME [--category CAT] [--format json|markdown] [--include-universal]`. Filters a project's learnings into a self-contained export. Without `--project`, output carries an explicit "ALL projects (warning: cross-project IP)" banner so the user can't accidentally share a consultant's full cross-client store. Closes the consultant/contractor confidentiality gap from the audit.
- **`gitleaks` wrapper** in `hooks/pre-commit` — if the `gitleaks` binary is on `$PATH`, the hook runs `gitleaks protect --staged --redact --no-banner --verbose` first (`~150` industry-standard patterns: Azure, GCP, OpenAI, Anthropic, JWT, SSH keys, npm tokens, etc.). CE's 17 in-house patterns + project-specific shapes (`Cr0wlr_Pr0d_`, `C0ldEm@il_`) and the `.copilot-credentials.md` guard still run after. Two-layer defense; the two are complementary, not redundant. End-to-end tested both branches: gitleaks present → blocks with gitleaks banner; absent → falls through to CE patterns (existing behavior preserved).
- **3 CLI tests** for `export-learnings`: `--help` carries the cross-client warning; `--project <nonexistent>` returns valid empty JSON with the right scope envelope; markdown export without `--project` carries the ALL-projects warning header.

### Changed (quick-wins pass — P0 #4)
- **`@huggingface/transformers` moved to `optionalDependencies`**. Cold install drops by ~427 MB (134 MB transformers + 201 MB onnxruntime-node + 91 MB onnxruntime-web + 1 MB onnxruntime-common). Locked-down npm proxies, air-gapped CI, and free-tier GitHub Actions runners no longer fail at install. BM25 keyword search ships always and is sufficient for most workspaces.
  - When the dep is absent at runtime, `initEmbeddings()` emits an actionable one-shot message pointing to `npm install @huggingface/transformers` and the MCP server keeps serving keyword-only search.
  - Verified end-to-end in a sandboxed install with `--omit=optional`: `npm install` succeeds without HF, MCP server boots cleanly, fallback message renders, BM25 search returns results.



### Added (audit log workstream — P0 #3, part 1 of 2)
- **`src/audit.ts`** — hash-chained JSONL audit log at `~/.contextengine/audit.log`. Every state-changing operation appends one canonically-serialized record with `{ts, event, actor, payload, prev_hash, hash}`. The chain is rooted at a 64-zero genesis hash; each record's hash covers the canonical bytes of itself plus its `prev_hash`, so any historical mutation breaks chain verification at the mutated index.
  - Compliance basis: SOC2 CC7.2 (audit logging), ISO 27001 A.12.4.1 (event logs).
  - Privacy: records carry **metadata only** — IDs, categories, projects, lengths. Never the rule text, session value content, or license signature.
  - `safeAppend()` wrapper isolates audit failures from production hot paths (failed appends log to stderr only — they cannot break a learning save or session write).
  - Paths injectable via `CONTEXTENGINE_HOME` env var so tests run against `mkdtempSync` without touching real `~/.contextengine`.
- **Wired into** `saveLearning`, `deleteLearning`, `importLearningsFromFile` (+ per-entry events from the inner save loop), `saveSession`, `deleteSession`, `activate`, `deactivate`. Aggregate `learning.import` event correlates the batch with its individual `learning.save` records.
- **`audit_verify` MCP tool** — agents can self-check the chain (returns OK + count, or BROKEN + break index + reason).
- **CLI commands** — `contextengine audit-export [--since DATE] [--until DATE] [--format jsonl|csv]` and `contextengine audit-verify` (exit code 2 on broken chain so CI/cron can monitor).
- **19 audit tests** (`tests/audit.test.ts`) — append/genesis hash, multi-record chain linking, payload tampering detection, prev_hash splicing detection, appended-forgery detection, graceful failure on corrupt JSON, range filtering, RFC 4180 CSV escaping. All tests run in isolated `tmpdir()` directories.

### Added (P0 hygiene pass)
- **`delete_session` MCP tool** — registered in `src/index.ts` (was exported but never wired). README claimed 19 tools while only 18 were registered; the tool table is now truthful (20 with `audit_verify`).
- **`delete-session` CLI command** — `npx @compr/contextengine-mcp delete-session <name>`.

### Changed
- **`src/activation.ts` docstring + `PREMIUM_MODULES`** — removed `"collectors"` from the premium-module list. Reality: operational collectors run during reindex for all users (data feeds `search_context` for everyone). PRO gates only the four tools that consume that data (`list_projects`, `check_ports`, `run_audit`, `score_project`). Docstring + COMPETITIVE_ANALYSIS/MARKETING claims now match the code path.
- **MARKETING.md Reddit Post #5** — rewritten to list the actual 19 tools. Dropped 5 fictitious tools (`register_project`, `get_project_context`, `configure_adapter`, `get_skill`, `list_skills`) that were never implemented.
- **`.github/copilot-instructions.md`** — replaced inflated "1,233 weekly downloads" claim with the live npm registry value (95/week as of 2026-06).
- **Hook error banners** (`hooks/pre-commit`, `hooks/pre-commit-secrets`) — removed `Override: git commit --no-verify` line. Hooks should not advertise their bypass.

### Removed
- **Obfuscation pipeline** — `scripts/obfuscate-firewall.mjs`, the `terser` devDependency, and the `&& node scripts/obfuscate-firewall.mjs` build step. The shipped sourcemaps defeated the obfuscation (`firewall.js.map` mapped straight back to `../src/firewall.ts`). BSL-1.1 provides the legal protection layer; obfuscation theater was a build-complexity tax for zero security benefit.
- **Sourcemaps from npm tarball** — added `!dist/**/*.map` to `package.json` `files[]` and `dist/**/*.map` to `.npmignore`. Drops ~50% of published tarball bytes.
- **Stale artifacts**:
  - `src/test.ts` — orphaned dev harness (had previously leaked once in v1.17).
  - `dist/test.{js,d.ts}`, `dist/test-sessions.d.ts` — build leftovers.
  - `score-report.html` — tracked snapshot at a path the code does not write.
  - `hooks/post-commit` — 0-byte file (claimed gdrive auto-push but was empty).
  - `VSCODE_EXTENSION_STEPS.md` — done-status runbook from Feb 2026.

### Notes
- **Audit log = part 1 of P0 #3**. Part 2 (activation `LicenseInfo.signature` Ed25519 verification in `loadLicense()`) is the security/revenue leak fix and remains a separate workstream — requires keypair generation, server-side issuance, and migration of existing licenses.
- **README tool count is now 20** (added `audit_verify`). MARKETING Reddit Post #5 should be re-synced in the next hygiene sweep.

## [1.23.1] — 2026-04-18

### Changed
- **`end_session` skill doc** — `skills/contextengine/SKILL.md` now documents both invocation paths: MCP tool (primary) and CLI fallback `npx @compr/contextengine-mcp end-session` (for Cursor, Copilot, and terminal sessions where MCP is not connected). Matches the Rule 13 pattern already used for `save_learning`.
- Removed hardening prose from post-commit verification section — rule is now actionable in any environment.

## [1.23.0] — 2026-03-17

### Added
- **Content-validated scoring** — `.env.example` now checks for 3+ real env var declarations (not just file existence). `.gitignore` validates essential patterns (.env, node_modules, dist). CI/CD workflows verified for real `run:`/`uses:` actions (empty stubs get partial credit). Directly addresses "you can score A+ with phantom env vars" feedback.
- **"What ContextEngine is NOT" section** in README — honest positioning: not a code quality tool, not required daily, not worth chasing 100%.

### Changed
- **README tagline** — "Persistent memory and mechanical enforcement for AI coding agents" (was "The context layer between your codebase and your AI agent").
- **Why section rewritten** — leads with the 3 proven value layers: persistent memory, mechanical enforcement, structural checklist.
- **Tools table** — 17 → 19 tools (added `delete_session`, `activation_status`).
- **SKILLS.md** — tool count 17→19, command count 15→16.

## [1.22.0–1.22.1] — 2026-03-03

### Fixed
- **A-to-Z audit fixes (12 bugs)** — `generateMcpJson()` broken args, hardcoded versions, `activeProjectNames` never set, `estimateTimeSaved()` inflation, `delete_learning` not registered as tool, `firewall.setProjectDirs()` skipped, `autoImportFromSources()` not called at startup, redundant `loadProjectDirs()` calls, dead `accepted` variable, SKILL.md tool count, license inconsistency (AGPL→BSL-1.1).
- **10-min session save timer** — commit/push reminder with 5 tests.

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

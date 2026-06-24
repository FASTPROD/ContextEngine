# Changelog

All notable changes to OpsContext for AI Agents (previously ContextEngine — MCP server + CLI) are documented here.

## [vscode-ext 0.11.0] — 2026-06-24 — Drift alerts surfaced in VS Code UI (L2 → in-editor gap closed)

Closes the last gap in the L1→L2→L3 drift pipeline:

- **L1 (already shipped, 2.1.0):** `opscontext watch` CLI runs the 8-heuristic drift detector against the live `~/.contextengine/audit.log` and writes `drift.detected` records back into the same log (`src/detector.ts:387` → `safeAppend("drift.detected", ...)`).
- **L2 (NEW — this release):** `vscode-extension/src/driftAlertPoller.ts` tails the audit log on a 15s interval, parses each new `drift.detected` record, dedupes by byte-offset cursor + per-record hash LRU + per-kind time throttle, and forwards survivors to the notification layer.
- **L3 (NEW — this release):** `NotificationManager.showDriftAlert()` routes severity → VS Code dialog tier: `info` → info popup, `warn` → non-modal warning, `critical` → MODAL warning (OS-level interrupt). Each notification offers **Show Audit Log** / **Mute this kind** / **Dismiss** actions.

Before 0.11.0, drift signals fired by the CLI watcher were visible only in the terminal (`opscontext watch --json | log-aggregator`) or via the `drift_status` MCP tool. The VS Code extension had a perfectly good `NotificationManager` for git-dirty escalations and stale-doc warnings, but no surface for drift alerts. So a user with the extension running and the CLI watcher running could have a `silent_failure` or `fabrication_suspect` signal sitting in their audit log for 20 minutes and never see a popup. That's the gap this release closes.

### Added
- **`vscode-extension/src/driftAlertPoller.ts`** — new `vscode.Disposable` that tails `~/.contextengine/audit.log` (resolution mirrors `src/audit.ts auditDir()` — `process.env.CONTEXTENGINE_HOME || homedir()/.contextengine`). Polls every 15 s (mirroring `StatsPoller`'s interval). Persists byte-offset cursor + mute list in `vscode.ExtensionContext.workspaceState` (falls back to `~/.contextengine/vscode-drift-cursor.json` when run outside an extension host — keeps tests + integration scripts honest). Handles audit-log truncation / rotation by resetting the cursor when the file shrinks. Tracks the last 500 seen record hashes as a bounded-LRU safety net for fs-watcher races + partial-line reads.
- **`NotificationManager.showDriftAlert(rec, opts)`** — added to `vscode-extension/src/notifications.ts`. Gated by `contextengine.enableNotifications` (master switch) AND `contextengine.enableDriftAlerts` (new, defaults true — gives users a single-toggle opt-out for drift specifically without losing git-dirty warnings).
- **`contextengine.showDriftLog`** command — registered as the click target for the "Show Audit Log" action on drift-alert popups. Reads `~/.contextengine/audit.log`, filters to `event === "drift.detected"`, renders the last 200 records to the OpsContext output channel newest-first.
- **`contextengine.alertHistory`** command — palette-driven entry point to the same drift history viewer. Two commands, one implementation, so the notification action and the user-facing palette entry can evolve independently.
- **`contextengine.enableDriftAlerts`** setting — boolean, default `true`. Disables ONLY drift surfacing; the poller still tails the log and the in-extension EventEmitter still fires (so future surfaces — info panel, future webview — keep working), but no popups appear.
- **`vscode-extension/src/driftAlertPoller.test.ts`** — first test file inside `vscode-extension/`. Uses a tiny in-file `vscode` mock + Node's built-in `node:assert/strict` + `node:test` so we don't pull a new dev dependency. Covers the four invariants from the spec: (1) synthetic `drift.detected` line → `NotificationManager.showDriftAlert` fired with correct severity + message; (2) second poll on the same line does NOT re-fire (hash dedup); (3) muting a kind suppresses subsequent popups; (4) `dispose()` is clean (timer stopped, cursor persisted, no throws).

### Dedup strategy (in priority order)
1. **Byte-offset cursor** (primary, persisted). Stat the file, read only the tail bytes added since last poll, advance cursor to the last full newline so records never split. Reset to 0 on truncation.
2. **Per-record hash LRU** (in-memory, bounded at 500). Catches fs-watch double-fire + the rare "poll saw a partial line then re-saw the same record after the newline arrived" race.
3. **Per-kind time throttle** (5 min, mirroring `NotificationManager.MIN_INTERVAL_MS`). Non-critical alerts of the same kind within the window are suppressed at the popup layer but still fire the `onDrift` EventEmitter (so the info panel / future webview still updates). `severity === "critical"` bypasses — those are OS-level interrupts.
4. **User mute list** (persisted). Clicking "Mute this kind" on a popup adds the `DriftKind` to a mute set; that kind never surfaces a popup again on this machine until the user removes it (still logged to output channel for auditability).

### No conflict with `terminalWatcher.ts`
The existing `terminalWatcher.ts` notifies on consecutive terminal-command exit-code failures inside the VS Code process. It does NOT read `audit.log` and does NOT write `drift.detected`. The new `DriftAlertPoller` exclusively consumes `event === "drift.detected"` records written by the separate `opscontext watch` CLI. Disjoint event sources, disjoint UI paths, no dedup needed between them.

### Why minor (0.10 → 0.11)
Net-new in-editor capability: a surface that previously had no drift-alert UI now has popup notifications + audit-log viewer commands. No breaking changes — existing commands, settings, chat handle behave identically.

## [chrome-ext 0.1.3] — 2026-06-23 — streaming-dedupe polish (response over-emit fix)

Companion to 2.1.1. Chrome-ext-only release; not on Web Store yet — users reload the unpacked dir.

### Fixed
- **`chrome-extension/src/content/claude.ts`** — single response no longer fires 6× during streaming. Root cause: the dedupe key included `text.length` (`r:${i}:${text.length}:${text.slice(0,64)}`). debounceSettle (750 ms) fired multiple times as Claude's response grew; each settle saw a longer text, so the length-in-key differed, the Set check missed, and the same response re-emitted on every settle observation. Fix: drop length from the key + replace document-wide `anyDone` with a per-block `isBlockDone` that walks up 5 ancestor levels looking for an `action-bar-copy` button. Per-block scoping is critical: while turn N+1 is mid-stream, turn N still has its copy button → document-wide check would emit turn N+1 partial. LOCK `[RESPONSE-DEDUPE]`.
- **`chrome-extension/src/content/chatgpt.ts`** — same bug class fixed in mirror file. `captureResponses` had the same length-in-key pattern; `captureToolCalls` had no done-marker check at all, so tool args streamed → emit on every characterData mutation. Both now use the existing `data-message-author-role="assistant"` turn ancestor + copy button check + prefix-only key. LOCK `[RESPONSE-DEDUPE-CHATGPT]`.

### Process note
- Designed via a Workflow run (`wf_f9bf9bbc-46a`) with 3 parallel design proposals (length-stability, longer-debounce, hybrid-stability) + audit of chatgpt.ts + adversarial verification from 3 lenses (miss responses / dedupe preservation / chatgpt generalization). All 3 verifiers blocked the synthesizer's chosen "two-settle stability gate" design — concrete failure: a stream that finishes generates ONE final settle, not two, so the gate never fires and the response is silently dropped. All three verifiers converged on the same suggested fix (per-block done-marker check). That's what shipped here.
- 8 agents, 236K tokens, ~6.7 min. The adversarial verification phase paid for itself by catching the silent-drop failure mode before it shipped.

## [2.1.1] — 2026-06-23 — Phase 1c: one-command install + Claude Code terminal capture + browser-capture end-to-end

**Published to npm** as `@compr/opscontext-mcp@2.1.1` on 2026-06-23 after end-to-end live verification on the maintainer's machine. Tarball 162.3 kB / 57 files. Latest dist-tag confirmed.

Closes the last surface gap from 2.1.0. Before this patch, "use OpsContext" meant running `nohup npx ...` every time the Mac restarted and hand-editing `~/.claude/settings.json` to wire Claude Code hooks. Now both are single commands. This is the release that lets non-technical users actually adopt OpsContext.

### Browser-capture surface verified live

End-to-end verified on the maintainer's machine 2026-06-23: prompts typed on https://claude.ai land in `~/.contextengine/audit.log` as `browser.prompt` events, Claude's responses land as `browser.response` events. Required several mid-day fixes (Chrome MV3 module-import bug, selector drift on Anthropic's DOM, React-clear race on input intercept). All fixed in companion `@compr/opscontext-chrome@0.1.2` (repo-only, unpacked install).

### Added
- **`src/install-autostart.ts`** (LOCK `[AUTOSTART-INSTALL]`) — installs a macOS LaunchAgent at `~/Library/LaunchAgents/com.opscontext.mcp.plist`. Set-and-forget — server starts at every login, KeepAlive restarts on crash, logs to `~/.contextengine/logs/mcp-{stdout,stderr}.log`. Companion `uninstall-autostart` + `autostart-status` commands. Auto-detects either a global npm install or a dev tree; pins node path absolutely (launchd has no PATH).
- **`src/install-claude-hook.ts`** (LOCK `[CLAUDE-HOOK-INSTALL]`) — copies `defaults/claude-code-hook.sh` to `~/.claude/hooks/opscontext-emit.sh` and splices three entries into `~/.claude/settings.json` under `hooks`: `UserPromptSubmit` → `vscode.prompt_submit`, `PostToolUse` (`.*` matcher) → `vscode.tool_call`, `SessionStart` → `vscode.session_start`. **Idempotent + preserves every existing hook entry** (backs up settings.json before any change). Closes the terminal-side capture gap — every Claude Code session in any project now feeds the audit log.
- **`defaults/claude-code-hook.sh`** — the actual shell hook: ~3 KB, pure bash + jq + curl, ~28 ms latency per invocation, **silent on every failure** (never blocks Claude Code), 1-second hard timeout on the HTTP call. Posts to `127.0.0.1:7842/events` with shared secret in `X-OpsContext-Secret` header. LOCK `[OPSCONTEXT-CC-HOOK]`.
- **New CLI subcommands:**
  - `opscontext install-autostart [--force]`
  - `opscontext uninstall-autostart`
  - `opscontext autostart-status`
  - `opscontext install-claude-hook`
  - `opscontext uninstall-claude-hook`

### Fixed
- **`chrome-extension/src/options/options.html`** — Secret field placeholder said `32 hex chars` but the actual secret is 64 hex (256-bit). Updated to `64 hex chars` to match what `init-extension-secret` writes. No backwards-compat issue — placeholder text only, not validation.
- **`chrome-extension` content scripts now bundled as IIFE** (companion `@compr/opscontext-chrome@0.1.1`). The MV3 manifest can't put `"type": "module"` on `content_scripts` entries — only on `background`. The previous build shipped `dist/content/claude.js` with top-level `import` statements which Chrome silently rejected, dark-launching the entire capture surface (Options page still saved the secret fine because popup/options DO support modules via inline `<script type="module">`). New `scripts/bundle-content.mjs` runs esbuild after `tsc` to inline all `./shared/*` and `../lib/*` imports into a single IIFE per content entry. LOCK `[CONTENT-SCRIPT-BUNDLE]`. Reload the unpacked extension after rebuild for the fix to take effect.

### Why this matters
- Before: `nohup npx -y --package=@compr/opscontext-mcp@2.1.0 -- opscontext > /tmp/opscontext-mcp.log 2>&1 < /dev/null &` every reboot, plus hand-editing JSON for Claude Code hooks. Friction kills adoption.
- After: `opscontext install-autostart && opscontext install-claude-hook`. Two commands, ever. Server auto-starts at login forever; terminal Claude Code sessions feed audit log automatically.

### Architecture notes
- Hook namespace stays `vscode.*` (not `claude_code.*`) so the published 2.1.0 detector heuristics fire today without a parallel namespace migration. `payload.surface = "claude-code"` disambiguates source for any caller that cares.
- LaunchAgent uses `gui/$UID` domain (per-user, no root) — same pattern as the user's existing `com.invocme.backup-*` plists.
- Hook deliberately emits on PostToolUse ONLY (not PreToolUse) — emitting both would double-count for the `stuck` heuristic and skew `silent_failure` counts.
- All transport via HTTP `POST /events` not direct file writes — keeps event writes serialized through the running MCP server's single in-process chain cache, sidestepping the historic concurrent-write race (8 chain breaks on 2026-06-10/11, all `system` actor, all pre-flag-day; zero breaks since).

### Known surface gaps still open
- `Stop` hook event not emitted (would enable "assistant gave up mid-task" detection — Phase 3.1).
- No Linux support yet for `install-autostart` (systemd --user unit equivalent is ~30 min of work).
- No tool-result exit codes from VS Code extension yet (candidate for vscode-ext 0.10).

## [2.1.0] — 2026-06-23 — Phase 1: cross-surface capture + drift detector + local event ingest

The first feature release after the OpsContext rebrand. Closes the wedge the audit identified: **no other tool captures AI interactions across browser + IDE + terminal and feeds them into a tamper-evident audit log with policy enforcement**. Now we do.

### Added
- **`src/http-server.ts`** (LOCK `[HTTP-EVENT-INGEST]`) — local event-ingest HTTP endpoint at `http://127.0.0.1:7842`. The browser extension and the VS Code extension POST batched events here; the MCP server validates and appends them to the existing hash-chained audit log via `safeAppend()`.
  - `POST /events` — schema-validated batched events (max 50 events, 64 KB body). Event-kind allowlist: `^(browser|vscode|cli)\.` — system kinds like `learning.save` can only come from the local writer, never the network. Auth via shared 32-byte hex secret at `~/.contextengine/extension-secret` (mode 0600), compared in constant time.
  - `GET /health` — unauthenticated liveness probe.
  - Bound to `127.0.0.1` ONLY — never `0.0.0.0`. LAN devices cannot inject audit events.
  - Hot-reload of the secret on every request — `init-extension-secret --force` rotates without restarting MCP.
  - Started automatically at MCP boot. Gracefully degrades on port conflict (`OPSCONTEXT_EVENT_PORT=<n>` to override).
- **`src/detector.ts`** (LOCK `[DRIFT-HEURISTICS]`) — 8-heuristic drift / loop / fabrication detector.
  - **loop** (warn): same prompt sent 3+ times in 5 min (Jaccard > 0.6 token overlap)
  - **stuck** (warn): identical tool call 3+ times in 5 min
  - **context_bloat** (warn): session > 80K tokens with no `session.save` event
  - **fabrication_suspect** (critical): assistant response cites `file.ext:NN` that doesn't exist on disk
  - **drift** (info): per-session, last 3 prompts have joint Jaccard < 0.10 against the session's first prompt
  - **no_insight** (info): 30+ tool calls since the last `learning.save`
  - **silent_failure** (critical): same tool returns error 3+ times in 5 min
  - **stale_doc_signal**: stubbed (Phase 3.1; reads `policy.json` `doc_coverage`)
  - `watchAuditLog()` uses `fs.watch` + 250 ms debounce + in-memory LRU dedupe (100 entries) so the same signal doesn't fire every poll cycle.
  - Auto-emits `drift.detected` audit records for each fired signal — alerting itself is auditable.
- **`contextengine watch`** CLI — streams alerts as they fire. Supports `--json` (NDJSON for log aggregators), `--severity info|warn|critical` (floor filter), `--once` (single-scan exit, code 2 if any critical signal — usable in CI), `--window SECONDS`.
- **`contextengine init-extension-secret`** CLI — generates a 32-byte hex secret at `~/.contextengine/extension-secret` (mode 0600). Refuses by default if one already exists (`--force` to rotate).
- **`contextengine emit-event <kind> <payload-json> [--actor NAME]`** CLI — appends a single event to the audit log. Used by the VS Code extension `0.9.0` for `vscode.prompt_submit` and `vscode.tool_call` events. Also useful for custom integrations and scripted tests.
- **`drift_status` MCP tool** — agents can call this between major task phases to self-check active signals. Returns "pause and surface to the human" guidance if any critical signal is active.

### Audit-log event types added (additive — no breaking changes)
- `browser.prompt`, `browser.response`, `browser.tool_call`, `browser.session_start`, `browser.session_end`, `browser.capture_miss`
- `vscode.prompt_submit`, `vscode.tool_call`, `vscode.session_start`
- `drift.detected`, `notification.fired`

### Tests
- **14 new tests** in `tests/detector.test.ts` with 11 hand-written NDJSON fixtures in `tests/__fixtures__/audit-logs/`. One catalog test per heuristic + its negative ("similar prompts" fires loop; "different prompts" doesn't). Plus 2 integration tests on `detect()` and evidence cap.
- **196 / 196 tests passing total** (was 182).

### Companion release
- **`@compr/opscontext-chrome@0.1.0`** — new Chrome extension scaffold under `chrome-extension/`. Captures Claude.ai + ChatGPT prompts/responses/tool-calls, streams them via the new `POST /events` endpoint. Not yet on the Chrome Web Store; loadable unpacked via `chrome://extensions` → Developer mode → "Load unpacked" → pick `chrome-extension/dist/`. BSL-1.1 license; selector seeds attributed to MIT prior art in `chrome-extension/LICENSE_THIRD_PARTY.md`.
- **`css-llc.contextengine@0.9.0`** — VS Code extension companion release that emits `vscode.prompt_submit` and `vscode.tool_call` events into the audit log via the new `emit-event` CLI.

### Day-1 test plan
[`docs/test-plans/PHASE1_DAY1.md`](docs/test-plans/PHASE1_DAY1.md) — 10-step, ~15-minute end-to-end verification. Starts with `init-extension-secret`, ends with deliberate `fabrication_suspect` + `silent_failure` triggers verifying `watch` exits code 2.

## [2.0.2] — 2026-06-11 — HTML score report browser tab title → OpsContext

Tiny patch release. One change:
- `src/agents.ts` `generateScoreHTML()` — `<title>` tag changed from `ContextEngine Score Report` to `OpsContext Score Report`. Visible in the browser tab when a paying user (or the `score --html` CLI flag) generates the report. No functional change.

Why patch: cosmetic-only rename of a user-visible string. No new APIs, no contract changes, no behavior change for any caller.

Paired with the VS Code extension `0.8.1` release that adds the `OpsContext: Generate HTML Score Report (PRO)` command — together they close the visible-paid-feature gap from the 2.0.0 rebrand (advertised "HTML score reports — ✓" but no clickable path).

## [2.0.1] — 2026-06-11 — Flag day reached early + pricing href fix

### Changed
- **Legacy SHA-256 license signatures are now REJECTED** (the "flag day" originally scheduled for 2026-08-15). Brought forward to today because the production licence DB analysis showed the customer base is effectively empty — the only real active license belongs to the maintainer, who has already re-activated to Ed25519. Three other "active" rows in the DB are licenses that expired 2026-04-27 and are already failing the expiry check on every load. Bringing the flag day forward by ~10 weeks costs nothing real and removes the half-open security loophole sooner.
  - `src/license-sig.ts` `verifyLicenseSignature()` — the 64-char hex branch now returns `{ ok: false, reason: "Legacy SHA-256 ... reactivate at ..." }` instead of `{ ok: true, mode: "legacy-grandfathered" }`.
  - LOCK comment on the file updated: the flag-day-reached marker replaces the warning-about-grandfathering text.
  - `src/activation.ts` `loadLicense()` — the `if (verify.mode === "legacy-grandfathered")` branch is now defensive dead code (kept since the union type still carries the variant for backward compat with audit-log records).
  - `tests/license-sig.test.ts` — the test that previously asserted `mode: "legacy-grandfathered"` now asserts `ok: false` with a reactivation pointer in the reason. Test renamed `REJECTS legacy SHA-256 hex signature (flag day reached 2026-06-11)`.
- **Pricing URL href fix** in 5 source files. The user-facing strings referenced `https://compr.ch/contextengine/pricing` which returns 404; only `https://api.compr.ch/contextengine/pricing` resolves. Files: `src/activation.ts:145, 450`, `src/cli.ts:1882`, `src/index.ts:1132, 1170`.
- **`docs/deploy/ED25519_FLAG_DAY.md`** can now be archived — the action it scheduled was completed today. Leaving the file in place as a historical record.
- **`server/deploy.sh` hardened** (this was committed earlier as `bbeffe8`, but tying it to the release for context): pre-flight builds locally, smoke-tests `/health` after deploy and dies on broken state, uses the full PM2 path that actually works in non-interactive ssh shells. Supports `--dry-run`.

### Why this is patch-level, not minor
The behaviour change is a tightening of a check that was documented as temporary from day one. The semver contract said legacy signatures would be rejected after the flag day; the date moved up because the situation allowed it. No new features. No removed APIs.

### Notes
- 4 paying-customer rows in the activation DB; 1 is real and active (maintainer's enterprise license, already re-activated). The other 3 already expired April 27 and are non-active per the client's expiry check.
- Customer notification email (originally scheduled for 2026-08-08) skipped — would have been a no-op or a re-engagement note to the two `gmail.com` addresses whose licenses expired. Yannick can send re-engagement separately if he wants.



## [2.0.0] — 2026-06-10 — Strategic pivot + Claude Code native integration (A+B+C)

### Added (Claude Code integration — A + B + C from the rebrand backlog)
- **`opscontext install-skill [--global | --project] [--force]`** — copies the bundled OpsContext skill into Claude Code's skills directory (`~/.claude/skills/opscontext/` global or `<cwd>/.claude/skills/opscontext/` project). Claude Code surfaces it via native skills loading; no MCP roundtrip needed for the skill metadata itself. Default scope: project if `<cwd>/.claude/` exists, else global. Refuses to overwrite without `--force`.
- **`opscontext sync-claude-md [--path FILE] [--dry-run]`** — maintains an idempotent managed block in CLAUDE.md with the OpsContext snapshot: top 5 project learnings (with IDs + categories) + active policy summary (counts per section + first 5 secret-pattern IDs) + last 3 `hook.block` events from the audit log. The block is delimited by canonical `<!-- BEGIN: managed by OpsContext (...) -->` / `<!-- END: managed by OpsContext -->` markers — repeated runs replace the block in place without disturbing surrounding content. **Killer feature**: Claude Code loads CLAUDE.md natively at every session start, so the snapshot reaches the agent's context with zero MCP calls.
- **Claude Code auto-memory discovery** — `loadSources()` now indexes every `~/.claude/projects/*/memory/*.md` file as a knowledge source. `search_context` finds anything the user told Claude Code to remember; cross-project lookup just works. Opt out via `OPSCONTEXT_SKIP_CLAUDE_MEMORY=1` env var (used by the test suite + air-gapped runs where `~/.claude/` is unreadable).
- **`src/claude-integration.ts`** (LOCK `[CLAUDE-INTEGRATION]`) — the canonical home for all three. Locked at the managed-block marker format and at the redaction contract (no sensitive payload content ever rendered into CLAUDE.md, since CLAUDE.md is committed to git).
- **23 new tests** in `tests/claude-integration.test.ts` covering all three:
  - `installSkill`: bundled-missing rejection, fresh install, already-installed reporting, `--force` overwrite, `locateBundledSkill` path walking.
  - `buildManagedBlock`: marker wrapping, project name, learning list with ID+category, long-rule truncation, policy summary with all four section counts, no-policy hint, recent-blocks date prefix.
  - `syncClaudeMd`: creates-when-missing, appends-when-no-markers, replaces-in-place, **true idempotency** (two consecutive runs produce byte-identical output, including the trailing-newline convention).
  - `discoverClaudeMemory`: empty-when-absent, multi-project discovery, .md-only filter, skip-no-memory-subdir.
  - `decodeClaudeProjectSlug`: leading-hyphen → slash, non-prefixed pass-through.
- **Dogfooded**: this commit ran `node dist/cli.js install-skill --project --force` (installing the skill into `.claude/skills/opscontext/`) and `node dist/cli.js sync-claude-md` (appending the OpsContext snapshot to CE's existing CLAUDE.md without disturbing the top-of-file content).

### Renamed
- **`skills/contextengine/` → `skills/opscontext/`** (with `git mv` for clean history). Frontmatter `name:` updated to `opscontext`, `homepage:` updated to the new npm URL, description reframed to lead with "ops + compliance layer Claude Code can't grow natively". The skill content body still mentions ContextEngine in places — copy refresh is a content-marketing pass, not a code fix.

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
  - Compliance: produces evidence aligned with SOC 2 CC7.2 (change monitoring) + ISO 27001 A.12.4.1 (event logging). **Evidence artifacts, not a certification** — OpsContext is not itself SOC 2– or ISO 27001–certified. (Wording updated 2026-06-23, Session 12 H4 sweep.)
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

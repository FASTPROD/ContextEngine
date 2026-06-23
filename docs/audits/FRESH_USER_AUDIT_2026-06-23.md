# OpsContext Fresh-User Audit — 39 Findings Synthesized

**Summary:** 36 unique issues across 3 install surfaces and Web Store pack; 4 true blockers gate first-event success, all in install docs or VS Code one-click flow; biggest cross-cutting themes are publisher-identity drift and "describes features it doesn't ship."

---

## Deduplication Notes

The following findings collapsed into single root-cause items:

- **Binary-name confusion + `cd ..` mystery + version drift** (3 findings) → single "chrome-extension/README is structurally broken" item, since they share the same fix (rewrite README around `opscontext` binary + parent-build prerequisites).
- **Capture-before-consent + `opt-in` lie + queued events transmitted on first valid secret** (Findings 21 + 28) → single "DEFAULT_CONFIG captures-by-default" defect; one code change fixes both the CWS deceptive-description risk and the privacy surprise.
- **Popup grey-forever + dead ternary + raw `Failed to fetch`** (Findings 25, 27, 30) → single "popup state machine never produces actionable state for fresh users" item; all three fix in the same `service-worker.ts` refactor.
- **Identity sprawl + domain sprawl + compliance "grade" wording** (Findings 32, 36, 38) → single "publisher trust collapse" item.
- **Compliance claims as facts + acronym soup** (Findings 33, 34) → kept separate (different audiences, different fixes).

---

## Blockers (ship-stops — must fix before any public CWS submission or marketplace push)

### B1. chrome-extension build fails on first run for any fresh clone
**Lenses:** install-chromeext (Findings 2, 3)
**Files:** `/Users/yan/Projects/ContextEngine/chrome-extension/scripts/bundle-content.mjs:30`, `/Users/yan/Projects/ContextEngine/chrome-extension/package.json:22-26`, `/Users/yan/Projects/ContextEngine/chrome-extension/README.md:17-26`
**Root cause:** `bundle-content.mjs` resolves `esbuild` from the parent `node_modules` via `createRequire` rooted at `../package.json`, but chrome-extension/package.json lists zero esbuild dependency AND the README never instructs the user to `npm install` in the parent. Step 2 of the README then `cd ..`s and runs `node dist/cli.js init-extension-secret` against a parent `dist/` that is gitignored and was never built. Two compounding silent failures in the first three commands.
**What to do this sprint:** (1) Add `"esbuild": "^0.27.0"` to `chrome-extension/package.json` devDependencies so chrome-extension is self-contained. (2) Update `bundle-content.mjs:30` to resolve esbuild from its own package.json, not the parent. (3) Rewrite chrome-extension/README.md install block as a single canonical path using the published npm CLI: `npm install -g @compr/opscontext-mcp && opscontext init-extension-secret && opscontext install-autostart`, then `cd chrome-extension && npm install && npm run build`, then "Load unpacked → chrome-extension/dist". Remove the `node dist/cli.js` form entirely.

### B2. VS Code one-click setup has zero Node.js precheck and chains 3 commands behind `&&`
**Lenses:** install-vscode (Findings 10, 11, 14, 19)
**Files:** `/Users/yan/Projects/ContextEngine/vscode-extension/src/extension.ts:706-731`, `/Users/yan/Projects/ContextEngine/src/install-autostart.ts:160-170`
**Root cause:** The flagship "OpsContext: Set up" command sends `npm install -g @compr/opscontext-mcp && opscontext install-autostart && opscontext install-claude-hook` straight to a terminal. No `which node` check, no EACCES detection, no per-step success capture, no rollback, no idempotency check. On stock macOS (target persona: vibe coder) step 1 fails with `zsh: command not found: npm`; on nodejs.org `.pkg` installs step 1 fails with EACCES; on re-run after partial success step 2 fails with `plist already exists`. The user is left at a `$` prompt with red text and no extension-level signal.
**What to do this sprint:** Rewrite the setup command as a `vscode.window.withProgress` orchestrator that: (1) pre-checks `which node && which npm` via `cp.execFile`, modal-prompting "Install Node.js from nodejs.org?" with an `openExternal` button if missing; (2) hits `http://127.0.0.1:7842/health` first — if 200, short-circuit with "Already installed" instead of re-running; (3) runs each step as a separate `cp.execFile` with stdout captured to an OpsContext output channel, with progress messages "Downloading OpsContext (1/3)…" etc.; (4) uses `vscode.window.onDidEndTerminalShellExecution` (already imported in `terminalWatcher.ts:168`) to detect per-step exit codes; (5) on success shows ONE modal with action buttons `[Open claude.ai]` `[Try @contextengine in Copilot Chat]` instead of the current "wait for the Web Store" dead-end echo. Also add an "OpsContext: Uninstall" command so users can retry cleanly.

### B3. Main README has zero pointer to browser capture or `init-extension-secret`
**Lenses:** install-chromeext + first-event-path (Findings 1, 24)
**Files:** `/Users/yan/Projects/ContextEngine/README.md` (entire 470-line file)
**Root cause:** Root README never mentions `chrome-extension/`, `opscontext init-extension-secret`, `opscontext install-autostart`, port 7842, or claude.ai/chatgpt capture. The Quick Start jumps from `npx @compr/opscontext-mcp init` directly to MCP-client wiring. A user installing from npm has no signpost to browser capture or to the local HTTP endpoint they need to start. (Severity downgraded from blocker per the verdict — the MCP-only path still delivers a working tool — but kept here because it gates the entire browser-capture funnel.)
**What to do this sprint:** Add a `## Step 3 — capture browser + Claude Code events` section to README.md immediately after the existing MCP wiring steps. Three subsections: (a) Browser capture: `opscontext init-extension-secret` → "see chrome-extension/README.md for unpacked install (Web Store coming)"; (b) Auto-start: `opscontext install-autostart` (macOS) + `curl http://127.0.0.1:7842/health` as verification; (c) Claude Code hook: `opscontext install-claude-hook`. Add a `## Browser Capture` one-paragraph teaser higher up. Also have `opscontext init` (the npm quick-start) detect missing extension-secret and print a one-line nudge.

### B4. Chrome Web Store short description advertises features the extension does not implement
**Lenses:** cws-reviewer (Finding 20)
**Files:** `/Users/yan/Projects/ContextEngine/docs/CHROME_WEBSTORE_SUBMISSION.md:38`
**Root cause:** Short description says "Local-first browser capture for OpsContext: tamper-evident audit log, drift detection, MCP companion." Grep of `chrome-extension/src/` shows zero drift detection, zero hash-chaining (lib/types.ts comment confirms "the server adds prev_hash + hash"), and the extension is a capture tool, not an MCP server. Those features live in the companion npm package. CWS reviewers will flag under Single Purpose AND Deceptive Behavior — both are high-probability rejection reasons.
**What to do this sprint:** Replace the short description with: *"Captures your Claude.ai and ChatGPT prompts and responses to a local audit log on your own machine. Local-first. No cloud, no signup."* (132 chars, under the 132-char CWS limit). Move "tamper-evident audit log / drift detection / MCP companion" into the detailed description under a clearly labeled `### Companion server (separate install)` section. Cross-check PRIVACY.md § 1 wording.

---

## High Severity

### H1. DEFAULT_CONFIG enables capture before user consent — contradicts CWS listing and creates a privacy surprise
**Lenses:** cws-reviewer + first-event-path (Findings 21, 28)
**Files:** `/Users/yan/Projects/ContextEngine/chrome-extension/src/lib/types.ts:57-58`, `/Users/yan/Projects/ContextEngine/chrome-extension/src/background/service-worker.ts:98-101`, `/Users/yan/Projects/ContextEngine/docs/CHROME_WEBSTORE_SUBMISSION.md:74`
**Root cause:** `DEFAULT_CONFIG.captureClaudeAi: true, captureChatGptCom: true`. The CWS listing says "Opt-in per-domain capture." Content scripts capture from page load before the user has even opened Options. The SW enqueues these events (service-worker.ts:170 always calls `enqueue()` before secret-check); when the user later pastes a secret, the queued pre-consent events transmit. CWS User Data Policy violation + real privacy surprise.
**What to do this sprint:** Flip `DEFAULT_CONFIG.captureClaudeAi` and `captureChatGptCom` to `false`. Have the Options page Save flip them to `true` and show a first-run popup nudge "Capture is paused — open Options to enable on Claude.ai/ChatGPT." In `service-worker.ts:onMessage`, when `!config.secret` drop the event instead of enqueueing, and set `lastError = 'Capture paused — paste secret in Options to enable.'`. This single change fixes the CWS deceptive-description risk AND the privacy-surprise defect.

### H2. Popup state machine produces "loading…" / undisambiguated red for every fresh-user failure
**Lenses:** first-event-path (Findings 25, 27, 30)
**Files:** `/Users/yan/Projects/ContextEngine/chrome-extension/src/background/service-worker.ts:90-103, 134-139, 149-154`, `/Users/yan/Projects/ContextEngine/chrome-extension/src/popup/popup.ts:14-22`, `/Users/yan/Projects/ContextEngine/chrome-extension/src/popup/popup.css:11-15`
**Root cause:** Three compounding defects in one state machine. (1) `persistStatus()` is called only from inside `flush()` AFTER the `q.length === 0` early return, so a fresh user with no events ever sees `status: null` → grey "loading…" forever, and the "No secret configured" branch is unreachable. (2) Line 151 has a dead ternary `queueLength > 0 ? 'error' : 'error'`. (3) CSS maps `dot--unauthenticated` and `dot--error` to the same red, so "never pasted a secret" and "fetch failed" look identical. (4) Catch block at line 134 stores raw `'Failed to fetch'` with no remediation hint.
**What to do this sprint:** Single refactor in `service-worker.ts`: (a) call `persistStatus(await getConfig())` at SW startup AND at the top of `flush()` BEFORE the empty-queue return; (b) fix line 151 to `if (lastError) return 'error';`; (c) in the catch block, when `err.message` matches `/Failed to fetch|NetworkError|ECONNREFUSED/i`, set `lastError = 'Cannot reach OpsContext server at <endpoint>. Run \`opscontext autostart-status\` in a terminal.'`. In `popup.css:11-15`, give `dot--unauthenticated` its own blue color and add an inline CTA "Paste secret in Options →". Drop the unused `paused` state from the `CaptureStatus` union (or actually implement it after H1).

### H3. Publisher identity is fractured across 5+ names — fresh user cannot tell who they're trusting
**Lenses:** trust-signals (Findings 32, 36, 38)
**Files:** `/Users/yan/Projects/ContextEngine/README.md:9, 467-470`, `/Users/yan/Projects/ContextEngine/chrome-extension/src/options/options.html:64`, `/Users/yan/Projects/ContextEngine/chrome-extension/PRIVACY.md:43`, `/Users/yan/Projects/ContextEngine/chrome-extension/src/manifest.json` (no author), `/Users/yan/Projects/ContextEngine/docs/CHROME_WEBSTORE_SUBMISSION.md:63, 81`
**Root cause:** VS Code badge says `css-llc`, README footer says `PROD LLC`, Options page says `FASTPROD / OpsContext`, GitHub org is `FASTPROD`, contact is `yannick@compr.ch`, parent link is `compr.fr`, pricing endpoint is `api.compr.ch`, README footer lists 7 unrelated product domains (compr.app, crowlr.io, plank.io, konive.com, invoc.io/me). The CWS listing also calls a BSL-1.1 product "open-source" (factually wrong) and says "SOC 2 CC7.2 / ISO 27001 A.12.4.1 grade" (implies certification that doesn't exist). For a security/audit-log product targeting regulated industries, this collapses trust on first read.
**What to do this sprint:** Pick ONE legal entity (recommend "PROD LLC") and propagate everywhere: (a) `manifest.json` add `"author": "PROD LLC"`; (b) `package.json` author field — normalize to `"PROD LLC"`; (c) republish VS Code ext under publisher `prod-llc` (currently `css-llc`); (d) `options.html:64` → "Built by PROD LLC — [opscontext.com](https://opscontext.com)"; (e) README.md:9 badge URL, README.md:467 footer; (f) move the 7-domain portfolio off the README to an `About PROD LLC` subpage or kill it entirely. Also fix `CHROME_WEBSTORE_SUBMISSION.md:63` to say "source-available (BSL-1.1), npm" instead of "open-source, npm". Pick one canonical domain (opscontext.com or contextengine.dev) for docs/pricing/privacy/support.

### H4. Compliance claims (SOC 2 CC7.2 / ISO 27001 A.12.4.1) presented as facts with no disclaimer
**Lenses:** trust-signals + cws-reviewer (Findings 33, 38)
**Files:** `/Users/yan/Projects/ContextEngine/README.md:20, 244`, `/Users/yan/Projects/ContextEngine/docs/CHROME_WEBSTORE_SUBMISSION.md:58`
**Root cause:** README states "SOC2 CC7.2 and ISO 27001 A.12.4.1 evidence out of the box." CWS description says "SOC 2 CC7.2 / ISO 27001 A.12.4.1 grade." Internal roadmap confirms certification is Phase 4 deferred. No link explains what either control requires. Regulated-industry buyers (the explicit target audience per README:17) will either treat this as misleading marketing or be embarrassed when their compliance team asks for the report.
**What to do this sprint:** Replace both occurrences with: *"Produces hash-chained audit log evidence aligned with SOC 2 CC7.2 (change monitoring) and ISO 27001 A.12.4.1 (event logging) controls. These are evidence artifacts, not a certification — OpsContext is not itself SOC 2 or ISO 27001 certified."* Link each control ID to a 1-paragraph plain-English explainer at `docs/compliance/cc7.2.md` and `docs/compliance/a.12.4.1.md`. Delete the word "grade" everywhere it currently sits next to a standard name.

### H5. VS Code setup terminal output reads as failure even on success
**Lenses:** install-vscode (Finding 12)
**Files:** `/Users/yan/Projects/ContextEngine/vscode-extension/src/extension.ts:718-731`
**Root cause:** Setup deliberately opens a visible terminal so users "see the npm install scroll past." For a vibe coder this means 200+ lines of npm `WARN deprecated`, `gyp` noise, `launchctl bootstrap` raw output, and `splices three entries into ~/.claude/settings.json` — then one "✅ setup complete" line at the end. Trust collapses on the first install even when everything worked.
**What to do this sprint:** Folded into the B2 fix above — the `withProgress` refactor sends raw stdout to a hidden output channel and surfaces only friendly progress messages + one success modal. No separate work item required if B2 is done correctly.

### H6. VS Code setup post-install message dead-ends at "wait for the Web Store"
**Lenses:** install-vscode (Finding 13)
**Files:** `/Users/yan/Projects/ContextEngine/vscode-extension/src/extension.ts:728-729`
**Root cause:** Final terminal echo says "Next: install the Chrome extension when it lands on the Web Store. For now, see chrome-extension/ in the repo for unpacked install." A marketplace-install user (a) does not have the repo cloned, (b) does not know what unpacked install means, (c) is told to wait for an undefined future event. The "one-click install" finishes by pointing at nothing actionable.
**What to do this sprint:** Folded into B2 — the success modal should show `[Open claude.ai]` and `[Try @contextengine in Copilot Chat]` buttons. Defer Chrome ext mention to a separate optional `OpsContext: Add browser capture` command that only appears in the palette and walks through the unpacked install with screenshots.

---

## Medium Severity

### M1. chrome-extension/README binary-name confusion + version drift + missing autostart guidance
**Lenses:** install-chromeext (Findings 4, 5, 6)
**Files:** `/Users/yan/Projects/ContextEngine/chrome-extension/README.md:12, 22-26, 32-33`, `/Users/yan/Projects/ContextEngine/src/cli.ts:1466`, `/Users/yan/Projects/ContextEngine/chrome-extension/src/options/options.html:20`
**Root cause:** README says "v0.1.0 — Phase 1a MVP" while manifest is 0.1.4. Three different binary names appear in three docs (`contextengine` in CLI help, `node dist/cli.js` in README, `opscontext` in Options page and CWS doc). README step 4 ("start the MCP server") lazily says "or however you normally run the MCP server" without mentioning the documented `opscontext install-autostart` path.
**What to do this sprint:** (1) Drop the hardcoded README version line; use a dynamic shields.io badge. (2) Canonical binary name = `opscontext`; update `cli.ts:1466` and the README to use it; note in CLI help that `contextengine`/`contextengine-mcp` are legacy aliases. (3) Replace step 4 with `opscontext install-autostart` on macOS, fallback `node dist/index.js < /dev/null &` on other platforms, and `curl http://127.0.0.1:7842/health` as the verification step.

### M2. install-autostart fails for npx-only users (README's recommended path)
**Lenses:** first-event-path (Finding 29)
**Files:** `/Users/yan/Projects/ContextEngine/src/install-autostart.ts:40-61, 173-180`
**Root cause:** `detectOpscontextEntry()` tries `npm root -g` then a dev-tree fallback using `__filename`. Package is ESM (`"type": "module"`), so `__filename` throws `ReferenceError` in `dist/install-autostart.js`; the catch swallows it and the function returns null. README pushes users to `npx -y @compr/opscontext-mcp` exclusively (no global-install instructions), so a typical user hits the dead-end "install globally or clone the repo" error.
**What to do this sprint:** Add a third resolver branch using `require.resolve('@compr/opscontext-mcp/dist/index.js')` (works inside npx's transient install). Fix the ESM `__filename` issue: use `fileURLToPath(import.meta.url)`. Update the error at lines 175-179 to acknowledge npx: "If you installed with npx, install globally first: `npm install -g @compr/opscontext-mcp`, OR pin a path with `opscontext install-autostart --entry=/path/to/dist/index.js`". Add the `--entry` flag.

### M3. Options page saves a typo'd secret silently — failure surfaces minutes later in another surface
**Lenses:** first-event-path (Finding 31)
**Files:** `/Users/yan/Projects/ContextEngine/chrome-extension/src/options/options.ts:24-36`
**Root cause:** `save()` writes config and shows "Saved at HH:MM:SS" with no verification. Typo'd 64-hex-char secrets are accepted silently. Discovery loop: paste → save → switch tab → claude.ai → type prompt → wait → open popup → red dot. The user has forgotten which character they mistyped.
**What to do this sprint:** On Save, before persisting: (a) `GET <endpoint>/health` — if 404/refused, show "OpsContext server not reachable at <endpoint>. Start it with `opscontext install-autostart`"; (b) POST a synthetic event with the entered secret to `<endpoint>/events`: 200 → green "Verified — events will flow"; 401 → red "Server rejected this secret. Did you copy all 64 hex characters?". Color-code the savedAt label. ~200 ms cost, collapses the discovery loop from minutes-cross-surface to instant-here.

### M4. VS Code setup modal uses CLI jargon as the consent text
**Lenses:** install-vscode (Findings 16, 17, 18)
**Files:** `/Users/yan/Projects/ContextEngine/vscode-extension/src/extension.ts:706-715`, `/Users/yan/Projects/ContextEngine/vscode-extension/README.md` (entire)
**Root cause:** Modal says "npm install -g @compr/opscontext-mcp; Install a macOS LaunchAgent; Wire Claude Code hooks" — every noun is jargon to the target persona. Also: unconditional macOS-only wording with no `process.platform` check (Linux/Windows users get a half-installed setup). VS Code README never mentions the one-click setup command at all; flagship feature invisible in marketplace.
**What to do this sprint:** Rewrite the modal as: *"OpsContext will install a small helper on your Mac so it can: (1) watch your AI coding sessions; (2) start automatically when you log in; (3) connect to Claude Code. About 30 seconds. You can uninstall anytime. Continue?"* Add a "Show technical details" link with the npm/launchctl/hooks vocabulary. Gate by `process.platform === 'darwin'` and show a different modal on Linux/Windows. Add `OpsContext: Set up OpsContext (one-click install)` to the Commands table in `vscode-extension/README.md` and add a Quickstart section at the top: "After installing, run `OpsContext: Set up OpsContext` from the Command Palette — that's it."

### M5. No troubleshooting section or visual install guide for unpacked Chrome ext
**Lenses:** install-chromeext (Findings 7, 9)
**Files:** `/Users/yan/Projects/ContextEngine/chrome-extension/README.md:28-29` + entire file
**Root cause:** "Load unpacked" is one line of prose, no screenshot, no warning that picking `chrome-extension/` instead of `chrome-extension/dist/` yields a missing-manifest error (or that `chrome-extension/src/` would load with broken icons). No Troubleshooting section anywhere covering port conflicts, secret mismatch, service worker errors, or the `/health` endpoint.
**What to do this sprint:** (1) Replace the prose line with numbered substeps: "a. Visit chrome://extensions. b. Toggle Developer Mode (top-right) ON. c. Click Load unpacked (top-left). d. Navigate to `<repo>/chrome-extension/dist` and click Select. **The folder must contain `manifest.json` at its root.**" (2) Embed a screenshot showing Developer Mode toggle. (3) Add a `## Troubleshooting` section at the bottom covering: `curl http://127.0.0.1:7842/health`, `lsof -i :7842`, chrome://extensions service-worker console link, popup inspector, and `cat ~/.contextengine/extension-secret` to confirm.

### M6. Setup is not a low-friction browser install — requires Node.js + terminal but listing reads as consumer-friendly
**Lenses:** trust-signals (Finding 39)
**Files:** `/Users/yan/Projects/ContextEngine/docs/CHROME_WEBSTORE_SUBMISSION.md:63-68`, `/Users/yan/Projects/ContextEngine/chrome-extension/src/options/options.html:20-21`
**Root cause:** Store listing tells users to run three CLI commands; Options page requires pasting a hex secret produced by a CLI. The "browser extension" framing mismatches the "requires Node.js + terminal + paste 64 hex chars" reality.
**What to do this sprint:** Be explicit in the short description (after B4's rewrite) that this is a developer tool: *"For developers — requires Node.js and a terminal to run the companion server."* Self-select non-devs out before installing. Track building a `.pkg`/`.dmg` installer with deep-link secret-paste as a Phase 2 backlog item.

---

## Low Severity

### L1. Server logs nothing on 401 — operator can't see bad-secret POSTs
**Lenses:** first-event-path (Finding 26)
**Files:** `/Users/yan/Projects/ContextEngine/src/http-server.ts:111-115`
**Fix:** On 401, `console.error('[OpsContext] rejected event POST: bad secret from <UA prefix>')` throttled to 1/min, plus `safeAppend('opscontext.event.rejected', { reason: 'bad_secret', ... })` to the audit log. (Severity downgraded — the popup already shows a precise actionable error, so tail-the-log is a secondary diagnostic path.)

### L2. PRIVACY.md says `capture_miss` has no message text; SW writes a diagnostic string into it
**Lenses:** cws-reviewer (Finding 22)
**Files:** `/Users/yan/Projects/ContextEngine/chrome-extension/PRIVACY.md:14`, `/Users/yan/Projects/ContextEngine/chrome-extension/src/background/service-worker.ts:62-72`
**Fix:** Adjust PRIVACY.md § 1: "*`browser.session_start` / `browser.capture_miss` — diagnostic markers. They never contain prompt or assistant text; `capture_miss` may include a short diagnostic string such as a selector-failure count or queue-overflow notice.*"

### L3. CWS listing calls a BSL-1.1 product "open-source"
**Lenses:** cws-reviewer (Finding 23) — folded into H3 fix.

### L4. minimum_chrome_version 110 not mentioned in any user-facing doc
**Lenses:** install-chromeext (Finding 8)
**Files:** `/Users/yan/Projects/ContextEngine/chrome-extension/src/manifest.json:6`, `/Users/yan/Projects/ContextEngine/chrome-extension/README.md`
**Fix:** Add a `## Requirements` section to chrome-extension/README.md: "Chrome 110+ (March 2023 or newer). Node 18+ to build."

### L5. No screenshots in main README
**Lenses:** trust-signals (Finding 37)
**Files:** `/Users/yan/Projects/ContextEngine/README.md`
**Fix:** Capture the 5 screenshots listed in `CHROME_WEBSTORE_SUBMISSION.md:108` and embed 2-3 at the top of README.md: (1) popup with green dot + recent events, (2) score report card, (3) `audit_verify` CLI output.

### L6. No uninstall / kill-switch in popup or Options
**Lenses:** trust-signals (Finding 35)
**Files:** `/Users/yan/Projects/ContextEngine/chrome-extension/src/popup/popup.html`, `/Users/yan/Projects/ContextEngine/chrome-extension/src/options/options.html`
**Fix:** Add "Pause capture (all domains)" master toggle to Options page; "Clear queued events" button to popup; "Delete all captured data" button on Options that hits a new `/reset` endpoint on the local server.

### L7. Acronym soup with no glossary
**Lenses:** trust-signals (Finding 34) — severity downgraded since the target audience is developers; defer to a Phase 2 `docs/glossary.md` task.

---

## Sprint Assignment Summary (Top 10, ranked)

| # | Item | Owner area | Effort |
|---|------|------------|--------|
| 1 | B1 — chrome-extension build self-contained + README rewrite | chrome-ext + docs | M |
| 2 | B2 — VS Code one-click setup hardening | vscode-ext | L |
| 3 | B3 — main README Step 3 (browser + autostart + hook) | docs | S |
| 4 | B4 — CWS short description rewrite + Companion server section | docs | S |
| 5 | H1 — DEFAULT_CONFIG opt-out → opt-in + queue drop on no-secret | chrome-ext | S |
| 6 | H2 — popup state machine refactor (persistStatus + dead ternary + ECONNREFUSED hint + CSS) | chrome-ext | S |
| 7 | H3 — publisher identity normalization (manifest/options/README/marketplace) | repo-wide | M |
| 8 | H4 — compliance disclaimer rewrite (README + CWS doc) | docs | XS |
| 9 | M1 — chrome-ext README binary name + version drift + autostart step | docs | XS |
| 10 | M2 — install-autostart npx + ESM `__filename` fix | core | S |

**Cumulative fresh-user impact if items 1–10 ship:** every blocker on the install path closes, the CWS submission becomes review-safe on first pass, and trust signals stop bleeding at the publisher/compliance level. Items M3–M6 and the L-tier remain as polish for the following sprint.
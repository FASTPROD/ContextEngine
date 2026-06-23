# Phase 1 — Day-1 Test Plan

> Generated overnight 2026-06-22 → 2026-06-23. Lets you verify the Chrome
> extension scaffold + the MCP HTTP endpoint + the heuristic drift detector
> end-to-end without publishing anything new.

Estimated time: **~15 minutes**. Do steps in order; each step's success
unblocks the next.

---

## Pre-flight (30 seconds)

```bash
cd /Users/yan/Projects/ContextEngine
git pull origin main         # pull overnight commits
npm install                  # in case audit.ts type union changed reqs
npm run build                # main package; expect: clean tsc
OPSCONTEXT_SKIP_CLAUDE_MEMORY=1 npm test    # expect: 196 / 196 passing
```

If any of the above fail, **stop here** and read [NIGHTLY.md](../../NIGHTLY.md)
at repo root — I documented anything that didn't land cleanly.

---

## Step 1 — Generate the extension secret (10 seconds)

```bash
node dist/cli.js init-extension-secret
```

Expected:
```
✅ Wrote /Users/yan/.contextengine/extension-secret (mode 600)

Secret (paste this into the browser extension's Options page):

  <64-hex-char string>

Next steps: ...
```

Copy the hex string — you'll paste it into the extension options in Step 4.

If you already had a secret from a previous test run, you'll see a friendly
refusal — pass `--force` to overwrite (and remember to re-paste the new one
in any extension that had the old value).

---

## Step 2 — Build the Chrome extension (1 minute)

```bash
cd chrome-extension
npm install                  # first time only
npm run build                # → dist/ contains the loadable extension
ls dist/                     # background/ content/ lib/ options/ popup/ manifest.json
cd ..
```

Expected: clean tsc + `(no icons/ — manifest will load without action icon)`
note (icons are optional for MVP; Chrome uses a default puzzle-piece icon).

---

## Step 3 — Load the extension unpacked in Chrome (1 minute)

1. Open Chrome → `chrome://extensions`
2. Toggle **Developer mode** ON (top-right)
3. Click **Load unpacked**
4. Navigate to `/Users/yan/Projects/ContextEngine/chrome-extension/dist/` and pick that folder
5. Extension appears in the list as "OpsContext Browser Capture v0.1.0"

If you see a manifest error, the build didn't produce a complete `dist/` —
re-run `npm run build` from `chrome-extension/`.

---

## Step 4 — Paste the secret into the extension (15 seconds)

1. Click the extension's icon in the Chrome toolbar (use the puzzle-piece menu if needed)
2. Click **Open options** in the popup
3. Paste the secret from Step 1 into the **Secret** field
4. Verify endpoint is `http://127.0.0.1:7842/events`
5. Verify all four checkboxes are ticked (claude.ai + chatgpt.com capture,
   redact secrets, redact PII)
6. Click **Save** → see "Saved at HH:MM:SS"

---

## Step 5 — Start the MCP server (the HTTP endpoint comes up with it) (30 seconds)

```bash
node dist/index.js
```

Expected log lines (among others):
```
[ContextEngine] 🚀 MCP server running on stdio (keyword search ready)
[ContextEngine] 🌐 event-ingest on http://127.0.0.1:7842 (secret loaded)
```

If you see `(NO SECRET — run \`contextengine init-extension-secret\`)` it
means Step 1 didn't land — re-run it.

Leave this terminal running. The HTTP endpoint must be alive for the
extension to flush events.

---

## Step 6 — Health-check the endpoint (5 seconds)

In another terminal:

```bash
curl -sf http://127.0.0.1:7842/health | python3 -m json.tool 2>/dev/null \
  || curl -sf http://127.0.0.1:7842/health
```

Expected:
```json
{
  "ok": true,
  "service": "opscontext-event-ingest",
  "port": 7842,
  "secretConfigured": true
}
```

---

## Step 7 — Capture a real Claude.ai event (1 minute)

1. Open `https://claude.ai` in Chrome (the tab where the extension is loaded)
2. Click the extension icon → popup should show green dot, "Status: ok", "Queued: 0"
3. Type a prompt and hit Enter (e.g., "what is 2+2")
4. Within ~2 seconds, the popup should show "Recent events" populated with
   `[prompt] claude.ai — what is 2+2`
5. Once Claude finishes responding, you should see `[response] claude.ai`
   appended too

If the popup shows **amber** dot ("queued"), check:
- The MCP server log in Step 5 — is it still running?
- Is the secret in the options exactly what `cat ~/.contextengine/extension-secret` shows?

---

## Step 8 — Verify events landed in the audit log (10 seconds)

```bash
tail -3 ~/.contextengine/audit.log | python3 -m json.tool 2>/dev/null \
  || tail -3 ~/.contextengine/audit.log
```

You should see your `browser.prompt` and `browser.response` records, each
with `prev_hash` + `hash` linking them into the chain.

Then verify the chain is intact:
```bash
node dist/cli.js audit-verify
# expect: ✅ Audit chain verified — N record(s), hash chain intact.
```

---

## Step 9 — Trigger a drift signal (2 minutes)

The detector is now reading your real audit log. Let's fire signals on
purpose:

### 9a — Fire a `fabrication_suspect` (critical severity)

In Claude.ai, paste this prompt:
> "Tell me what's in `src/this-file-does-not-exist.ts:42`"

When Claude responds (it will), the response will contain the fake path.
Within ~5 seconds, run:

```bash
node dist/cli.js watch --once --severity critical
# expect (something like):
# [HH:MM:SS] CRIT  fabrication_suspect    Assistant referenced non-existent file: src/this-file-does-not-exist.ts
# Exit code: 2 (--once with critical fires non-zero)
```

### 9b — Fire a `loop`

In Claude.ai, send the SAME prompt 3 times within a few minutes (anything
with substantial token overlap):
> "what is the largest prime less than 100"
> "what's the largest prime less than 100 please"
> "tell me the largest prime number less than 100"

Then:
```bash
node dist/cli.js watch --once --severity warn
# expect:
# [HH:MM:SS] WARN  loop                Same prompt sent 3× in 5 min
```

### 9c — Stream live (the "stop the chat now" experience)

In one terminal:
```bash
node dist/cli.js watch
# streaming view; press Ctrl-C to stop
```

In another terminal, simulate a stuck tool call by emitting fake events:
```bash
for i in 1 2 3 4; do
  node dist/cli.js emit-event vscode.tool_call \
    '{"tool":"Bash","args_preview":"git push origin main","error":"fatal: unable to access remote"}'
  sleep 1
done
```

The watch terminal should print, within ~5 seconds:
```
[HH:MM:SS] CRIT  silent_failure        Tool Bash failed 4× in 5 min
```

---

## Step 10 — Call `drift_status` via MCP (optional, 1 minute)

In your Claude Code session (Cmd+Shift+P → "Claude: Start new chat"), ask:
> "Use the drift_status tool to check the current OpsContext drift signals."

Claude will call the new MCP tool and surface the active signals.

---

## What success looks like

By the end of step 9, you should have:

- ✅ The Chrome extension loaded, options configured, popup showing green
- ✅ Events flowing from claude.ai → audit log via the local HTTP endpoint
- ✅ `audit-verify` confirming the chain is intact
- ✅ `watch --once` exit code 2 on a deliberately-triggered critical signal
- ✅ Live `watch` printing alerts within seconds of `emit-event`

That's Phase 1 end-to-end. The wedge no other product has:
**cross-surface capture + tamper-evident audit log + heuristic drift alerts**,
all local.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Popup shows amber "queued: N" | MCP server not running | Start `node dist/index.js` |
| Popup shows red "error: bad_secret" | Mismatched secret | Re-paste the value from `cat ~/.contextengine/extension-secret` |
| No `browser.prompt` events after typing | Selector miss | Look in the popup for `[capture_miss]` event; means Anthropic shipped a DOM change. Open `chrome-extension/src/content/shared/selectors.ts` and add a new fallback |
| `port 7842 already in use` on MCP startup | Another process | `OPSCONTEXT_EVENT_PORT=7843 node dist/index.js` + update extension options endpoint to `http://127.0.0.1:7843/events` |
| `watch` shows no signals | Audit log empty or all events outside window | `tail ~/.contextengine/audit.log` to verify events exist; widen `--window` to `3600` |
| `audit-verify` says BROKEN | Manual edit to audit.log | Don't manually edit it. Roll back via git history if you have a backup, otherwise the chain breaks at the edit point |

---

## What's NOT yet shipped (deferred for after manual testing)

- VS Code extension event emitters (the `emit-event` CLI is the pattern;
  wiring it from `vscode-extension/src/contextEngineClient.ts` is ~1 hour
  of code, deferred to next session for you to design the trigger points)
- npm publish of `opscontext-mcp@2.1.0-dev` (Phase 3 detector + HTTP server
  + `watch` + `drift_status` are all locally testable; publish after you've
  manually verified)
- Chrome Web Store listing (developer-mode unpacked install works for
  testing; Web Store submission is a Phase 1c task — needs icons, screenshots,
  privacy policy page)

These are documented in [NIGHTLY.md](../../NIGHTLY.md) with effort estimates.

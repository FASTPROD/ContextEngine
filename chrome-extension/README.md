# OpsContext Browser Capture (Chrome extension)

> Captures Claude.ai and ChatGPT prompts + responses, streams them to your local
> OpsContext audit log. **Local-first — nothing leaves your machine.**

Part of the [OpsContext for AI Agents](https://www.npmjs.com/package/@compr/opscontext-mcp)
project. The MCP server runs locally and receives events from this extension via
a 127.0.0.1 HTTP endpoint authenticated with a per-machine secret.

## Status

**v0.1.0 — Phase 1a MVP.** Not yet published to the Chrome Web Store. Install
unpacked from `dist/` after building.

## Install (local development)

```bash
# 1. Build the extension
cd chrome-extension
npm install
npm run build              # → dist/ contains the loadable extension

# 2. Generate the connection secret
cd ..
node dist/cli.js init-extension-secret
# Copy the hex token printed to stdout.

# 3. Load the extension in Chrome
#    chrome://extensions → Developer mode ON → "Load unpacked" → pick chrome-extension/dist/
#    Right-click the extension icon → Options → paste the secret → Save.

# 4. Start the OpsContext MCP server (which exposes the local HTTP endpoint)
node dist/index.js   # or however you normally run the MCP server
```

Visit https://claude.ai or https://chatgpt.com, type a prompt, and verify
events flow:

```bash
# Watch events landing in the audit log
tail -f ~/.contextengine/audit.log
```

The extension popup (click the icon) shows the connection status (green dot =
flowing, amber = queued, red = error) and the last 25 events captured.

## What it captures

- `browser.prompt` — what you typed, on submit
- `browser.response` — assistant's final response, once streaming completes
- `browser.tool_call` — when the assistant uses a tool block
- `browser.session_start` — new conversation begins (URL change)
- `browser.capture_miss` — selectors stopped resolving (DOM redesign signal)

All captured text passes through a **redaction pass** before leaving the page:
- AWS keys, Stripe tokens, JWT prefixes, Anthropic / OpenAI / GitHub keys,
  SSH private key blocks, generic credential-assignment shapes — all stripped
  to `[REDACTED:type]`
- Optional opt-in PII pass: emails, phone-shaped digits, credit-card-shaped runs

## What it does NOT do

- ❌ Read other tabs (no `tabs` permission)
- ❌ Run on any site other than claude.ai + chatgpt.com (scoped `host_permissions`)
- ❌ Send anything to a remote server (only `127.0.0.1:7842` — your machine)
- ❌ Capture file uploads, image attachments, or page screenshots
- ❌ Modify the page (read-only DOM observation)
- ❌ Intercept network requests (no XHR proxy, no fetch monkey-patch)

## Privacy posture

- Secret lives in `chrome.storage.local` (not synced; not shared between profiles).
- Connection endpoint is hard-coded to `127.0.0.1:7842` by default; you can change
  it via the options page if you run the MCP server on a different port, but the
  manifest's `host_permissions` is locked to `127.0.0.1` — the extension cannot
  POST to anywhere else.
- Audit-log writes happen on YOUR machine; the extension never opens an outbound
  connection beyond localhost.

## Risks + known DOM brittleness

DOM selectors break when Anthropic or OpenAI ship a redesign. The extension uses
a two-tier strategy (data-testid first, structural fallback second) and emits a
`browser.capture_miss` event when both miss for 60s — your audit log will reflect
that the capture stopped working. If you see capture_miss events, file an issue
or PR with the new selector at:

https://github.com/FASTPROD/ContextEngine/issues

## Attribution

Selector seeds adapted from MIT-licensed prior-art extensions. See
[LICENSE_THIRD_PARTY.md](./LICENSE_THIRD_PARTY.md).

## License

Business Source License 1.1 — see [LICENSE](./LICENSE).

Converts to Apache 2.0 on **2030-06-22**.

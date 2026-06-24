# OpsContext Browser Capture (Chrome extension)

> Captures Claude.ai and ChatGPT prompts + responses, streams them to your local
> OpsContext audit log. **Local-first — nothing leaves your machine.**

Part of the [OpsContext for AI Agents](https://www.npmjs.com/package/@compr/opscontext-mcp)
project. The MCP server runs locally and receives events from this extension via
a 127.0.0.1 HTTP endpoint authenticated with a per-machine secret.

## Status

**v0.1.0 — Phase 1a MVP.** Not yet published to the Chrome Web Store. Install
unpacked from `dist/` after building.

## Requirements

- **Chrome 110+** (the manifest pins `minimum_chrome_version: 110`; older Chromium builds will refuse to load the unpacked extension).
- **Node.js 18+** (needed for the published OpsContext MCP CLI and for the local build script).
- macOS, Linux, or Windows. The MCP server and extension are platform-agnostic; only the optional autostart helper is macOS-only today.

## Install

Three steps. The OpsContext MCP server (which receives events) is a separate npm package — install it first, then build this extension and load it unpacked.

### 1. Install the OpsContext MCP server + generate the connection secret

```bash
npm install -g @compr/opscontext-mcp
opscontext init-extension-secret      # writes ~/.contextengine/extension-secret
opscontext install-autostart          # macOS only — boots the MCP HTTP listener on login
```

`init-extension-secret` prints the hex token to stdout AND writes it to `~/.contextengine/extension-secret`. You'll paste it into the extension's Options page in step 3. On Linux/Windows, skip `install-autostart` and run `opscontext` manually whenever you want to capture (it listens on `127.0.0.1:7842`).

### 2. Build the extension

```bash
cd chrome-extension
npm install
npm run build              # → dist/ contains the loadable extension
```

The build is fully self-contained — it does NOT require `npm install` in the parent ContextEngine repo. `dist/` is gitignored; rebuild after any pull.

### 3. Load unpacked in Chrome

1. Open `chrome://extensions`.
2. Toggle **Developer mode** ON (top-right).
3. Click **Load unpacked** and pick `chrome-extension/dist/`.
4. Right-click the OpsContext icon in the toolbar → **Options** → paste the secret from step 1 → **Save**.

Visit https://claude.ai or https://chatgpt.com, type a prompt, and verify events flow:

```bash
tail -f ~/.contextengine/audit.log
```

The extension popup (click the icon) shows the connection status (green dot = flowing, amber = queued, red = error) and the last 25 events captured.

## Troubleshooting

If events aren't landing in the audit log, walk this list in order:

1. **Is the MCP HTTP listener up?**
   ```bash
   curl http://127.0.0.1:7842/health
   ```
   Expect a JSON `{"status":"ok",...}`. If the curl hangs or refuses, the listener isn't running — start it with `opscontext` (or `opscontext install-autostart` on macOS to make it persistent).

2. **Is something else squatting on port 7842?**
   ```bash
   lsof -i :7842
   ```
   Should show a single `node` process owned by you. If it's another app, stop it (or change the port in the extension Options page; the MCP server reads `OPSCONTEXT_HTTP_PORT` from the env).

3. **Check the extension's service-worker console.** `chrome://extensions` → find OpsContext → click the **service worker** link under "Inspect views". Errors there (auth 401, network refused, bad secret) point to the real cause.

4. **Check the popup console.** Right-click the OpsContext toolbar icon → **Inspect popup**. Bad selector matches or queue overflow show up here.

5. **Confirm the secret matches.**
   ```bash
   cat ~/.contextengine/extension-secret
   ```
   That hex string MUST be the same one pasted in the extension's Options page. If they drifted, re-run `opscontext init-extension-secret --force` and paste the new value.

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

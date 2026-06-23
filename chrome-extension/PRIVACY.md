# Privacy Policy — OpsContext Browser Capture

**Last updated**: 2026-06-23

OpsContext Browser Capture is a Chrome extension that streams your prompts and assistant responses on Claude.ai and ChatGPT.com to a local audit log running on your own computer. It is local-first software. No data is sent to the publisher, to any cloud service, or to any third party.

## 1. What the extension reads

When you visit `https://claude.ai/*` or `https://chatgpt.com/*`, content scripts read the rendered DOM of the conversation and assemble events of the following kinds:

- `browser.prompt` — text of a message you submit, with character count and a conversation identifier derived from the URL.
- `browser.response` — text of an assistant reply once its stream has finished.
- `browser.tool_call` — name of a tool block the assistant invokes and a short argument preview (first 200 characters).
- `browser.session_start` / `browser.capture_miss` — diagnostic markers (no message text).

The extension reads only what is already visible in the page. It does not intercept network requests, does not monkey-patch `fetch` or `XHR`, does not read cookies, does not access other tabs, and does not log in on your behalf.

## 2. Redaction before the event leaves the page

Before any event is dispatched, captured text passes through a regex redactor that replaces well-known secret shapes — AWS keys, Stripe keys, JWTs, `Bearer sk-...` tokens (Anthropic/OpenAI), GitHub personal access tokens, SSH private-key blocks, and generic credential-assignment patterns (lines of the shape `<keyword> <equals> <value>` where `<keyword>` is one of the common credential names) — with `[REDACTED:...]` markers. **This secret redaction is enabled by default but can be disabled by the user from the Options page** (checkbox labeled "Strip known secret shapes"). An additional PII pass (off by default, opt-in from Options) redacts emails, phone-shaped numbers, and credit-card-shaped digit runs. Redaction is best-effort and does not replace your own judgement about what you type.

## 3. Where the data goes

Events are queued in the extension's service worker and POSTed to a loopback endpoint on your own machine. **The default endpoint is `http://127.0.0.1:7842/events`; the URL is user-editable from the Options page, but the Chrome manifest's `host_permissions` constrains it to `http://127.0.0.1:7842/*` — the extension cannot POST to any other host.** Requests are authenticated with a 64-character hex secret you paste into the Options page; without that secret, the receiving server rejects events. No remote endpoint, telemetry server, analytics service, or third-party host is contacted at any time.

## 4. Who has access

Only the user. The receiving server is the OpsContext CLI installed on your machine; the captured events are written to `~/.contextengine/audit.log` on your local disk. The publisher cannot read them.

## 5. Retention and deletion

Retention is fully under your control. The extension persists an in-flight queue (capped at 1000 events) in `chrome.storage.session`; this queue **clears when you close the browser** or uninstall the extension. To delete all captured data: stop the local OpsContext server, delete `~/.contextengine/` from your home directory, and remove the extension from `chrome://extensions`. There is no remote copy to revoke.

## 6. Permissions justification

- `storage` — to persist your secret, endpoint URL, and capture toggles across browser restarts.
- `alarms` — to schedule periodic flushes of the in-flight queue (MV3 service workers hibernate; alarms are how they wake to retry).
- `host_permissions: https://claude.ai/*` and `https://chatgpt.com/*` — to inject the content scripts that read the conversation DOM.
- `host_permissions: http://127.0.0.1:7842/*` — to POST events to the local OpsContext server. **No non-loopback host is granted.**

## 7. Contact

Questions: yannick@compr.ch
Source: https://github.com/FASTPROD/ContextEngine

---

*This policy describes version 0.1.4 of OpsContext Browser Capture. Prior versions had the same local-first posture and the same host_permissions constraint.*

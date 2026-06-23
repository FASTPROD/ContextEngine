# Chrome Web Store Submission Pack — OpsContext Browser Capture

Generated 2026-06-23 via [workflow `wf_b3090090-f08`](../.claude/projects/.../workflows/) with 6 agents in 3 phases:
1. **Generate** — 4 parallel writers (privacy / short / long / icons)
2. **Verify** — adversarial accuracy audit (caught 3 MAJOR inaccuracies in the initial privacy draft, since corrected)
3. **Package** — synthesized into this document

The privacy policy has been **corrected** based on the adversarial audit findings (see § "Privacy audit corrections" below).

---

## 1. Submission checklist

- [x] Icons created (16/48/128 px PNG + SVG sources at `chrome-extension/icons/`)
- [x] Privacy policy text written at `chrome-extension/PRIVACY.md` — see § "Privacy policy" below
- [x] Short description (124 chars, under the 132-char limit)
- [x] Detailed description (corrected — original draft referenced VS-Code-only features that don't apply to the Chrome ext; corrected version below)
- [ ] Privacy policy hosted as HTML at `https://compr.fr/privacy-opscontext.html` (manual deploy step)
- [ ] Screenshots captured (5 max, 1280×800 or 640×400 — see § "Screenshot plan")
- [ ] $5 Google developer account registered (one-time fee)
- [ ] `chrome-extension/dist/` zipped for upload (`cd chrome-extension && npm run package` produces `opscontext-chrome-0.1.4.zip`)
- [ ] Listing submitted at https://chrome.google.com/webstore/devconsole
- [ ] 14-day review window begins

---

## 2. Privacy policy

Hosted version → `https://compr.fr/privacy-opscontext.html` (deploy this URL into the Store form's "Privacy policy" field).

Source: [`chrome-extension/PRIVACY.md`](../chrome-extension/PRIVACY.md) — corrected per audit findings.

---

## 3. Short description (paste into Store form)

```
Local-first browser capture for OpsContext: tamper-evident audit log, drift detection, MCP companion. Zero cloud, zero keys.
```

124 chars. Limit is 132.

---

## 4. Detailed description (paste into Store form)

**Capture Claude.ai and ChatGPT.com conversations into your own tamper-evident audit log — entirely on your machine.**

OpsContext Browser Capture reads your prompts and assistant responses from the rendered page DOM and streams them to a local server running on your computer. Nothing leaves your machine. No telemetry, no cloud account, no signup.

### What it captures
- Prompts you submit (with optional secret + PII redaction)
- Assistant responses (after streaming completes)
- Tool-use blocks the assistant invokes (web search, file actions, etc.)
- Session-start markers when you navigate between chats

### Why
- **Audit trail** — every interaction gets a tamper-evident, hash-chained record (SOC 2 CC7.2 / ISO 27001 A.12.4.1 grade).
- **Drift detection** — when paired with the OpsContext MCP server, heuristics fire on hallucination, prompt loops, stuck tool calls, and silent failures.
- **Local-first** — your AI conversations never go to a third-party cloud. The extension's manifest constrains its delivery URL to `127.0.0.1`.

### Setup
Install the companion OpsContext MCP server (open-source, npm):
```
npm install -g @compr/opscontext-mcp
opscontext install-autostart        # auto-start server at every macOS login
opscontext init-extension-secret    # generate the shared secret
```
Paste the generated secret into the extension's Options page. Done.

### Privacy posture
- Manifest `host_permissions` allows only `claude.ai`, `chatgpt.com`, and `127.0.0.1:7842/*`
- Constant-time secret compare on the local endpoint
- Opt-in per-domain capture (Claude.ai and ChatGPT.com toggle independently)
- Default-on secret redaction before any event leaves the page (toggleable from Options)

### Links
- [npm package](https://www.npmjs.com/package/@compr/opscontext-mcp) — `@compr/opscontext-mcp`
- [GitHub source](https://github.com/FASTPROD/ContextEngine)
- [Privacy policy](https://compr.fr/privacy-opscontext.html)
- License: BSL-1.1

### Not covered by this extension
The browser extension only captures from claude.ai and chatgpt.com web UIs. It does not capture from Claude Code CLI sessions, Cursor, Copilot Chat, or other AI tools — for those, install the OpsContext MCP server and its Claude Code hook (`opscontext install-claude-hook`).

---

## 5. Icon spec

See `chrome-extension/icons/`:
- `icon-128.png` — 128×128, full design with shield + capture aperture + observability wave
- `icon-48.png` — 48×48, slightly simplified
- `icon-16.png` — 16×16, silhouette-only for the toolbar
- SVG sources alongside each PNG so future re-renders are clean

Build process: `npm run build` runs `scripts/copy-static.mjs` which copies `chrome-extension/icons/` → `chrome-extension/dist/icons/`. Manifest declares them under both `"icons"` (extension-management surface) and `"action.default_icon"` (toolbar icon).

To regenerate PNGs after editing SVGs:
```bash
cd chrome-extension/icons
for size in 16 48 128; do
  rsvg-convert -w $size -h $size icon-$size.svg -o icon-$size.png
done
```

---

## 6. Screenshot capture plan

Chrome Web Store accepts 1–5 screenshots at **1280×800 or 640×400**. Capture in this order:

1. **Hero shot** — claude.ai with the OpsContext popup open (showing green dot + recent events). 1280×800.
2. **Options page** — `chrome-extension://<id>/options/options.html` with the secret field, endpoint, capture toggles, and redaction options. 1280×800.
3. **Live event flow** — terminal showing `tail -f ~/.contextengine/audit.log` with browser.prompt + browser.response events landing in real-time. 1280×800.
4. **Detector signal** — terminal showing `opscontext watch` with a `silent_failure` CRIT alert. Optional.
5. **Architecture diagram** — simple block diagram: Chrome ext → 127.0.0.1:7842 → audit log. Optional.

Take with macOS `Cmd-Shift-4` for region select. Verify dimensions with `file <screenshot.png>`.

---

## 7. Privacy audit corrections (applied)

The initial workflow-generated privacy policy had 3 MAJOR inaccuracies caught by the adversarial verifier. All three are now fixed in the version above. Recording here for transparency:

| Original (wrong) claim | Corrected claim |
|---|---|
| "POSTed exclusively to `http://127.0.0.1:7842/events`" | "Default is `127.0.0.1:7842/events`; user-editable in Options but `host_permissions` constrains to `127.0.0.1:*`" |
| "transient in-memory queue" | "persisted in `chrome.storage.session`, cleared on browser close or uninstall" |
| Secret redaction presented as unconditional | Disclosed as default-on but user-toggleable |
| Enumeration omitted `Bearer sk-...` pattern | Added to the enumerated regex shapes |

### Open follow-ups (defer to later sprint)

- **`browser.session_end` declared in `types.ts:16` but never emitted anywhere** — either wire it (e.g., emit on `beforeunload`) or remove from the type union. Confused the privacy auditor; will confuse Chrome Web Store reviewers. Small cleanup.

---

## 8. Submission flow (when ready)

1. **Deploy privacy policy**:
   ```bash
   # Convert PRIVACY.md to HTML, host at compr.fr/privacy-opscontext.html
   # (manual step — depends on compr.fr's deploy mechanism)
   ```
2. **Package the extension**:
   ```bash
   cd /Users/yan/Projects/ContextEngine/chrome-extension
   npm run package
   # → opscontext-chrome-0.1.4.zip in chrome-extension/
   ```
3. **Capture screenshots** per § 6.
4. **Register at** https://chrome.google.com/webstore/devconsole (one-time $5 fee).
5. **Create new item** → upload the .zip → paste short + long descriptions → paste privacy policy URL → upload screenshots → submit.
6. **Google review** kicks off (~14 days). They may ask for clarification — respond from the Console.

---

## 9. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Google rejects on first review for incomplete privacy disclosure | Low (we ran adversarial audit) | The corrected policy explicitly addresses CWS user-data policy requirements |
| Reviewer flags missing "single purpose" justification | Medium | Already covered by § 6 of `PRIVACY.md` (purpose = capture for local audit log) |
| Selectors break between submission and approval (Anthropic DOM churn) | Medium | We have a two-tier selector model + capture_miss heartbeat; only need to ship a patch update post-approval |
| 14-day delay blocks user adoption | Certain | Mitigate by shipping VS Code extension's "Set up OpsContext" command in the same week — that adoption path doesn't depend on the Chrome ext |

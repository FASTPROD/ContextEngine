# Third-party attributions

The OpsContext Browser Capture extension uses selector seeds adapted from the
following MIT-licensed prior-art Chrome extensions. We use **only the selector
constants** (the strings identifying DOM elements on claude.ai and chatgpt.com).
The capture architecture (streaming events vs one-shot file export), audit-chain
integration, policy-driven redaction, and local HTTP transport are entirely
original to OpsContext.

DOM selectors themselves are facts about the underlying page structure and are
not copyrightable, but the explicit lists of selectors below represent
substantial effort by the original authors. We acknowledge them here.

---

## Couchraver/claude-chatgpt-gemini-downloader

- **Repository**: https://github.com/Couchraver/claude-chatgpt-gemini-downloader
- **License**: MIT
- **Version reviewed**: as of 2026-05-24 (latest commit at time of adaptation)
- **What we adapted**: selector patterns for claude.ai message lists, ChatGPT
  message lists, Gemini conversation turns, and the structural fallback
  `[role="presentation"] > div` used when data-testids miss.
- **Where it appears**: `src/content/shared/selectors.ts` —
  `CLAUDE_SELECTORS.messageList`, `CLAUDE_SELECTORS.assistantMarkdown`,
  `CHATGPT_SELECTORS.assistantMessage`.

```
MIT License

Copyright (c) 2024-2026 Couchraver

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## xvfeiran/ChatExporter

- **Repository**: https://github.com/xvfeiran/ChatExporter
- **License**: MIT
- **What we adapted**: ChatGPT-side `data-message-id` and `.markdown` selectors,
  cross-checked against the primary source above to confirm both projects
  resolved identical DOM nodes.

```
MIT License

Copyright (c) 2024-2026 xvfeiran

(Same MIT text as above; reproduced for completeness in the published
LICENSE_THIRD_PARTY artifact.)
```

---

## What we did NOT take

- No code from the export pipelines (markdown / JSON / HTML / CSV serializers).
- No popup or options UI from either project.
- No background-service-worker architecture or message protocols.
- No manifest entries, build scripts, or icon assets.

Everything in `src/background/`, `src/popup/`, `src/options/`, `src/lib/`,
`src/content/shared/{observer,redact,emit}.ts`, `manifest.json`,
`scripts/copy-static.mjs`, and the test fixtures is original work by FASTPROD
under the BSL-1.1 license at the root of this package.

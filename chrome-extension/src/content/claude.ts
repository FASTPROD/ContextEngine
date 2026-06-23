/**
 * claude.ai content script.
 *
 * Captures three kinds of events:
 *   1. browser.prompt        — when the user submits a message
 *   2. browser.response      — when the assistant's stream completes
 *   3. browser.tool_call     — when a tool-use block appears
 *
 * Capture is DOM-read only — no XHR proxy, no fetch monkey-patch, no
 * service-worker interception. Cloudflare anti-bot won't flag us because we
 * behave exactly like an idle user who happens to read text.
 */

import { CLAUDE_SELECTORS as S, resolve, resolveAll } from "./shared/selectors.js";
import { debounceSettle, conversationIdFromUrl } from "./shared/observer.js";
import { redact, redactPii } from "./shared/redact.js";
import { buildEvent, emitEvent } from "./shared/emit.js";
import { DEFAULT_CONFIG } from "../lib/types.js";

const SURFACE = "claude.ai";
let captureEnabled = DEFAULT_CONFIG.captureClaudeAi;
let redactSecrets = DEFAULT_CONFIG.redactSecrets;
let redactPiiOn = DEFAULT_CONFIG.redactPii;
// Conversation IDs change on URL change; cache to detect new conversations.
let lastConversationId = "";
// Track which assistant turn IDs we've already emitted so we don't double-fire
// on the response-settle observer.
const emittedResponses = new Set<string>();
// Heartbeat: if both selector tiers miss for 60s of attempts, emit a single
// capture_miss event so the user knows the DOM changed under us.
let consecutiveMisses = 0;

// ─── Config plumbing ────────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get({
      captureClaudeAi: DEFAULT_CONFIG.captureClaudeAi,
      redactSecrets: DEFAULT_CONFIG.redactSecrets,
      redactPii: DEFAULT_CONFIG.redactPii,
    });
    captureEnabled = !!stored.captureClaudeAi;
    redactSecrets = !!stored.redactSecrets;
    redactPiiOn = !!stored.redactPii;
  } catch {
    // chrome.storage might not be available in some sandbox states.
    // Fall back to defaults.
  }
}

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if ("captureClaudeAi" in changes) captureEnabled = !!changes.captureClaudeAi.newValue;
  if ("redactSecrets" in changes) redactSecrets = !!changes.redactSecrets.newValue;
  if ("redactPii" in changes) redactPiiOn = !!changes.redactPii.newValue;
});

// ─── Prompt capture ─────────────────────────────────────────────────────────

function applyRedaction(text: string) {
  let result = redact(text, { enabled: redactSecrets });
  if (redactPiiOn) {
    const pii = redactPii(result.text);
    result = {
      text: pii.text,
      redacted: result.redacted || pii.redacted,
      counts: { ...result.counts, ...pii.counts },
    };
  }
  return result;
}

// Capture user prompts by reading the RENDERED `[data-testid="user-message"]`
// nodes after each settle. Replaces the prior intercept-the-contenteditable
// approach which raced React's input-clear (input was empty by the time our
// setTimeout(0) fired). Rendered-DOM source survives that race because the
// element only appears AFTER React flushes submit. LOCK note: keep this as
// the primary capture path; the keydown/click handlers were removed for this
// reason in 2026-06-23.
const emittedPrompts = new Set<string>();

function capturePromptsFromDOM() {
  if (!captureEnabled) return;
  // Use resolveAll (primary-first, fallback ONLY if primary empty) — NOT a
  // single OR-selector. The OR pattern (`primary, fallback`) matches BOTH
  // tiers at once, which double-emits when the fallback selector matches
  // ancestors/descendants of primary matches. See [RESPONSE-DEDUPE] LOCK.
  const nodes = resolveAll(S.userMessage);
  if (nodes.length === 0) {
    consecutiveMisses++;
    return;
  }
  consecutiveMisses = 0;

  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i] as HTMLElement;
    const text = el.innerText || "";
    if (!text.trim()) continue;
    // Stable dedupe key: position-in-list + first 64 chars + length.
    // Position alone isn't enough because new turns shift positions on edit.
    const key = `p:${i}:${text.length}:${text.slice(0, 64)}`;
    if (emittedPrompts.has(key)) continue;
    emittedPrompts.add(key);

    const { text: redactedText, redacted, counts } = applyRedaction(text);
    const conversationId = conversationIdFromUrl(location.href);
    lastConversationId = conversationId;

    emitEvent(
      buildEvent("browser.prompt", SURFACE, {
        conversation_id: conversationId,
        text: redactedText,
        char_count: text.length,
        redacted,
        redaction_counts: redacted ? counts : undefined,
        ordinal: i,
      }),
    );
  }
}

// ─── Response capture ───────────────────────────────────────────────────────

// 🔒 LOCKED [RESPONSE-DEDUPE] — 2026-06-23
// ⛔ NEVER put `text.length` back in the dedupe key. The streaming-growth
//    over-emit bug (a response firing ~6× as it grew, once per 750ms settle)
//    was exactly this: each settle saw a longer text, length-in-key differed,
//    Set check missed, re-emit. Length stays OUT.
// ⛔ NEVER replace `isBlockDone` with a document-wide `anyDone` check. While
//    turn N+1 is mid-stream, turn N still has its copy button, so doc-wide
//    "any copy button anywhere" returns true throughout. The result: turn
//    N+1 emits a partial under the prefix-only dedupe key, and the final
//    full text is suppressed (same prefix). Per-block ancestor walk is what
//    makes this safe.
// WHY: This is the "polish fix" the user flagged on 2026-06-23 — they
//    observed a single response firing 6× in the audit log. Workflow
//    designed + 3 adversarial verifiers all flagged the original two-settle
//    stability gate as silently dropping legitimate captures (a stream that
//    finishes generates ONE final settle, not two). The per-block done-marker
//    check is the verifier-recommended fallback that works in all 4 cases:
//    new-response-just-finished, page-reload-with-existing-chat,
//    mid-stream-pause, multiple-completed-with-one-streaming.
// FIX: To extend to chatgpt.com, see chatgpt.ts captureResponses — same
//    pattern, walks up from the assistant block to find the surface-specific
//    copy button.

function isBlockDone(block: Element): boolean {
  // Walk up looking for an ancestor whose subtree contains a copy button
  // for THIS block. The copy button only appears once the stream finishes
  // for THIS turn — that's our per-block done signal. We cap the walk at
  // 5 levels to avoid accidentally matching the NEXT turn's copy button
  // (turn containers in claude.ai are typically 3–4 ancestors above the
  // markdown block).
  let cur: Element | null = block.parentElement;
  let depth = 0;
  while (cur && cur !== document.body && depth < 5) {
    if (
      cur.querySelector('button[data-testid="action-bar-copy"]') ||
      cur.querySelector('button[aria-label*="Copy" i]')
    ) {
      return true;
    }
    cur = cur.parentElement;
    depth++;
  }
  return false;
}

function captureResponses() {
  if (!captureEnabled) return;
  // 🔒 LOCK [RESPONSE-DEDUPE] (continued): we CANNOT use
  //   `querySelectorAll(primary + ", " + fallback)`
  // because Anthropic's DOM nests:
  //   <div class="font-claude-response">         ← primary match
  //     <div class="standard-markdown">…</div>   ← fallback match (nested!)
  //   </div>
  // The OR-selector returns BOTH. For loop iterates twice. Different `i`,
  // same text → different dedupe keys → both emit. That's the "response
  // emits 2×" bug observed live on 2026-06-23.
  // resolveAll() correctly tries primary first, falls back to fallback ONLY
  // if primary returned zero matches.
  const blocks = resolveAll(S.assistantMarkdown);
  if (blocks.length === 0) {
    consecutiveMisses++;
    return;
  }
  consecutiveMisses = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const text = (block as HTMLElement).innerText || "";
    if (!text.trim()) continue;
    // Per-block done check — see LOCK [RESPONSE-DEDUPE] above. If this
    // specific turn doesn't have a copy button in a nearby ancestor, it's
    // still streaming. Skip; the copy button appearing will trigger a
    // mutation → debounceSettle → re-entry of captureResponses → emit.
    if (!isBlockDone(block)) continue;

    // Dedupe key: position + first 64 chars. NO LENGTH — see LOCK above.
    const key = `r:${i}:${text.slice(0, 64)}`;
    if (emittedResponses.has(key)) continue;
    emittedResponses.add(key);

    const { text: redactedText, redacted, counts } = applyRedaction(text);
    emitEvent(
      buildEvent("browser.response", SURFACE, {
        conversation_id: lastConversationId || conversationIdFromUrl(location.href),
        text: redactedText,
        char_count: text.length,
        redacted,
        redaction_counts: redacted ? counts : undefined,
        ordinal: i,
      }),
    );
  }
}

// ─── Tool-call capture ──────────────────────────────────────────────────────

const emittedToolCalls = new Set<string>();

function captureToolCalls() {
  if (!captureEnabled) return;
  const list = resolve(S.messageList);
  if (!list) return;
  // Same nested-selector hazard as captureResponses — use resolveAll, not OR.
  const blocks = resolveAll(S.toolCallBlock, list);
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const text = (block as HTMLElement).innerText || "";
    const key = `${i}:${text.slice(0, 200)}`;
    if (emittedToolCalls.has(key)) continue;
    emittedToolCalls.add(key);
    // The tool name is usually in the first monospace child.
    const nameEl = block.querySelector("[class*='font-mono'], code");
    const tool = nameEl ? (nameEl as HTMLElement).innerText.trim() : "unknown";
    emitEvent(
      buildEvent("browser.tool_call", SURFACE, {
        conversation_id: lastConversationId || conversationIdFromUrl(location.href),
        tool,
        args_preview: text.slice(0, 200),
        ordinal: i,
      }),
    );
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  await loadConfig();
  if (!captureEnabled) {
    // Re-check periodically in case the user enables capture mid-session.
    setTimeout(boot, 5_000);
    return;
  }

  // Watch the whole page for prompt + response + tool changes; debounceSettle
  // fires when DOM has been quiet for 750ms — after React has finished
  // rendering both the user's submitted message and the assistant's response.
  // This is what replaced the old keydown/click input-intercept approach.
  debounceSettle(document.body, 750, () => {
    capturePromptsFromDOM();
    captureResponses();
    captureToolCalls();
  });

  // URL change detection (claude.ai is an SPA — pushState navigation).
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastConversationId = conversationIdFromUrl(lastUrl);
      emittedResponses.clear();
      emittedToolCalls.clear();
      emittedPrompts.clear();
      emitEvent(buildEvent("browser.session_start", SURFACE, {
        conversation_id: lastConversationId,
      }));
    }
  }, 1_000);

  // Capture-miss heartbeat: ~60s of attempts with both tiers missing means
  // the selectors are stale.
  let lastMissCheck = Date.now();
  setInterval(() => {
    if (consecutiveMisses > 30 && Date.now() - lastMissCheck > 60_000) {
      lastMissCheck = Date.now();
      emitEvent(buildEvent("browser.capture_miss", SURFACE, {
        error: `Selectors failed ${consecutiveMisses}× in last 60s. DOM may have changed; update src/content/shared/selectors.ts.`,
      }));
      consecutiveMisses = 0;
    }
  }, 30_000);

  // Initial scan in case responses/prompts are already on screen when the
  // page loads (e.g. returning to an existing chat).
  setTimeout(() => {
    capturePromptsFromDOM();
    captureResponses();
    captureToolCalls();
  }, 1_500);
}

boot().catch((err) => {
  console.debug("[OpsContext claude.ai] boot failed:", err);
});

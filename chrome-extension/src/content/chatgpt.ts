/**
 * chatgpt.com content script — mirror of claude.ts with CHATGPT_SELECTORS.
 *
 * Kept as a separate file (rather than parameterizing claude.ts) because each
 * surface has small idiosyncrasies (ChatGPT uses textarea not contenteditable;
 * its response container nesting differs; tool-call blocks have different
 * class shapes) — parameterizing tends to leak the abstraction and obscure
 * which surface broke when something changes. Two near-mirror files are
 * easier to maintain than one over-clever one.
 */

import { CHATGPT_SELECTORS as S, resolve, resolveAll } from "./shared/selectors.js";
import { debounceSettle, conversationIdFromUrl } from "./shared/observer.js";
import { redact, redactPii } from "./shared/redact.js";
import { buildEvent, emitEvent } from "./shared/emit.js";
import { DEFAULT_CONFIG } from "../lib/types.js";

const SURFACE = "chatgpt.com";
let captureEnabled = DEFAULT_CONFIG.captureChatGptCom;
let redactSecrets = DEFAULT_CONFIG.redactSecrets;
let redactPiiOn = DEFAULT_CONFIG.redactPii;
let lastConversationId = "";
const emittedResponses = new Set<string>();
const emittedToolCalls = new Set<string>();
let consecutiveMisses = 0;

async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get({
      captureChatGptCom: DEFAULT_CONFIG.captureChatGptCom,
      redactSecrets: DEFAULT_CONFIG.redactSecrets,
      redactPii: DEFAULT_CONFIG.redactPii,
    });
    captureEnabled = !!stored.captureChatGptCom;
    redactSecrets = !!stored.redactSecrets;
    redactPiiOn = !!stored.redactPii;
  } catch {
    /* defaults */
  }
}

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if ("captureChatGptCom" in changes) captureEnabled = !!changes.captureChatGptCom.newValue;
  if ("redactSecrets" in changes) redactSecrets = !!changes.redactSecrets.newValue;
  if ("redactPii" in changes) redactPiiOn = !!changes.redactPii.newValue;
});

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

function capturePromptSubmit() {
  if (!captureEnabled) return;
  const input = resolve(S.promptInput) as HTMLTextAreaElement | null;
  if (!input) {
    consecutiveMisses++;
    return;
  }
  consecutiveMisses = 0;
  const text = input.value || (input as HTMLElement).innerText || "";
  if (!text.trim()) return;
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
    }),
  );
}

function attachPromptListeners() {
  document.addEventListener("click", (ev) => {
    const target = ev.target as Element | null;
    if (!target) return;
    const btn = target.closest("button");
    if (!btn) return;
    if (
      btn.getAttribute("data-testid") === "send-button" ||
      (btn.getAttribute("aria-label") || "").includes("Send")
    ) {
      setTimeout(capturePromptSubmit, 0);
    }
  }, true);

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.shiftKey) return;
    const t = ev.target as Element | null;
    if (!t || !(t.matches("textarea") || t.matches('div[contenteditable="true"]'))) return;
    setTimeout(capturePromptSubmit, 0);
  }, true);
}

// 🔒 LOCKED [RESPONSE-DEDUPE-CHATGPT] — 2026-06-23
// ⛔ NEVER put `text.length` back in the dedupe key (responses or tool calls).
//    Same root cause as the claude.ts streaming over-emit bug: length grows
//    on every settle during streaming, length-in-key churns, dedupe Set
//    misses, re-emit. Length stays OUT. See LOCK in claude.ts captureResponses
//    for the full incident summary.
// ⛔ NEVER emit tool_calls without a done-marker check. ChatGPT streams tool
//    arguments token-by-token too — without a stream-done gate, each
//    characterData mutation produces a new dedupe key. The audit during the
//    workflow on 2026-06-23 flagged this as the SAME bug class as responses.
// WHY: Mirror of the fix in claude.ts. Keeping the two files near-identical
//    (rather than parameterizing into a single helper) is the explicit
//    architectural call from the file header — surface-specific quirks tend
//    to leak through any abstraction.
// FIX: If ChatGPT changes the per-turn ancestor selector
//    (`data-message-author-role="assistant"` / `data-message-id`), patch
//    the `turn.closest(...)` line and update CHATGPT_SELECTORS.

function captureResponses() {
  if (!captureEnabled) return;
  // Use resolveAll — primary-first, fallback-only-if-empty. The OR pattern
  // double-matches when fallback is a descendant/ancestor of primary. See
  // LOCK [RESPONSE-DEDUPE-CHATGPT] above, and the same fix in claude.ts.
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

    // Per-turn done check — copy button inside the assistant turn container.
    // ChatGPT's `data-message-author-role="assistant"` ancestor is stable
    // and contains the action toolbar with the copy button as a sibling
    // of the markdown block.
    const turn = block.closest('div[data-message-author-role="assistant"], div[data-message-id]');
    const done = turn?.querySelector(S.streamDoneMarker.primary) ||
                  turn?.querySelector(S.streamDoneMarker.fallback);
    if (!done) continue;

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

function captureToolCalls() {
  if (!captureEnabled) return;
  const blocks = resolveAll(S.toolCallBlock);
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const text = (block as HTMLElement).innerText || "";
    if (!text.trim()) continue;

    // Done check — a tool call is finished when its enclosing assistant
    // turn has the copy button. Without this gate, streaming tool args
    // emit on every characterData mutation. See LOCK above.
    const turn = block.closest('div[data-message-author-role="assistant"], div[data-message-id]');
    const done = turn?.querySelector(S.streamDoneMarker.primary) ||
                  turn?.querySelector(S.streamDoneMarker.fallback);
    if (!done) continue;

    // Dedupe key: position + first 64 chars (shorter than the old 200 to
    // be more forgiving of trivial format drift, and consistent with the
    // response dedupe shape). NO LENGTH — see LOCK above.
    const key = `t:${i}:${text.slice(0, 64)}`;
    if (emittedToolCalls.has(key)) continue;
    emittedToolCalls.add(key);

    const nameEl = block.querySelector("code, [class*='font-mono']");
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

async function boot() {
  await loadConfig();
  if (!captureEnabled) {
    setTimeout(boot, 5_000);
    return;
  }
  attachPromptListeners();
  debounceSettle(document.body, 750, () => {
    captureResponses();
    captureToolCalls();
  });

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastConversationId = conversationIdFromUrl(lastUrl);
      emittedResponses.clear();
      emittedToolCalls.clear();
      emitEvent(buildEvent("browser.session_start", SURFACE, {
        conversation_id: lastConversationId,
      }));
    }
  }, 1_000);

  let lastMissCheck = Date.now();
  setInterval(() => {
    if (consecutiveMisses > 30 && Date.now() - lastMissCheck > 60_000) {
      lastMissCheck = Date.now();
      emitEvent(buildEvent("browser.capture_miss", SURFACE, {
        error: `ChatGPT selectors failed ${consecutiveMisses}× in last 60s. DOM may have changed.`,
      }));
      consecutiveMisses = 0;
    }
  }, 30_000);

  setTimeout(() => {
    captureResponses();
    captureToolCalls();
  }, 1_500);
}

boot().catch((err) => console.debug("[OpsContext chatgpt.com] boot failed:", err));

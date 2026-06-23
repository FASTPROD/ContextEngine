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

import { CLAUDE_SELECTORS as S, resolve } from "./shared/selectors.js";
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
  const nodes = document.querySelectorAll(
    S.userMessage.primary + ", " + S.userMessage.fallback,
  );
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

function captureResponses() {
  if (!captureEnabled) return;
  const list = resolve(S.messageList);
  if (!list) {
    consecutiveMisses++;
    return;
  }

  // Find all assistant markdown blocks. For each, check if it's "done" (the
  // copy button appears) and we haven't emitted it yet.
  const blocks = list.querySelectorAll(S.assistantMarkdown.primary + ", " + S.assistantMarkdown.fallback);
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    // Use a stable key: position + length. Not perfect, but the dedupe is
    // belt-and-braces because debounceSettle already debounces.
    const text = (block as HTMLElement).innerText || "";
    if (!text.trim()) continue;
    const key = `${i}:${text.length}:${text.slice(0, 64)}`;
    if (emittedResponses.has(key)) continue;

    // Check for the done marker NEAR this block (in its action toolbar).
    const turn = block.closest('div[data-testid^="conversation-turn-"], main > div > div');
    const done = turn?.querySelector(S.streamDoneMarker.primary) ||
                  turn?.querySelector(S.streamDoneMarker.fallback);
    if (!done) continue;

    emittedResponses.add(key);
    const { text: redactedText, redacted, counts } = applyRedaction(text);
    emitEvent(
      buildEvent("browser.response", SURFACE, {
        conversation_id: lastConversationId || conversationIdFromUrl(location.href),
        text: redactedText,
        char_count: text.length,
        redacted,
        redaction_counts: redacted ? counts : undefined,
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
  const blocks = list.querySelectorAll(
    S.toolCallBlock.primary + ", " + S.toolCallBlock.fallback,
  );
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

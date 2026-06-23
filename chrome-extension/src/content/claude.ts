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

function capturePromptSubmit() {
  if (!captureEnabled) return;
  const input = resolve(S.promptInput);
  if (!input) {
    consecutiveMisses++;
    return;
  }
  consecutiveMisses = 0;

  // Read BEFORE the input clears on submit.
  const text = (input as HTMLElement).innerText || "";
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
  // Submit-button click (delegated; the button rerenders).
  document.addEventListener("click", (ev) => {
    const target = ev.target as Element | null;
    if (!target) return;
    const btn = target.closest("button");
    if (!btn) return;
    if (
      btn.getAttribute("aria-label") === "Send message" ||
      btn.getAttribute("type") === "submit"
    ) {
      // Read on the event-loop turn AFTER the click so React has flushed.
      setTimeout(capturePromptSubmit, 0);
    }
  }, true);

  // Enter without Shift on the contenteditable.
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.shiftKey) return;
    const t = ev.target as Element | null;
    if (!t || !t.matches('div[contenteditable="true"]')) return;
    setTimeout(capturePromptSubmit, 0);
  }, true);
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

  attachPromptListeners();

  // Watch the whole page for response/tool changes; debounceSettle fires when
  // the streaming completes (no DOM mutations for 750ms).
  debounceSettle(document.body, 750, () => {
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

  // Initial scan in case responses are already on screen when the page loads.
  setTimeout(() => {
    captureResponses();
    captureToolCalls();
  }, 1_500);
}

boot().catch((err) => {
  console.debug("[OpsContext claude.ai] boot failed:", err);
});

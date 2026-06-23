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

import { CHATGPT_SELECTORS as S, resolve } from "./shared/selectors.js";
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

function captureResponses() {
  if (!captureEnabled) return;
  const blocks = document.querySelectorAll(
    S.assistantMarkdown.primary + ", " + S.assistantMarkdown.fallback,
  );
  if (blocks.length === 0) {
    consecutiveMisses++;
    return;
  }
  consecutiveMisses = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const text = (block as HTMLElement).innerText || "";
    if (!text.trim()) continue;
    const key = `${i}:${text.length}:${text.slice(0, 64)}`;
    if (emittedResponses.has(key)) continue;
    // ChatGPT's done marker = the copy button in the turn-action toolbar.
    const turn = block.closest('div[data-message-author-role="assistant"], div[data-message-id]');
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

function captureToolCalls() {
  if (!captureEnabled) return;
  const blocks = document.querySelectorAll(
    S.toolCallBlock.primary + ", " + S.toolCallBlock.fallback,
  );
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const text = (block as HTMLElement).innerText || "";
    const key = `${i}:${text.slice(0, 200)}`;
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

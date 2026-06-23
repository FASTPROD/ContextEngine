// 🔒 LOCKED [SELECTORS] — 2026-06-22
// ⛔ NEVER hardcode a single selector path. The two-tier model (testid → structural)
//    is the only way to survive Anthropic / OpenAI DOM churn. If a selector breaks,
//    add a new entry to the FALLBACKS array — do NOT replace the primary in place
//    (the old primary might still resolve in older browser cache states).
// ⛔ NEVER capture from a frame that isn't `top` (all_frames:false in manifest).
//    Anthropic embeds rendered LaTeX iframes that contain prompt text echoes.
// WHY: DOM selectors break silently. Two-tier with the CI fixture smoke test in
//    LICENSE_THIRD_PARTY.md is the contract that catches "anthropic shipped a
//    redesign overnight" before the user notices missing events.
// FIX: To migrate to a v2 selector set, add the new selectors as tier-3 entries
//    until the live-site smoke confirms they hit, then promote.
//
// ─────────────────────────────────────────────────────────────────────────────
//
// Selector seeds adapted (under MIT license, attributed in LICENSE_THIRD_PARTY.md)
// from these prior-art Chrome extensions verified live as of 2026-05-24:
//   • Couchraver/claude-chatgpt-gemini-downloader (14⭐, MIT)
//   • xvfeiran/ChatExporter (2⭐, MIT)
//
// We use ONLY the selector constants. The capture architecture (streaming vs
// one-shot export), the audit-chain integration, the policy enforcement, and
// the privacy redaction are entirely original to OpsContext.

export interface SelectorTier {
  /** Primary preferred selector — usually a data-testid that ships from React. */
  primary: string;
  /** Structural fallback — used when primary returns null for 3+ consecutive observer firings. */
  fallback: string;
}

// ─── claude.ai ───────────────────────────────────────────────────────────────

export const CLAUDE_SELECTORS = {
  // The element the user types into. Captured on submit.
  promptInput: {
    primary: 'div[contenteditable="true"][data-testid="chat-input"]',
    fallback: 'div[contenteditable="true"][role="textbox"]',
  },
  // The "Send" button. We listen for click + Enter-without-Shift on the input.
  submitButton: {
    primary: 'button[aria-label="Send message"]',
    fallback: 'button[type="submit"]',
  },
  // The container that holds the full conversation. Root for the MutationObserver.
  messageList: {
    primary: 'div[data-testid="conversation-turn-list"]',
    fallback: 'main',
  },
  // The assistant's response markdown — read AFTER streaming completes.
  assistantMarkdown: {
    primary: 'div.font-claude-message',
    fallback: 'div.prose',
  },
  // A button that appears ONLY when streaming is complete. Our signal that a
  // response is final and ready to emit.
  streamDoneMarker: {
    primary: 'button[aria-label="Copy"]',
    fallback: 'button[aria-label="Copy to clipboard"]',
  },
  // Tool-use blocks (web search, computer use, etc.) when the assistant uses one.
  toolCallBlock: {
    primary: 'div[data-testid="tool-use-block"]',
    fallback: 'div[class*="tool-use"]',
  },
  // Conversation title in the page chrome — used as the conversation_id seed.
  conversationTitle: {
    primary: 'h1[data-testid="conversation-title"]',
    fallback: 'h1',
  },
} satisfies Record<string, SelectorTier>;

// ─── chatgpt.com ─────────────────────────────────────────────────────────────

export const CHATGPT_SELECTORS = {
  promptInput: {
    primary: '#prompt-textarea',
    fallback: 'textarea[data-testid="prompt-textarea"]',
  },
  submitButton: {
    primary: 'button[data-testid="send-button"]',
    fallback: 'button[aria-label*="Send"]',
  },
  messageList: {
    primary: 'main div[data-testid="conversation-turn-2"]',
    fallback: 'main',
  },
  assistantMessage: {
    primary: 'div[data-message-author-role="assistant"]',
    fallback: 'div[data-message-id]',
  },
  assistantMarkdown: {
    primary: 'div[data-message-author-role="assistant"] .markdown',
    fallback: 'div[data-message-author-role="assistant"]',
  },
  streamDoneMarker: {
    primary: 'button[data-testid="copy-turn-action-button"]',
    fallback: 'button[aria-label*="Copy"]',
  },
  toolCallBlock: {
    primary: 'div[data-testid*="tool-use"]',
    fallback: 'div[class*="tool-result"]',
  },
  conversationTitle: {
    primary: 'h1.text-token-text-primary',
    fallback: 'h1',
  },
} satisfies Record<string, SelectorTier>;

/**
 * Resolve a SelectorTier against a root element. Tries primary first, falls
 * back to structural on null. Returns null if BOTH miss — emit
 * `browser.capture_miss` upstream so the user knows the DOM changed under us.
 */
export function resolve(
  tier: SelectorTier,
  root: ParentNode = document,
): Element | null {
  try {
    const hit = root.querySelector(tier.primary);
    if (hit) return hit;
  } catch {
    // invalid selector (e.g., browser doesn't support a syntax) — fall through
  }
  try {
    return root.querySelector(tier.fallback);
  } catch {
    return null;
  }
}

export function resolveAll(
  tier: SelectorTier,
  root: ParentNode = document,
): Element[] {
  try {
    const hits = Array.from(root.querySelectorAll(tier.primary));
    if (hits.length > 0) return hits;
  } catch {
    /* ignore */
  }
  try {
    return Array.from(root.querySelectorAll(tier.fallback));
  } catch {
    return [];
  }
}

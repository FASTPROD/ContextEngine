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

// Updated 2026-06-23 against live claude.ai/new DOM (logged-in chat surface).
// What Anthropic shipped between 2026-05-24 (original seed) and now:
//   • assistant container: div.font-claude-message → div.font-claude-response
//   • markdown fallback:  div.prose              → div.standard-markdown
//   • copy marker:         button[aria-label="Copy"] → button[data-testid="action-bar-copy"]
//   • dropped:             [data-testid="conversation-turn-list"]  (fall through to <main>)
//   • added:               [data-testid="user-message"]  ← rendered user turn — far more
//                          reliable than intercepting the contenteditable before React
//                          clears it. We now read THIS as the source of truth for the
//                          user's prompt text.
export const CLAUDE_SELECTORS = {
  // The element the user types into. Kept for backwards compatibility (popup
  // diagnostics use it). NOT used for capture anymore — see userMessage below.
  promptInput: {
    primary: 'div[contenteditable="true"][data-testid="chat-input"]',
    fallback: 'div[contenteditable="true"][role="textbox"]',
  },
  // The rendered user turn after submission. **PRIMARY capture source for
  // browser.prompt** as of 2026-06-23 — survives React's input-clear race
  // because the DOM node only appears AFTER React has flushed the submit.
  userMessage: {
    primary: '[data-testid="user-message"]',
    fallback: 'div[class*="user-message"]',
  },
  // The "Send" button. Currently no aria-label match on logged-in claude.ai;
  // the user-message-based capture path doesn't depend on this. Kept for
  // possible future use.
  submitButton: {
    primary: 'button[aria-label="Send message"]',
    fallback: 'button[type="submit"]',
  },
  // The container that holds the full conversation. Anthropic dropped the
  // conversation-turn-list testid; we fall through to <main> which is stable.
  messageList: {
    primary: 'div[data-testid="conversation-turn-list"]',
    fallback: 'main',
  },
  // The assistant's response markdown — read AFTER streaming completes.
  // Anthropic uses `font-claude-response` (the outer block) wrapping a
  // `standard-markdown` inner. We match either since either contains the text.
  assistantMarkdown: {
    primary: 'div.font-claude-response',
    fallback: 'div.standard-markdown',
  },
  // A button that appears ONLY when streaming is complete. Our signal that a
  // response is final and ready to emit. Anthropic uses a testid now.
  streamDoneMarker: {
    primary: 'button[data-testid="action-bar-copy"]',
    fallback: 'button[aria-label*="Copy" i]',
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

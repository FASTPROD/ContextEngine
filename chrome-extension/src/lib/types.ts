/**
 * Wire format for events the content script captures and the service worker
 * batches + POSTs to the local MCP server. The server adds `prev_hash` + `hash`
 * via the existing safeAppend() chain, so what we serialize here is the
 * pre-chained record.
 *
 * Stable across the Chrome extension <-> MCP server interface. Versioned via
 * the `v` field — bump only with a coordinated MCP server release.
 */

export type BrowserEventKind =
  | "browser.prompt"
  | "browser.response"
  | "browser.tool_call"
  | "browser.session_start"
  | "browser.capture_miss"; // emitted when both selector tiers fail

export interface BrowserEvent {
  v: 1;
  ts: string; // ISO 8601
  event: BrowserEventKind;
  actor: "browser-ext";
  payload: {
    surface: "claude.ai" | "chatgpt.com";
    conversation_id?: string;
    text?: string; // post-redaction
    char_count?: number;
    tool?: string;
    args_preview?: string;
    stream_ms?: number;
    model_hint?: string;
    redacted?: boolean;
    redaction_counts?: Record<string, number>;
    error?: string;
    [k: string]: unknown;
  };
}

export interface ExtensionConfig {
  /** 32-byte hex secret shared with the local MCP server. */
  secret: string | null;
  /** Endpoint URL — defaults to http://127.0.0.1:7842/events. */
  endpoint: string;
  /** Per-domain opt-out. */
  captureClaudeAi: boolean;
  captureChatGptCom: boolean;
  /** Redaction toggles. */
  redactSecrets: boolean;
  redactPii: boolean;
  /** UI: max events to show in the popup queue display. */
  popupQueueCap: number;
}

// 🔒 LOCKED [CAPTURE-OPT-IN] — 2026-06-23
// ⛔ NEVER flip captureClaudeAi or captureChatGptCom default to `true`.
// WHY: Audit FRESH_USER_AUDIT_2026-06-23.md finding H1 (CWS deceptive-
//   description + privacy surprise). The Web Store listing says "opt-in
//   per-domain capture" — that promise requires both toggles default OFF.
//   Capturing-before-consent is a User Data Policy violation AND surprises
//   users who paste a secret weeks later (queued pre-consent events would
//   transmit). Defense in depth: service-worker.ts ALSO drops events at
//   onMessage when no secret is set.
// FIX: If a future feature wants capture-by-default, the consent UX must
//   move into install — first-run popup with explicit per-domain checkboxes
//   pre-checked, NOT a silent default-on in this file.
export const DEFAULT_CONFIG: ExtensionConfig = {
  secret: null,
  endpoint: "http://127.0.0.1:7842/events",
  captureClaudeAi: false,
  captureChatGptCom: false,
  redactSecrets: true,
  redactPii: false,
  popupQueueCap: 25,
};

export interface QueuedBatch {
  events: BrowserEvent[];
  attempts: number;
  firstQueuedAt: number;
}

/** Status the popup polls from the SW via chrome.runtime.sendMessage. */
export interface CaptureStatus {
  state: "ok" | "queued" | "paused" | "error" | "unauthenticated";
  queueLength: number;
  lastSendAt: number | null;
  lastError: string | null;
  recentEvents: Array<{ ts: string; surface: string; kind: string; preview: string }>;
}

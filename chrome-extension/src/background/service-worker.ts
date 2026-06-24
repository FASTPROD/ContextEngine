/**
 * Service worker — receives events from content scripts, batches them,
 * POSTs to the local MCP server (default http://127.0.0.1:7842/events),
 * and survives MV3 hibernation via chrome.storage.session for the in-flight
 * queue + chrome.alarms for the periodic flush.
 *
 * Failure modes:
 *   - MCP server not running   → events stay queued, popup shows amber dot
 *   - Wrong secret             → 401 from server, popup shows red dot
 *   - Network unreachable      → backoff (5s, 15s, 60s, 5min)
 *   - Queue overflow (1000+)   → oldest events drop with a queue.overflow
 *                                synthetic event when service recovers
 */

import type {
  BrowserEvent,
  ExtensionConfig,
  CaptureStatus,
  QueuedBatch,
} from "../lib/types.js";
import { DEFAULT_CONFIG } from "../lib/types.js";

const FLUSH_ALARM_NAME = "opscontext.flush";
const FLUSH_INTERVAL_MIN = 0.05; // ~3 seconds (chrome.alarms minimum is ~30s in prod; 0.05 is dev — Chrome enforces 1min min in MV3 prod)
const PROD_FLUSH_INTERVAL_MIN = 1; // ~60s — production-safe
const MAX_QUEUE = 1000;
const MAX_BATCH = 50;
const QUEUE_KEY = "opscontext.queue";
const STATUS_KEY = "opscontext.status";

let inFlight = false;
let backoffMs = 0;
let lastError: string | null = null;
let lastSendAt: number | null = null;
const recentEvents: CaptureStatus["recentEvents"] = [];

// ─── Config loading ─────────────────────────────────────────────────────────

async function getConfig(): Promise<ExtensionConfig> {
  const stored = await chrome.storage.local.get(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...stored };
}

// ─── Queue persistence (survives SW hibernation) ─────────────────────────────

async function loadQueue(): Promise<BrowserEvent[]> {
  const { [QUEUE_KEY]: q } = await chrome.storage.session.get({ [QUEUE_KEY]: [] });
  return Array.isArray(q) ? q : [];
}

async function saveQueue(q: BrowserEvent[]) {
  await chrome.storage.session.set({ [QUEUE_KEY]: q });
}

async function enqueue(event: BrowserEvent) {
  const q = await loadQueue();
  q.push(event);
  // Overflow: drop oldest, append a synthetic overflow marker on the boundary.
  if (q.length > MAX_QUEUE) {
    const dropped = q.length - MAX_QUEUE;
    q.splice(0, dropped);
    q.push({
      v: 1,
      ts: new Date().toISOString(),
      event: "browser.capture_miss",
      actor: "browser-ext",
      payload: {
        surface: event.payload.surface,
        error: `queue.overflow: dropped ${dropped} oldest events; flush had been failing.`,
      },
    });
  }
  await saveQueue(q);
  recordRecent(event);
}

function recordRecent(event: BrowserEvent) {
  const preview = String(event.payload.text || event.payload.tool || "").slice(0, 60);
  recentEvents.unshift({
    ts: event.ts,
    surface: String(event.payload.surface),
    kind: event.event,
    preview,
  });
  if (recentEvents.length > 25) recentEvents.length = 25;
}

// ─── Flush loop ─────────────────────────────────────────────────────────────

async function flush() {
  if (inFlight) return;
  if (backoffMs > 0 && Date.now() < (lastSendAt || 0) + backoffMs) return;

  const q = await loadQueue();
  if (q.length === 0) return;

  const config = await getConfig();
  if (!config.secret) {
    lastError = "No secret configured. Open the extension options.";
    await persistStatus(config);
    return;
  }

  inFlight = true;
  const batch = q.slice(0, MAX_BATCH);
  try {
    const res = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpsContext-Secret": config.secret,
      },
      body: JSON.stringify({ events: batch }),
    });

    if (res.status === 401) {
      lastError = "Server rejected secret (401). Re-paste secret in options.";
      backoffMs = 60_000; // hold off — re-flushing won't help
      inFlight = false;
      await persistStatus(config);
      return;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    // Success: drop the sent batch from the queue.
    const remaining = q.slice(batch.length);
    await saveQueue(remaining);
    lastSendAt = Date.now();
    lastError = null;
    backoffMs = 0;
    await persistStatus(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastError = msg;
    // Exponential backoff capped at 5min.
    backoffMs = Math.min(backoffMs ? backoffMs * 2 : 5_000, 300_000);
    await persistStatus(config);
  } finally {
    inFlight = false;
  }
}

// ─── Status surface for popup ───────────────────────────────────────────────

async function persistStatus(config: ExtensionConfig) {
  const queueLength = (await loadQueue()).length;
  const state: CaptureStatus["state"] = (() => {
    if (!config.secret) return "unauthenticated";
    if (lastError) return queueLength > 0 ? "error" : "error";
    if (queueLength > 0) return "queued";
    return "ok";
  })();
  const status: CaptureStatus = {
    state,
    queueLength,
    lastSendAt,
    lastError,
    recentEvents: recentEvents.slice(0, config.popupQueueCap),
  };
  await chrome.storage.session.set({ [STATUS_KEY]: status });
}

// ─── Message handling ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "opscontext.event" && msg.event) {
    (async () => {
      // 🔒 LOCKED [DROP-PRE-CONSENT] — 2026-06-23
      // ⛔ NEVER enqueue an event when config.secret is null. The pre-consent
      //    queue would silently transmit weeks-old captures the moment the
      //    user pastes a secret — a privacy surprise + CWS User Data Policy
      //    violation. See FRESH_USER_AUDIT_2026-06-23.md finding H1.
      // FIX: Drop the event, surface the reason in lastError so the popup
      //    explains "Capture paused — paste secret in Options to enable."
      //    Belt-and-braces with DEFAULT_CONFIG.captureClaudeAi=false so the
      //    content script also won't capture in the first place.
      const config = await getConfig();
      if (!config.secret) {
        lastError = "Capture paused — paste your secret in Options to enable. (No events are stored.)";
        await persistStatus(config);
        sendResponse({ ok: false, reason: "no-secret" });
        return;
      }
      await enqueue(msg.event as BrowserEvent);
      // Opportunistic immediate flush — alarms are coarse.
      void flush();
      sendResponse({ ok: true });
    })();
    return true; // async response
  }
  if (msg?.type === "opscontext.status") {
    (async () => {
      const { [STATUS_KEY]: status } = await chrome.storage.session.get({
        [STATUS_KEY]: null,
      });
      sendResponse({ ok: true, status });
    })();
    return true;
  }
  if (msg?.type === "opscontext.flush_now") {
    (async () => {
      backoffMs = 0;
      await flush();
      sendResponse({ ok: true });
    })();
    return true;
  }
  return false;
});

// ─── Alarms ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create(FLUSH_ALARM_NAME, {
    periodInMinutes: PROD_FLUSH_INTERVAL_MIN,
  });
  // 🔒 LOCKED [FIRST-RUN-NUDGE] — 2026-06-23
  // ⛔ NEVER drop the on-install Options-page open. Audit
  //   FRESH_USER_AUDIT_2026-06-23.md H1 caught this regression: with
  //   capture defaulting to OFF, a brand-new user lands on claude.ai,
  //   types a prompt, sees nothing happen, and has no signpost to the
  //   Options page. Opening Options on install IS the signpost.
  // FIX: If a future packaging surface (e.g. enterprise managed install)
  //   needs to suppress the popup, gate on details.reason === 'install'
  //   AND a chrome.storage.managed flag — don't just remove this block.
  if (details.reason === "install") {
    void chrome.runtime.openOptionsPage();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM_NAME) {
    void flush();
  }
});

// 🔒 LOCKED [STARTUP-STATUS] — 2026-06-23
// ⛔ NEVER skip the startup persistStatus call. With capture defaulting
//   to OFF (H1), content scripts no longer trigger the SW onMessage path
//   for a fresh user, so the lastError fallback never sets a useful
//   message. Without this startup write, the popup shows state=null →
//   grey dot → "loading…" forever. The user has no signpost.
// WHY: Audit FRESH_USER_AUDIT_2026-06-23.md H1 verifier round-2 caught
//   the dead-lastError defect introduced by the original H1 fix.
// FIX: On SW wakeup, publish an honest initial status:
//   - no secret           → "Capture paused — paste your secret in Options."
//   - secret but capture off for both domains → "Capture is paused on
//                                                claude.ai AND chatgpt.com.
//                                                Enable in Options."
//   - otherwise           → normal flow takes over
async function publishStartupStatus() {
  const config = await getConfig();
  if (!config.secret) {
    lastError = "Capture paused — paste your secret in Options to enable.";
  } else if (!config.captureClaudeAi && !config.captureChatGptCom) {
    lastError = "Capture is off for both Claude.ai and ChatGPT.com. Enable per-domain in Options.";
  }
  await persistStatus(config);
}
void publishStartupStatus().then(() => {
  // After publishing initial state, attempt one flush in case a prior
  // session left a queue. flush() is a no-op if !secret or queue empty.
  void flush();
});

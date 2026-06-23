/**
 * Thin wrapper around chrome.runtime.sendMessage so content scripts don't have
 * to deal with the message protocol directly. Returns void on success;
 * swallows "Extension context invalidated" errors that happen on reload.
 */

import type { BrowserEvent } from "../../lib/types.js";

export async function emitEvent(event: BrowserEvent): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "opscontext.event", event });
  } catch (err) {
    // Common case: SW reloaded mid-page; the message bus is briefly invalid.
    // Drop the event rather than blocking the page. Next emit will retry the
    // connection and the SW will start fresh.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Extension context invalidated") &&
        !msg.includes("Receiving end does not exist")) {
      console.debug("[OpsContext] emit failed:", msg);
    }
  }
}

/**
 * Build a BrowserEvent with the boilerplate filled in. Just provide the kind,
 * surface, and payload extras.
 */
export function buildEvent(
  kind: BrowserEvent["event"],
  surface: BrowserEvent["payload"]["surface"],
  extras: Partial<BrowserEvent["payload"]> = {},
): BrowserEvent {
  return {
    v: 1,
    ts: new Date().toISOString(),
    event: kind,
    actor: "browser-ext",
    payload: { surface, ...extras },
  };
}

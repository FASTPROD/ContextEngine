// 🔒 LOCKED [HTTP-EVENT-INGEST] — 2026-06-23
// ⛔ NEVER bind to 0.0.0.0 — only 127.0.0.1. The threat model is "browser
//    extension running on the same machine"; a network-reachable port would
//    let any device on the LAN inject audit events.
// ⛔ NEVER compare the secret with `===` — use timingSafeEqual. String compare
//    leaks timing info that lets a remote attacker brute-force the secret
//    one byte at a time.
// ⛔ NEVER auto-generate the secret on first request. The CLI must create it
//    explicitly (so a stray client can't bootstrap itself into the audit log).
//    Refuse with 401 if ~/.contextengine/extension-secret is missing.
// ⛔ NEVER write events before validating shape — a malformed event in the
//    audit log corrupts the chain verifier and ruins compliance evidence.
// WHY: This is the only network surface OpsContext exposes locally. Every
//    decision here is about keeping it auth-required, scope-bound, and shape-
//    validated, because the audit log is the foundation everything else
//    builds on.
// FIX: To add more endpoints, follow the same auth + validation pattern. Do
//    not add a /raw-write or /admin route without a separate secret + a
//    separate LOCK comment explaining why.

import * as http from "http";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { timingSafeEqual } from "crypto";
import { safeAppend, type AuditEvent } from "./audit.js";

const PORT = parseInt(process.env.OPSCONTEXT_EVENT_PORT || "7842", 10);
const HOST = "127.0.0.1";
const SECRET_FILE = join(homedir(), ".contextengine", "extension-secret");
const MAX_BODY = 64 * 1024; // 64 KB per batch
const MAX_BATCH = 50;

let serverInstance: http.Server | null = null;

interface IncomingEvent {
  v?: number;
  ts?: string;
  event?: string;
  actor?: string;
  payload?: Record<string, unknown>;
}

interface IncomingBatch {
  events: IncomingEvent[];
}

/** Hot-reload the secret from disk so the CLI can rotate without restarting MCP. */
function loadSecret(): string | null {
  try {
    if (!existsSync(SECRET_FILE)) return null;
    return readFileSync(SECRET_FILE, "utf-8").trim();
  } catch {
    return null;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers — short-circuit on mismatch
  // length but only via Buffer.byteLength so we don't leak via string-length
  // comparison early-exit. Acceptable because length isn't a secret.
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/** Validate an event has the minimum shape we'll write to audit. */
function validateEvent(e: IncomingEvent, idx: number): string | null {
  if (typeof e !== "object" || e === null) return `events[${idx}]: not an object`;
  if (e.v !== 1) return `events[${idx}]: missing or unsupported version field (v=${e.v})`;
  if (typeof e.event !== "string" || !e.event) return `events[${idx}]: missing event kind`;
  if (typeof e.ts !== "string" || !e.ts) return `events[${idx}]: missing ts`;
  if (typeof e.payload !== "object" || e.payload === null) return `events[${idx}]: missing payload object`;
  // Restrict event kinds to the browser.* + vscode.* + cli.* namespaces.
  // The audit module's own writers use other kinds (learning.save etc.);
  // those events come from the LOCAL server, not the network surface.
  if (!/^(browser|vscode|cli)\./.test(e.event)) {
    return `events[${idx}]: event kind '${e.event}' not allowed via HTTP (only browser.*/vscode.*/cli.*)`;
  }
  return null;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    // Belt-and-braces: even though the manifest's host_permissions already
    // lets the SW POST without preflight, we set the response header so
    // future popup-side probe pings work too.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-OpsContext-Secret",
  });
  res.end(json);
}

function handleEvents(req: http.IncomingMessage, res: http.ServerResponse) {
  const secret = loadSecret();
  if (!secret) {
    sendJson(res, 401, {
      ok: false,
      error: "no_secret_configured",
      hint: "Run: contextengine init-extension-secret",
    });
    return;
  }
  const provided = req.headers["x-opscontext-secret"];
  if (typeof provided !== "string" || !constantTimeEqual(provided, secret)) {
    sendJson(res, 401, { ok: false, error: "bad_secret" });
    return;
  }

  let bytes = 0;
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_BODY) {
      req.destroy();
      sendJson(res, 413, { ok: false, error: "payload_too_large", limit: MAX_BODY });
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    let batch: IncomingBatch;
    try {
      batch = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      sendJson(res, 400, { ok: false, error: "bad_json" });
      return;
    }
    if (!batch || !Array.isArray(batch.events)) {
      sendJson(res, 400, { ok: false, error: "missing_events_array" });
      return;
    }
    if (batch.events.length > MAX_BATCH) {
      sendJson(res, 400, { ok: false, error: "batch_too_large", limit: MAX_BATCH });
      return;
    }
    // Validate every event BEFORE writing any of them.
    for (let i = 0; i < batch.events.length; i++) {
      const err = validateEvent(batch.events[i], i);
      if (err) {
        sendJson(res, 400, { ok: false, error: "invalid_event", detail: err });
        return;
      }
    }
    // All valid — write them to audit log via safeAppend.
    let written = 0;
    for (const ev of batch.events) {
      const actor = typeof ev.actor === "string" ? ev.actor : "browser-ext";
      // event/payload were validated above — cast is safe.
      safeAppend(ev.event as AuditEvent, ev.payload!, actor);
      written++;
    }
    sendJson(res, 200, { ok: true, written });
  });
}

function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse) {
  sendJson(res, 200, {
    ok: true,
    service: "opscontext-event-ingest",
    port: PORT,
    secretConfigured: loadSecret() !== null,
  });
}

function handleOptions(_req: http.IncomingMessage, res: http.ServerResponse) {
  // CORS preflight — the SW shouldn't need this thanks to host_permissions,
  // but answering it cleanly costs nothing and helps popup probes.
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-OpsContext-Secret",
    "Access-Control-Max-Age": "600",
  });
  res.end();
}

/**
 * Boot the local event-ingest HTTP server. Returns the listening port or null
 * if the port was already in use (caller may decide whether to retry on
 * another port or surface the error).
 *
 * Safe to call multiple times — second call returns the existing server.
 */
export function startEventIngestServer(): Promise<number | null> {
  if (serverInstance) {
    const addr = serverInstance.address();
    return Promise.resolve(typeof addr === "object" && addr ? addr.port : PORT);
  }
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      try {
        if (req.method === "OPTIONS") return handleOptions(req, res);
        const url = req.url || "/";
        if (req.method === "POST" && url.startsWith("/events")) return handleEvents(req, res);
        if (req.method === "GET" && url.startsWith("/health")) return handleHealth(req, res);
        sendJson(res, 404, { ok: false, error: "not_found" });
      } catch (err) {
        console.error("[ContextEngine] event-ingest error:", err);
        try {
          sendJson(res, 500, { ok: false, error: "internal" });
        } catch {
          /* ignore — response may already be closed */
        }
      }
    });
    srv.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `[ContextEngine] ⚠ port ${PORT} already in use — browser-event ingest disabled.\n` +
            `  Set OPSCONTEXT_EVENT_PORT=<n> to use a different port (must also update extension options).`,
        );
        resolve(null);
        return;
      }
      console.error("[ContextEngine] event-ingest server error:", err);
      resolve(null);
    });
    srv.listen(PORT, HOST, () => {
      serverInstance = srv;
      console.error(
        `[ContextEngine] 🌐 event-ingest on http://${HOST}:${PORT} ` +
          (loadSecret() ? "(secret loaded)" : "(NO SECRET — run `contextengine init-extension-secret`)"),
      );
      resolve(PORT);
    });
  });
}

export function stopEventIngestServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!serverInstance) return resolve();
    serverInstance.close(() => {
      serverInstance = null;
      resolve();
    });
  });
}

// Test helpers (not exported in dist surface in production use — but the
// module is small enough that tests can import them directly).
export const _internal = {
  loadSecret,
  constantTimeEqual,
  validateEvent,
  SECRET_FILE,
  PORT,
};

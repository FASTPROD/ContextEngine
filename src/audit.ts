// 🔒 LOCKED [AUDIT-CHAIN] — 2026-06-10
// ⛔ NEVER change the canonical serialization in computeHash() — key order,
//    field names, JSON.stringify behavior, or genesis hash value. Any change
//    breaks verification of every audit log written by an older client.
// ⛔ NEVER swap SHA-256 for a different hash without a migration path.
// ⛔ NEVER catch errors inside appendAudit() — silent failures defeat the
//    entire compliance story. Use safeAppend() at call sites if you need
//    failure isolation; appendAudit() must surface problems loudly.
// WHY: This is the bedrock for evidence aligned with SOC 2 CC7.2 (change
//    monitoring) and ISO 27001 A.12.4.1 (event logging). These are
//    EVIDENCE ARTIFACTS — OpsContext is NOT itself SOC 2– or ISO 27001–
//    certified; the chain helps a deploying org's auditor satisfy those
//    controls. See docs/compliance/cc7.2.md + docs/compliance/a.12.4.1.md.
//    Any silent break here destroys evidence value across years of
//    records and invalidates the chain integrity property downstream
//    code (verifyChain, license signatures, enforcement telemetry)
//    depends on.
// FIX: If you need to evolve the record format, version the chain
//    (add a "v":2 field) and keep verifyChain() backward-compatible by
//    dispatching on the v field. Don't mutate the v=1 contract.
//
// 🔒 LOCKED [AUDIT-001-WRITE-RACE-FIX] — 2026-06-24
// ⛔ NEVER remove the file-lock acquisition in appendAudit(). The chain
//    was broken at index 2826 (Sessions 11-13) by concurrent writers
//    (activation server + main MCP) reading the same prev_hash before
//    either had flushed. The lock serializes the read-then-write
//    window across processes.
// ⛔ NEVER trust cachedLastHash without verifying file size hasn't
//    grown since cachedSize. Another process may have written between
//    OUR last write and OUR next read.
// WHY: audit-001-write-race documented in Session 11 SCORE.md. The
//    in-process chain cache is a perf optimization, NOT a correctness
//    guarantee — correctness comes from the lock + the size-mismatch
//    re-read.
// FIX: To raise throughput further (if profiling proves the stat() per
//    append is hot), batch appends within a process behind a single
//    lock acquisition. Don't remove the lock.
//
// Tamper-evident audit log — hash-chained JSONL at ~/.contextengine/audit.log.
//
// Compliance: produces evidence aligned with SOC 2 CC7.2 + ISO 27001 A.12.4.1
// (evidence artifacts, not certifications — see docs/compliance/).
//
// Records every state-changing operation. Each line carries the SHA-256 hash
// of the previous line's canonical content, so mutation of any historical
// record breaks chain verification at that index.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  writeSync,
  constants,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

const GENESIS_HASH = "0".repeat(64);

// ─── File lock primitives ───────────────────────────────────────────────────
// O_EXCL + O_CREAT is atomic across processes on POSIX and on Windows NTFS,
// so creating the lockfile is the synchronization primitive. Stale-lock
// recovery: if the lockfile is older than STALE_LOCK_MS, treat it as
// orphaned (process crashed mid-append) and unlink it.

const LOCK_TIMEOUT_MS = 2000;   // total wait before giving up
const LOCK_RETRY_MS = 5;        // poll interval
const STALE_LOCK_MS = 10_000;   // lockfile older than this = orphan

function lockPath(): string {
  return join(auditDir(), "audit.lock");
}

/** Synchronous sleep that doesn't burn CPU — uses Atomics.wait on a
 *  throwaway SharedArrayBuffer. Accurate to ~1ms. */
function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Acquire an exclusive file lock. Returns a release function. Throws if
 *  unable to acquire within LOCK_TIMEOUT_MS. */
function acquireLockSync(): () => void {
  const path = lockPath();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // O_EXCL fails atomically if the file already exists.
      const fd = openSync(
        path,
        // eslint-disable-next-line no-bitwise
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      // Write PID + ts so a debugger can see who's holding the lock.
      try {
        writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      } catch {
        /* lock file is what matters; the contents are nice-to-have */
      }
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          /* already gone — another cleaner won the race */
        }
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
      // Lockfile exists. Check if it's stale.
      try {
        const st = statSync(path);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          // Orphaned — force-unlink and retry.
          try {
            unlinkSync(path);
          } catch {
            /* another process just cleaned it; retry */
          }
          continue;
        }
      } catch {
        /* lockfile vanished between check and stat; just retry */
      }
      syncSleep(LOCK_RETRY_MS);
    }
  }
  throw new Error(
    `Failed to acquire audit lock at ${path} within ${LOCK_TIMEOUT_MS}ms`,
  );
}

function auditDir(): string {
  // CONTEXTENGINE_HOME lets tests run against a temp dir without touching ~/.contextengine
  return process.env.CONTEXTENGINE_HOME || join(homedir(), ".contextengine");
}

function auditPath(): string {
  return join(auditDir(), "audit.log");
}

export type AuditEvent =
  | "learning.save"
  | "learning.delete"
  | "learning.import"
  | "learning.export"
  | "session.save"
  | "session.delete"
  | "activation.activate"
  | "activation.deactivate"
  | "activation.heartbeat"
  | "activation.signature_reject"
  | "activation.legacy_signature"
  | "firewall.escalate"
  | "hook.block"
  | "hook.bypass"
  // Cross-surface capture (Phase 1, added 2026-06-23)
  | "browser.prompt"
  | "browser.response"
  | "browser.tool_call"
  | "browser.session_start"
  | "browser.session_end"
  | "browser.capture_miss"
  | "vscode.prompt_submit"
  | "vscode.tool_call"
  | "vscode.session_start"
  // Detector outputs (Phase 3)
  | "drift.detected"
  | "notification.fired"
  // Community-rules sync client (shared learnings hybrid, Phase 1)
  | "community.sync_ok"
  | "community.sync_error";

export interface AuditRecord {
  ts: string;
  event: AuditEvent;
  actor: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

function ensureDir(): void {
  const dir = auditDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readLastHash(): string {
  const path = auditPath();
  if (!existsSync(path)) return GENESIS_HASH;
  const data = readFileSync(path, "utf-8");
  const lines = data.split("\n").filter(Boolean);
  if (lines.length === 0) return GENESIS_HASH;
  try {
    const last = JSON.parse(lines[lines.length - 1]) as AuditRecord;
    return last.hash;
  } catch {
    return GENESIS_HASH;
  }
}

function computeHash(
  prevHash: string,
  ts: string,
  event: string,
  actor: string,
  payload: unknown,
): string {
  // Canonical serialization — keys in fixed order so independent verifiers get
  // the same bytes regardless of how the record object was originally built.
  const canonical = JSON.stringify({ prev_hash: prevHash, ts, event, actor, payload });
  return createHash("sha256").update(canonical).digest("hex");
}

let cachedLastHash: string | null = null;
/** File size at our last successful write. If statSync(path).size differs
 *  on the next call, another process wrote in between → invalidate cache. */
let cachedSize = 0;

export function appendAudit(
  event: AuditEvent,
  payload: Record<string, unknown>,
  actor = "system",
): AuditRecord {
  ensureDir();
  const release = acquireLockSync();
  try {
    const path = auditPath();
    // Cache validity check: if file size grew since OUR last write, another
    // process appended → re-read prev hash from disk (the cache is stale).
    // Also handles first-ever call (cachedLastHash === null).
    const currentSize = existsSync(path) ? statSync(path).size : 0;
    if (cachedLastHash === null || currentSize !== cachedSize) {
      cachedLastHash = readLastHash();
      cachedSize = currentSize;
    }
    const ts = new Date().toISOString();
    const hash = computeHash(cachedLastHash, ts, event, actor, payload);
    const record: AuditRecord = {
      ts,
      event,
      actor,
      payload,
      prev_hash: cachedLastHash,
      hash,
    };
    const line = JSON.stringify(record) + "\n";
    appendFileSync(path, line);
    cachedLastHash = hash;
    cachedSize += Buffer.byteLength(line, "utf-8");
    return record;
  } finally {
    release();
  }
}

export function readAuditLog(): AuditRecord[] {
  const path = auditPath();
  if (!existsSync(path)) return [];
  const data = readFileSync(path, "utf-8");
  return data
    .split("\n")
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line) as AuditRecord;
      } catch {
        throw new Error(`Corrupt audit line ${i + 1}: not valid JSON`);
      }
    });
}

export interface IntegrityReport {
  ok: boolean;
  total: number;
  breakAtIndex: number | null;
  breakReason: string | null;
}

export function verifyChain(): IntegrityReport {
  let records: AuditRecord[];
  try {
    records = readAuditLog();
  } catch (e) {
    return {
      ok: false,
      total: 0,
      breakAtIndex: null,
      breakReason: e instanceof Error ? e.message : String(e),
    };
  }
  let prev = GENESIS_HASH;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.prev_hash !== prev) {
      return {
        ok: false,
        total: records.length,
        breakAtIndex: i,
        breakReason: `prev_hash mismatch at index ${i}`,
      };
    }
    const expected = computeHash(prev, r.ts, r.event, r.actor, r.payload);
    if (r.hash !== expected) {
      return {
        ok: false,
        total: records.length,
        breakAtIndex: i,
        breakReason: `hash mismatch at index ${i} (record tampered)`,
      };
    }
    prev = r.hash;
  }
  return { ok: true, total: records.length, breakAtIndex: null, breakReason: null };
}

export function filterByRange(
  records: AuditRecord[],
  since?: string,
  until?: string,
): AuditRecord[] {
  return records.filter((r) => {
    if (since && r.ts < since) return false;
    if (until && r.ts > until) return false;
    return true;
  });
}

export function toCsv(records: AuditRecord[]): string {
  const header = "ts,event,actor,payload,prev_hash,hash";
  const rows = records.map((r) => {
    const payload = JSON.stringify(r.payload).replace(/"/g, '""');
    return `${r.ts},${r.event},${r.actor},"${payload}",${r.prev_hash},${r.hash}`;
  });
  return [header, ...rows].join("\n");
}

// Test-only — flush in-memory chain cache so a fresh path is re-read.
export function resetCacheForTest(): void {
  cachedLastHash = null;
  cachedSize = 0;
}

// Safe wrapper that never throws into hot paths. Use this from production
// call sites so a failed audit append cannot break a learning save or
// session write.
export function safeAppend(
  event: AuditEvent,
  payload: Record<string, unknown>,
  actor = "system",
): void {
  try {
    appendAudit(event, payload, actor);
  } catch (e) {
    // Last-resort surface — stderr only, never throw upward.
    process.stderr.write(
      `[ContextEngine] audit append failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

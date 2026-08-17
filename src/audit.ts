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
// ⛔ NEVER reintroduce an in-process head cache. STRENGTHENED 2026-08-17:
//    the cache is GONE, not merely guarded. See [AUDIT-HEAD-FROM-DISK].
// WHY: audit-001-write-race documented in Session 11 SCORE.md. The
//    in-process chain cache was a perf optimization, NOT a correctness
//    guarantee — and the size-mismatch guard that was supposed to make it
//    safe compared a locally-INCREMENTED byte count against the real file
//    size, so any divergence silently hashed onto a stale head.
//    The optimization is also now pointless: [AUDIT-TAIL-READ-IS-O1] made
//    reading the true head ~0ms, down from 215ms on a 120MB log.
// FIX: hold the lock, read the real head from disk, append. Nothing else.
//    Don't remove the lock, and don't add a cache back to "speed up" a
//    path that is already O(1).
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
  readSync,
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
  // Policy bypass — explicit, auditable opt-out for commit_message_required rules
  // (e.g. `--skip-multi-agent-reason: <text>` in the commit body). Added 2026-06-25.
  | "policy.skipped"
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

/**
 * 🔒 LOCKED [AUDIT-TAIL-READ-IS-O1] — 2026-08-17
 * ⛔ NEVER go back to readFileSync(whole log) + split("\n") to find the head.
 * WHY: this ran INSIDE the append lock, so its cost was lock hold time. On the author's
 *      319k-record / 120 MB log it measured **215 ms per append**, and it grows without
 *      bound. `acquireLockSync` force-breaks any lock older than STALE_LOCK_MS (10 s) to
 *      recover from crashed holders — which means a slow-but-perfectly-alive holder can
 *      have its lock STOLEN under load. Both processes then compute a hash from the same
 *      head and append: a forked chain. 66 forks exist in the log, all with prev_hash
 *      pointing at a known earlier head, none with tampered content.
 *      The whole-file read also allocated a 319k-element string array per append, on a
 *      path invoked once per PostToolUse hook firing.
 * FIX: seek the tail. Read at most TAIL_READ_BYTES from the end and take the last complete
 *      line. O(1) in log size, ~0 ms, so the lock is held for microseconds and stale-break
 *      cannot fire on a live holder. Falls back to a full read only if the tail window
 *      somehow contains no complete line (pathologically long single record).
 */
const TAIL_READ_BYTES = 64 * 1024;

function readLastHash(): string {
  const path = auditPath();
  if (!existsSync(path)) return GENESIS_HASH;

  const size = statSync(path).size;
  if (size === 0) return GENESIS_HASH;

  const start = Math.max(0, size - TAIL_READ_BYTES);
  let tail: string;
  const fd = openSync(path, constants.O_RDONLY);
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    tail = buf.toString("utf-8");
  } finally {
    closeSync(fd);
  }

  // Drop a leading partial line when we started mid-record.
  if (start > 0) {
    const nl = tail.indexOf("\n");
    tail = nl === -1 ? "" : tail.slice(nl + 1);
  }

  const lines = tail.split("\n").filter(Boolean);
  if (lines.length === 0) {
    // Tail window held no complete record — fall back to the full read.
    return readLastHashFullScan();
  }
  try {
    return (JSON.parse(lines[lines.length - 1]) as AuditRecord).hash;
  } catch {
    return GENESIS_HASH;
  }
}

/** Fallback for the pathological case: a single record longer than TAIL_READ_BYTES. */
function readLastHashFullScan(): string {
  const path = auditPath();
  const data = readFileSync(path, "utf-8");
  const lines = data.split("\n").filter(Boolean);
  if (lines.length === 0) return GENESIS_HASH;
  try {
    return (JSON.parse(lines[lines.length - 1]) as AuditRecord).hash;
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
    // 🔒 LOCKED [AUDIT-HEAD-FROM-DISK] — 2026-08-17
    // ⛔ NEVER derive the head hash from an in-process cache again.
    // WHY: the previous code trusted `cachedLastHash` whenever `statSync().size` matched
    //      a locally-tracked `cachedSize` that was ARITHMETIC (`cachedSize += byteLength`),
    //      not observed. Any divergence between bytes-we-think-we-wrote and bytes-on-disk
    //      — a partial write, a concurrent writer whose bytes happened to sum the same, an
    //      externally rotated/truncated log — left us hashing onto a head that is not the
    //      real tail, forking the chain. It was a correctness guarantee resting on a
    //      perf cache, which the file's own [audit-001-write-race] LOCK explicitly warns
    //      against ("the in-process chain cache is a perf optimization, NOT a correctness
    //      guarantee").
    // FIX: with [AUDIT-TAIL-READ-IS-O1] the true head costs ~0 ms, so there is nothing left
    //      to optimise. Read it from disk under the lock, every time. The cache is gone.
    const prevHash = readLastHash();
    const ts = new Date().toISOString();
    const hash = computeHash(prevHash, ts, event, actor, payload);
    const record: AuditRecord = {
      ts,
      event,
      actor,
      payload,
      prev_hash: prevHash,
      hash,
    };
    const line = JSON.stringify(record) + "\n";
    appendFileSync(path, line);
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
  /** Records whose own hash does not match their content. Non-empty = TAMPERED. */
  tamperedIndices?: number[];
  /** Records whose prev_hash names a hash that appears nowhere earlier in the log.
   *  Indicates deletion/truncation of history — treated as tampering. */
  orphanIndices?: number[];
  /** Records whose prev_hash names a KNOWN earlier head — a concurrent-append fork.
   *  Content is provably intact; only the linkage is non-linear. Not tampering. */
  forkIndices?: number[];
}

/**
 * 🔒 LOCKED [VERIFY-FORK-IS-NOT-TAMPER] — 2026-08-17
 * ⛔ NEVER report a forked chain as "the log was edited", and never stop at the first
 *    linkage mismatch without first checking whether any record's CONTENT is altered.
 * WHY: the previous verifier returned on the first `prev_hash !== prev` and told the user
 *      the log "was either edited after the fact, or a record was partially written during
 *      a crash… treat all records from the break onward as unverified." On the author's log
 *      that meant declaring 316,000 records unverifiable — destroying the entire SOC 2 /
 *      ISO evidence claim — for a condition it had never actually tested. The truth, once
 *      measured: 0 of 319,461 records had an invalid self-hash (nothing was ever edited),
 *      0 orphans (nothing was deleted), and all 66 breaks were forks where two processes
 *      read the same head and both appended.
 *      Tampering and concurrency produce DIFFERENT evidence, and conflating them is
 *      [ABSENCE-IS-NOT-A-VERDICT] applied to the compliance feature itself: the verifier
 *      reported a verdict ("edited") for something it had not assessed.
 * FIX: classify every anomaly instead of bailing on the first.
 *        - self-hash mismatch  → TAMPER   (fail hard; content was altered)
 *        - prev_hash unknown   → ORPHAN   (fail hard; history was deleted/truncated)
 *        - prev_hash = a known earlier head → FORK (warn; concurrent append, content intact)
 *      `ok` is true when there are no tampered and no orphan records. Forks are surfaced
 *      with counts and indices so the report stays honest in both directions — it must
 *      never claim a forked log is pristine either.
 */
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
  const tampered: number[] = [];
  const orphans: number[] = [];
  const forks: number[] = [];

  // Every hash observed so far, so a fork (parent = a known earlier head) can be told
  // apart from an orphan (parent never existed in this log).
  const seen = new Set<string>([GENESIS_HASH]);
  let prev = GENESIS_HASH;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];

    // 1. Content integrity — the only check that can prove tampering. Computed against
    //    the record's OWN prev_hash, so a fork does not cascade into false tamper reports
    //    for every record after it.
    const expected = computeHash(r.prev_hash, r.ts, r.event, r.actor, r.payload);
    if (r.hash !== expected) tampered.push(i);

    // 2. Linkage — fork vs orphan.
    if (r.prev_hash !== prev) {
      if (seen.has(r.prev_hash)) forks.push(i);
      else orphans.push(i);
    }

    seen.add(r.hash);
    prev = r.hash;
  }

  const ok = tampered.length === 0 && orphans.length === 0;
  const firstProblem =
    tampered.length > 0 ? tampered[0] : orphans.length > 0 ? orphans[0] : null;

  let reason: string | null = null;
  if (tampered.length > 0) {
    reason = `${tampered.length} record(s) with altered content — first at index ${tampered[0]}`;
  } else if (orphans.length > 0) {
    reason = `${orphans.length} record(s) whose parent is absent from the log (deleted or truncated history) — first at index ${orphans[0]}`;
  }

  return {
    ok,
    total: records.length,
    breakAtIndex: firstProblem,
    breakReason: reason,
    tamperedIndices: tampered,
    orphanIndices: orphans,
    forkIndices: forks,
  };
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

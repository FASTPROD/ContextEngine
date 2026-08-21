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
  fsyncSync,
  renameSync,
  readdirSync,
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
  | "community.sync_error"
  // Log rotation — records which segment a slice of history moved to (added 2026-08-20)
  | "audit.rotate"
  | "audit.redact";

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
  return parseHeadOrThrow(lines[lines.length - 1]);
}

/**
 * 🔒 LOCKED [UNREADABLE-HEAD-IS-NOT-GENESIS] — 2026-08-20
 * ⛔ NEVER return GENESIS_HASH because the last line failed to parse.
 * WHY: both head readers ended in `catch { return GENESIS_HASH }`. A truncated or corrupt
 *      final record — a partial write, a full disk, a killed process — therefore made the
 *      next append chain onto genesis instead of onto the real head. verifyChain() reports
 *      that as an ORPHAN, i.e. "history was deleted", the hardest failure the log can
 *      produce, and it would be caused by the writer itself rather than by tampering.
 *      It is [ABSENCE-IS-NOT-A-VERDICT] on the bedrock path: "I could not read the head"
 *      was rendered as the specific, plausible claim "there is no history".
 * FIX: throw. appendAudit() must surface problems loudly (see [AUDIT-CHAIN]); call sites
 *      that need isolation already use safeAppend(), which logs to stderr and continues.
 */
function parseHeadOrThrow(line: string): string {
  let rec: AuditRecord;
  try {
    rec = JSON.parse(line) as AuditRecord;
  } catch {
    throw new Error(
      "Audit log tail is not valid JSON — refusing to append onto an unknown head. " +
        "Inspect the last line of ~/.contextengine/audit.log; a partial final record can be " +
        "removed by hand, which verifyChain() will then confirm.",
    );
  }
  if (typeof rec.hash !== "string" || rec.hash.length !== 64) {
    throw new Error("Audit log tail has no usable hash — refusing to append onto an unknown head.");
  }
  return rec.hash;
}

/** Fallback for the pathological case: a single record longer than TAIL_READ_BYTES. */
function readLastHashFullScan(): string {
  const path = auditPath();
  const data = readFileSync(path, "utf-8");
  const lines = data.split("\n").filter(Boolean);
  if (lines.length === 0) return GENESIS_HASH;
  // [LOCK] [UNREADABLE-HEAD-IS-NOT-GENESIS] — same rule as the tail reader.
  return parseHeadOrThrow(lines[lines.length - 1]);
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

/**
 * 🔒 LOCKED [ROTATION-MUST-NOT-ORPHAN-THE-CHAIN] — 2026-08-20
 * ⛔ NEVER rotate by truncating, moving or deleting audit.log. NEVER let a rotated log
 *    read as "history was deleted".
 * WHY: verifyChain() classifies a record whose prev_hash names a hash absent from the log
 *      as an ORPHAN, which is a hard failure meaning deleted or truncated history — the
 *      exact evidence claim SOC 2 CC7.2 / ISO 27001 A.12.4.1 rest on. A `mv audit.log
 *      audit.log.1` makes the very first record of the new file an orphan, so the naive
 *      rotation turns a healthy log into a permanent "TAMPERED" verdict for every future
 *      audit. The log reached 195 MB / 533,987 records with no rotation path precisely
 *      because the safe shape was never built.
 * FIX: rotation MOVES a prefix of history into a numbered segment under audit-archive/
 *      and the canonical history is `segments in order ++ live log`. readAuditLog() reads
 *      that concatenation by default, so the chain stays linear and verification is
 *      unchanged. Segments are append-only and never rewritten.
 *
 * 🔒 LOCKED [ROTATE-ARCHIVE-BEFORE-TRUNCATE] — 2026-08-20
 * ⛔ NEVER truncate the live log before the segment file is durably renamed into place.
 * WHY: the reverse order loses records permanently on a crash between the two steps.
 *      This order can only ever produce a DUPLICATE (records in both the segment and the
 *      live log), which the seam de-dup below removes and which loses nothing.
 * FIX: write segment tmp → fsync → rename → write live remainder tmp → fsync → rename.
 */

function archiveDir(): string {
  return join(auditDir(), "audit-archive");
}

const SEGMENT_RE = /^audit-(\d{4,})\.jsonl$/;

/** Archived segment filenames in chain order (oldest first). */
export function listSegments(): string[] {
  const dir = archiveDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => SEGMENT_RE.test(f))
    .sort((a, b) => Number(SEGMENT_RE.exec(a)![1]) - Number(SEGMENT_RE.exec(b)![1]));
}

function parseLines(data: string, label: string): AuditRecord[] {
  return data
    .split("\n")
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line) as AuditRecord;
      } catch {
        throw new Error(`Corrupt audit line ${i + 1} in ${label}: not valid JSON`);
      }
    });
}

export interface ReadOptions {
  /** Include archived segments. Default true — callers asking for "the audit log" mean
   *  the whole history. Hot paths that only care about a recent window pass false. */
  includeArchives?: boolean;
}

export function readAuditLog(opts: ReadOptions = {}): AuditRecord[] {
  const includeArchives = opts.includeArchives !== false;
  const path = auditPath();
  const live = existsSync(path) ? parseLines(readFileSync(path, "utf-8"), "audit.log") : [];
  if (!includeArchives) return live;

  const segments = listSegments();
  if (segments.length === 0) return live;

  const history: AuditRecord[] = [];
  let lastSegmentHashes = new Set<string>();
  for (const f of segments) {
    const recs = parseLines(readFileSync(join(archiveDir(), f), "utf-8"), f);
    // 🔒 LOCKED [NO-SPREAD-OVER-A-SEGMENT] — 2026-08-20
    // ⛔ NEVER use push(...records) on a segment. Found on the first real rotation:
    //    a 494,152-record segment threw "Maximum call stack size exceeded" because the
    //    spread passes every element as a separate argument. Every unit test passed —
    //    they used chains of a few thousand. Push in a loop, whatever the size.
    for (const r of recs) history.push(r);
    lastSegmentHashes = new Set(recs.map((r) => r.hash));
  }

  // Seam de-dup — see [ROTATE-ARCHIVE-BEFORE-TRUNCATE]. A crash after the segment was
  // renamed but before the live log was truncated leaves the archived prefix present in
  // both files. Drop only the LEADING run of live records already in the last segment;
  // anything else is real history and must never be dropped.
  let start = 0;
  while (start < live.length && lastSegmentHashes.has(live[start].hash)) start++;
  // [LOCK] [NO-SPREAD-OVER-A-SEGMENT] — same reason.
  for (let i = start; i < live.length; i++) history.push(live[i]);
  return history;
}

export interface RotationPlan {
  /** Records that would move to a segment. */
  archiveCount: number;
  /** Records that would stay in the live log. */
  keepCount: number;
  /** Timestamp cutoff: records strictly older than this are archived. */
  cutoff: string;
  segmentFile: string | null;
  /** Set when the rotation must not run, with the reason. */
  refusedReason: string | null;
}

export interface RotationResult extends RotationPlan {
  rotated: boolean;
  bytesArchived: number;
  bytesRemaining: number;
}

/** Never archive below this many most-recent records, whatever the date cutoff says.
 *  The live log has to keep enough context for the drift detectors' window. */
const MIN_LIVE_RECORDS = 2000;

export interface RotateOptions {
  /** Archive records older than this many days. Minimum 1. */
  keepDays?: number;
  /**
   * Hard ceiling on how many records stay in the live log, whatever the dates say.
   *
   * 🔒 LOCKED [DATE-RETENTION-DOES-NOT-BOUND-SIZE] — 2026-08-20
   * ⛔ NEVER ship rotation with a date rule alone.
   * WHY: measured on the real log before shipping this — at 80,000 records/day, a 30-day
   *      window left 390,445 records live and even a 3-day window left 205,422. Date
   *      retention bounds AGE, not SIZE, so on a busy machine it rotates and changes
   *      nothing that matters: readAuditLog() still costs seconds and hundreds of MB.
   *      The feature would have looked like it worked while leaving the problem in place.
   * FIX: cut at whichever rule archives more, date or count. Count is what actually caps
   *      the file.
   */
  maxRecords?: number;
  /** Report what would happen and write nothing. */
  dryRun?: boolean;
  now?: number;
}

/** Live-log ceiling when the caller does not set one. ~50k records ≈ 18 MB. */
const DEFAULT_MAX_LIVE_RECORDS = 50_000;

/**
 * Plan a rotation without writing anything. Exported so the CLI's dry-run and the real
 * run share one implementation and cannot disagree.
 */
export function planRotation(opts: RotateOptions = {}): RotationPlan {
  const keepDays = Math.max(1, Math.floor(opts.keepDays ?? 30));
  const now = opts.now ?? Date.now();
  const cutoff = new Date(now - keepDays * 86_400_000).toISOString();

  const live = existsSync(auditPath())
    ? parseLines(readFileSync(auditPath(), "utf-8"), "audit.log")
    : [];

  let cutByDate = live.findIndex((r) => r.ts >= cutoff);
  if (cutByDate === -1) cutByDate = live.length; // every record is older than the cutoff

  // [DATE-RETENTION-DOES-NOT-BOUND-SIZE] — whichever rule archives more wins.
  const maxRecords = Math.max(1, Math.floor(opts.maxRecords ?? DEFAULT_MAX_LIVE_RECORDS));
  const cutByCount = Math.max(0, live.length - maxRecords);

  let cut = Math.max(cutByDate, cutByCount);
  // Keep the tail intact regardless of either rule.
  cut = Math.min(cut, Math.max(0, live.length - MIN_LIVE_RECORDS));

  const next = listSegments().length + 1;
  return {
    archiveCount: cut,
    keepCount: live.length - cut,
    cutoff,
    segmentFile: cut > 0 ? `audit-${String(next).padStart(4, "0")}.jsonl` : null,
    refusedReason: null,
  };
}

/**
 * Move everything older than the cutoff into a numbered archive segment.
 *
 * Refuses to run on a chain that does not currently verify: rotating a log with altered
 * or orphaned records would bake the damage into an append-only segment and make the
 * cause unrecoverable. Forks are fine — they are concurrency, not tampering.
 */
export function rotateAuditLog(opts: RotateOptions = {}): RotationResult {
  const path = auditPath();
  const plan = planRotation(opts);
  const empty: RotationResult = { ...plan, rotated: false, bytesArchived: 0, bytesRemaining: 0 };

  if (!existsSync(path)) {
    return { ...empty, refusedReason: "no audit log on disk" };
  }
  if (plan.archiveCount === 0) {
    return {
      ...empty,
      bytesRemaining: statSync(path).size,
      refusedReason: `nothing to archive: ${plan.keepCount} record(s) live, within both the retention window and the size ceiling`,
    };
  }

  const integrity = verifyChain();
  if (!integrity.ok) {
    // [LOCKED] [ROTATE-REFUSES-LIVE-DAMAGE-ONLY] — 2026-08-21
    // [NEVER] refuse a rotation for damage that sits entirely inside segments already archived.
    // WHY: on 2026-08-20 a credentials sweep replaced a password literal with [REDACTED_SECRET]
    //      in 3 records of audit-0001.jsonl. Correct, deliberate, and permanent: the verifier
    //      reports them as altered for good. A whole-chain refusal then blocks every future
    //      rotation, the live log grows without bound (170k records a day later, 3x the
    //      ceiling) and the detectors slow down again, which is the failure rotation exists to
    //      prevent. Archived segments are already immutable by policy; refusing to archive new
    //      records protects nothing there.
    // FIX: refuse only when an altered or orphaned record is in the live log, the part about to
    //      be rewritten. Damage confined to segments is reported, not treated as a veto.
    const firstLive = integrity.total - plan.archiveCount - plan.keepCount;
    const bad = [...(integrity.tamperedIndices ?? []), ...(integrity.orphanIndices ?? [])];
    const inLive = bad.filter((i) => i >= firstLive);
    if (inLive.length > 0) {
      return {
        ...empty,
        refusedReason: `chain does not verify (${integrity.breakReason}) — ${inLive.length} damaged record(s) in the live log, refusing to archive a damaged log`,
      };
    }
    console.error(
      `[ContextEngine] ⚠ audit rotation: ${bad.length} known damaged record(s) in archived segments ` +
        `(first at ${bad[0]}); none in the live log, rotating.`,
    );
  }

  if (opts.dryRun) return { ...plan, rotated: false, bytesArchived: 0, bytesRemaining: 0 };

  ensureDir();
  const adir = archiveDir();
  if (!existsSync(adir)) mkdirSync(adir, { recursive: true });

  // Snapshot outside the lock: parsing 500k records is far too slow to hold the append
  // lock for, and acquireLockSync() force-breaks locks older than STALE_LOCK_MS.
  const snapshotSize = statSync(path).size;
  const live = parseLines(readFileSync(path, "utf-8"), "audit.log");
  const archived = live.slice(0, plan.archiveCount);
  const remainder = live.slice(plan.archiveCount);

  const segName = plan.segmentFile!;
  const segTmp = join(adir, `.${segName}.tmp`);
  const segBody = archived.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileAndSync(segTmp, segBody);
  renameSync(segTmp, join(adir, segName));

  // [ROTATE-ARCHIVE-BEFORE-TRUNCATE]: the segment is durable from here on. Only now may
  // the live log shrink.
  const release = acquireLockSync();
  let remainderBody = remainder.map((r) => JSON.stringify(r)).join("\n") + "\n";
  try {
    const currentSize = statSync(path).size;
    if (currentSize > snapshotSize) {
      // Appends landed while we were writing the segment. They are newer than the cutoff
      // by construction, so they belong to the remainder. Copy the raw bytes across
      // rather than re-parsing the whole file.
      const fd = openSync(path, constants.O_RDONLY);
      try {
        const buf = Buffer.alloc(currentSize - snapshotSize);
        readSync(fd, buf, 0, buf.length, snapshotSize);
        remainderBody += buf.toString("utf-8");
      } finally {
        closeSync(fd);
      }
    }
    const liveTmp = join(auditDir(), ".audit.log.tmp");
    writeFileAndSync(liveTmp, remainderBody);
    renameSync(liveTmp, path);
  } finally {
    release();
  }

  // Self-documenting evidence: the rotation itself is an audited event, chained onto the
  // new head like any other record.
  appendAudit(
    "audit.rotate",
    {
      segment: segName,
      archived_records: archived.length,
      first_hash: archived[0].hash,
      last_hash: archived[archived.length - 1].hash,
      cutoff: plan.cutoff,
    },
    "system",
  );

  return {
    ...plan,
    rotated: true,
    bytesArchived: Buffer.byteLength(segBody),
    bytesRemaining: statSync(path).size,
  };
}

/**
 * Startup auto-rotation for the MCP server.
 *
 * [LOCKED] [AUTO-ROTATE-HYSTERESIS-AND-ONE-RUNNER] — 2026-08-21
 * [NEVER] trigger at the same count the rotation keeps, and never let two servers rotate at once.
 * WHY: rotation was manual and the live log crossed the 50k ceiling in ~15h, so the drift
 *      detectors' per-tick read slowed by the day between hand runs. A startup hook fixes the
 *      cadence, but (a) triggering at 50k and rotating down to 50k would cut a handful of
 *      records into a new segment on every start, and (b) three MCP servers start together
 *      on this machine (VS Code, launchd, Claude Code); each would plan on the same oversized
 *      file and the late ones would archive records the first one had already kept.
 * FIX: trigger at AUTO_ROTATE_TRIGGER (2x the ceiling), rotate down to the ceiling, so a
 *      rotation buys ~a day of quiet. A dedicated rotate lock (O_EXCL, stale after 10 min,
 *      long enough to verify a 500k-record chain) makes late starters return "in progress"
 *      without touching the log. Opt out with CONTEXTENGINE_AUTO_ROTATE=0.
 */
export const AUTO_ROTATE_TRIGGER = 2 * DEFAULT_MAX_LIVE_RECORDS;
const ROTATE_LOCK_STALE_MS = 10 * 60_000;

function rotateLockPath(): string {
  return join(auditDir(), "audit.rotate.lock");
}

/** Count newline-terminated lines without parsing. The live log is small by construction. */
export function countLiveRecords(): number {
  const path = auditPath();
  if (!existsSync(path)) return 0;
  const buf = readFileSync(path);
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return n;
}

export interface AutoRotateOutcome {
  action: "disabled" | "below_trigger" | "in_progress" | "rotated" | "refused" | "error";
  liveRecords: number;
  detail: string;
  result?: RotationResult;
}

export function autoRotateAuditLog(opts: { trigger?: number; maxRecords?: number } = {}): AutoRotateOutcome {
  const trigger = opts.trigger ?? AUTO_ROTATE_TRIGGER;
  const maxRecords = opts.maxRecords ?? DEFAULT_MAX_LIVE_RECORDS;

  if (process.env.CONTEXTENGINE_AUTO_ROTATE === "0") {
    return { action: "disabled", liveRecords: -1, detail: "CONTEXTENGINE_AUTO_ROTATE=0" };
  }
  const liveRecords = countLiveRecords();
  if (liveRecords <= trigger) {
    return { action: "below_trigger", liveRecords, detail: `${liveRecords} live record(s), trigger is ${trigger}` };
  }

  // One runner at a time. O_EXCL create is the primitive; a stale file is an orphan from a
  // crashed rotation, not a live one.
  const lock = rotateLockPath();
  let fd: number;
  try {
    ensureDir();
    try {
      fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const age = Date.now() - statSync(lock).mtimeMs;
      if (age < ROTATE_LOCK_STALE_MS) {
        return { action: "in_progress", liveRecords, detail: `another rotation holds ${lock} (${Math.round(age / 1000)}s old)` };
      }
      unlinkSync(lock);
      fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    }
  } catch (e) {
    return { action: "error", liveRecords, detail: `rotate lock: ${(e as Error).message}` };
  }
  try {
    try { writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`); } catch { /* contents are a courtesy */ }
    closeSync(fd);
    const result = rotateAuditLog({ maxRecords });
    if (!result.rotated) {
      return { action: "refused", liveRecords, detail: result.refusedReason ?? "not rotated", result };
    }
    return {
      action: "rotated",
      liveRecords,
      detail: `archived ${result.archiveCount} record(s) to ${result.segmentFile}, ${result.keepCount + 1} live`,
      result,
    };
  } catch (e) {
    return { action: "error", liveRecords, detail: (e as Error).message };
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

function writeFileAndSync(target: string, body: string): void {
  const fd = openSync(target, "w");
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
  /** Records whose content was altered AND whose alteration is acknowledged by a later, intact
   *  `audit.redact` record binding the original hash to the current content. Not counted as
   *  tampering. */
  redactedIndices?: number[];
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

  // 3. Acknowledged redactions. [LOCK] [REDACTION-IS-A-CHAINED-RECORD]
  //    An `audit.redact` record that is itself intact binds (original hash -> hash of the
  //    redacted content). A tampered record matching such a binding is "redacted", not
  //    "altered". Binding to the current content means a second edit after the acknowledgement
  //    makes it tampered again.
  const tamperedSet = new Set(tampered);
  const acks = new Map<string, string>();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.event !== "audit.redact" || tamperedSet.has(i)) continue;
    const list = (r.payload as { redacted?: Array<{ hash?: unknown; content_hash?: unknown }> }).redacted;
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (typeof e.hash === "string" && typeof e.content_hash === "string") acks.set(e.hash, e.content_hash);
    }
  }
  const redacted: number[] = [];
  const stillTampered: number[] = [];
  for (const i of tampered) {
    const r = records[i];
    const bound = acks.get(r.hash);
    if (bound && bound === computeHash(r.prev_hash, r.ts, r.event, r.actor, r.payload)) redacted.push(i);
    else stillTampered.push(i);
  }
  tampered.length = 0;
  tampered.push(...stillTampered);

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
    redactedIndices: redacted,
  };
}

/**
 * Acknowledge that records were deliberately redacted (a secret removed from their content).
 *
 * [LOCKED] [REDACTION-IS-A-CHAINED-RECORD] — 2026-08-21
 * [NEVER] let the verifier accept an allow-list that lives outside the chain (a file, an env
 *         var, a CLI flag) as grounds to stop calling an altered record altered.
 * WHY: on 2026-08-20 a credentials sweep replaced a password with [REDACTED_SECRET] in 3
 *      archived records. Correct, but the chain can only see "content no longer matches its
 *      hash", so the compliance report read "tampering" for a deliberate act nobody recorded.
 *      An out-of-band allow-list would fix the wording and destroy the property: anyone who
 *      can edit the log can edit the list.
 * FIX: the acknowledgement is an `audit.redact` record, appended to the chain like any other,
 *      naming the original hash of each redacted record and the hash of its redacted content.
 *      It can only be written after the fact, only for records that are actually altered, and
 *      a further edit breaks the binding. The verifier reports such records as "redacted",
 *      counts them separately, and `ok` ignores them; everything else stays "altered".
 */
export function acknowledgeRedaction(
  indices: number[],
  reason: string,
  actor = "system",
): { acknowledged: number[]; rejected: Array<{ index: number; why: string }>; record: AuditRecord | null } {
  if (!reason.trim()) throw new Error("a reason is required");
  const records = readAuditLog();
  const acknowledged: number[] = [];
  const rejected: Array<{ index: number; why: string }> = [];
  const entries: Array<{ index: number; hash: string; content_hash: string; ts: string; event: string }> = [];
  for (const i of [...new Set(indices)].sort((a, b) => a - b)) {
    const r = records[i];
    if (!r) { rejected.push({ index: i, why: "no such record" }); continue; }
    const current = computeHash(r.prev_hash, r.ts, r.event, r.actor, r.payload);
    if (current === r.hash) { rejected.push({ index: i, why: "content is intact, nothing to acknowledge" }); continue; }
    if (r.event === "audit.redact") { rejected.push({ index: i, why: "an acknowledgement cannot itself be redacted" }); continue; }
    acknowledged.push(i);
    entries.push({ index: i, hash: r.hash, content_hash: current, ts: r.ts, event: r.event });
  }
  if (entries.length === 0) return { acknowledged, rejected, record: null };
  const record = appendAudit("audit.redact", { reason, redacted: entries }, actor);
  return { acknowledged, rejected, record };
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

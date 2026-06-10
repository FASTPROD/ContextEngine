// 🔒 LOCKED [AUDIT-CHAIN] — 2026-06-10
// ⛔ NEVER change the canonical serialization in computeHash() — key order,
//    field names, JSON.stringify behavior, or genesis hash value. Any change
//    breaks verification of every audit log written by an older client.
// ⛔ NEVER swap SHA-256 for a different hash without a migration path.
// ⛔ NEVER catch errors inside appendAudit() — silent failures defeat the
//    entire compliance story. Use safeAppend() at call sites if you need
//    failure isolation; appendAudit() must surface problems loudly.
// WHY: This is the SOC2 CC7.2 / ISO 27001 A.12.4.1 compliance bedrock. The
//    audit log is the foundation that licence-signature verification,
//    compliance reporting, and enforcement telemetry all build on. Any
//    silent break here destroys evidence value across years of records.
// FIX: If you need to evolve the record format, version the chain
//    (add a "v":2 field) and keep verifyChain() backward-compatible by
//    dispatching on the v field. Don't mutate the v=1 contract.
//
// Tamper-evident audit log — hash-chained JSONL at ~/.contextengine/audit.log.
//
// Compliance basis: SOC2 CC7.2 (audit logging), ISO 27001 A.12.4.1 (event logs).
//
// Records every state-changing operation. Each line carries the SHA-256 hash
// of the previous line's canonical content, so mutation of any historical
// record breaks chain verification at that index.

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

const GENESIS_HASH = "0".repeat(64);

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
  | "session.save"
  | "session.delete"
  | "activation.activate"
  | "activation.deactivate"
  | "activation.heartbeat"
  | "firewall.escalate"
  | "hook.block"
  | "hook.bypass";

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

export function appendAudit(
  event: AuditEvent,
  payload: Record<string, unknown>,
  actor = "system",
): AuditRecord {
  ensureDir();
  if (cachedLastHash === null) cachedLastHash = readLastHash();
  const ts = new Date().toISOString();
  const hash = computeHash(cachedLastHash, ts, event, actor, payload);
  const record: AuditRecord = { ts, event, actor, payload, prev_hash: cachedLastHash, hash };
  appendFileSync(auditPath(), JSON.stringify(record) + "\n");
  cachedLastHash = hash;
  return record;
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

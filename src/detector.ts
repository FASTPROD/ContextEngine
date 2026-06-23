// 🔒 LOCKED [DRIFT-HEURISTICS] — 2026-06-23
// ⛔ NEVER make a heuristic fire on a single event in isolation. Every
//    heuristic looks at a WINDOW of events. Single-event triggers will
//    fire on the user's normal workflow and burn trust in the alerts.
// ⛔ NEVER raise a critical severity from a heuristic without a corresponding
//    audit event (drift.detected with full payload). Critical = OS
//    notification + interrupt — the audit trail is what the user reviews
//    after-the-fact to understand WHY the alert fired.
// ⛔ NEVER trust the assistant's claim that something exists in the file
//    system. The fabrication_suspect check is precisely about catching
//    those claims. If you add helpers, default to "verify against fs".
// WHY: Drift alerts have to be precise. False positives train users to
//    ignore the status bar, defeating the entire purpose. Conservative
//    thresholds + window-based detection + auditable trail are the
//    discipline that earns user trust.
// FIX: To add a new heuristic, copy the shape of detectLoop or detectStuck,
//    keep the predicate pure (no I/O except fs.existsSync), append it to
//    HEURISTICS at the bottom, and add a fixture to tests/__fixtures__/
//    audit-logs/.

import { readAuditLog, safeAppend, type AuditRecord, type AuditEvent } from "./audit.js";
import { watch, existsSync } from "fs";
import { join, isAbsolute } from "path";
import { homedir } from "os";

// ─── Public types ──────────────────────────────────────────────────────────

export type DriftKind =
  | "loop"
  | "stuck"
  | "context_bloat"
  | "fabrication_suspect"
  | "drift"
  | "no_insight"
  | "stale_doc_signal"
  | "silent_failure";

export type Severity = "info" | "warn" | "critical";

export interface DriftSignal {
  kind: DriftKind;
  severity: Severity;
  reason: string;
  evidence: AuditRecord[];
  payload: Record<string, unknown>;
  detectedAt: number;
}

export interface DetectorOptions {
  /** Window in seconds for event scan. Default 300 (5 min). */
  windowSeconds?: number;
  /** Inject a "now" for deterministic tests. */
  now?: number;
  /** Inject the events instead of reading from disk (for tests). */
  events?: AuditRecord[];
  /** Project root for fabrication_suspect file-existence checks. */
  cwd?: string;
}

// ─── Window scan ───────────────────────────────────────────────────────────

export function scanRecentEvents(
  windowSeconds: number = 300,
  now: number = Date.now(),
): AuditRecord[] {
  let all: AuditRecord[];
  try {
    all = readAuditLog();
  } catch {
    return [];
  }
  const cutoff = now - windowSeconds * 1000;
  return all.filter((r) => {
    const ts = Date.parse(r.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Tokenize text for cheap similarity comparisons (Jaccard / BM25-lite). */
export function tokens(s: string): Set<string> {
  return new Set(
    String(s || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  return intersect / (a.size + b.size - intersect);
}

function groupBy<T, K extends string>(arr: T[], keyFn: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = keyFn(x);
    const list = m.get(k) || [];
    list.push(x);
    m.set(k, list);
  }
  return m;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as object).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",") + "}";
}

function getText(r: AuditRecord): string {
  const p = r.payload || {};
  return String(p.text ?? p.preview ?? p.args_preview ?? "");
}

function sessionKey(r: AuditRecord): string {
  const p = r.payload || {};
  return String(p.conversation_id ?? p.session_name ?? p.session ?? "default");
}

function mk(
  kind: DriftKind,
  severity: Severity,
  reason: string,
  evidence: AuditRecord[],
  payload: Record<string, unknown>,
): DriftSignal {
  return {
    kind,
    severity,
    reason,
    evidence: evidence.slice(0, 5),
    payload,
    detectedAt: Date.now(),
  };
}

// ─── Heuristics ────────────────────────────────────────────────────────────

function detectLoop(events: AuditRecord[]): DriftSignal | null {
  const prompts = events
    .filter((e) => e.event === "browser.prompt" || e.event === "vscode.prompt_submit")
    .slice(-10);
  for (let i = 0; i < prompts.length; i++) {
    let dupes = 0;
    const matches: AuditRecord[] = [prompts[i]];
    const ti = tokens(getText(prompts[i]));
    if (ti.size === 0) continue;
    for (let j = i + 1; j < prompts.length; j++) {
      const tj = tokens(getText(prompts[j]));
      // 0.6 Jaccard ≈ 60% token overlap. Lower than initially gut-felt
      // because real prompt loops include "let me rephrase" wording shifts
      // that drop overlap quickly. 0.85 missed the "fix login bug" /
      // "login bug fix please" pattern; 0.6 catches it without falsing on
      // genuinely different prompts that happen to share verbs.
      if (jaccard(ti, tj) > 0.6 &&
          Date.parse(prompts[j].ts) - Date.parse(prompts[i].ts) < 300_000) {
        dupes++;
        matches.push(prompts[j]);
      }
    }
    if (dupes >= 2) {
      const snippet = getText(prompts[i]).slice(0, 80);
      return mk("loop", "warn",
        `Same prompt sent ${dupes + 1}× in 5 min`,
        matches,
        { repetitions: dupes + 1, snippet },
      );
    }
  }
  return null;
}

function detectStuck(events: AuditRecord[], now: number): DriftSignal | null {
  const calls = events.filter((e) =>
    e.event === "browser.tool_call" || e.event === "vscode.tool_call",
  );
  // 5-minute window. The "3 identical calls in a row" pattern usually plays
  // out over a few minutes — the user retries, waits, retries, gives up,
  // retries again. 2 min was too tight for normal LLM-agent rhythms.
  const recent = calls.filter((c) => now - Date.parse(c.ts) < 300_000);
  const byKey = groupBy(recent, (c) => {
    const p = c.payload || {};
    return `${p.tool}:${stableStringify(p.args ?? p.args_preview ?? "")}` as string;
  });
  for (const group of byKey.values()) {
    if (group.length >= 3) {
      const tool = String(group[0].payload?.tool ?? "unknown");
      return mk("stuck", "warn",
        `Tool ${tool} called ${group.length}× with identical args in 2 min`,
        group,
        { tool, count: group.length, args_preview: String(group[0].payload?.args_preview ?? "") },
      );
    }
  }
  return null;
}

function detectContextBloat(events: AuditRecord[]): DriftSignal | null {
  const bySession = groupBy(events, sessionKey);
  for (const [sid, group] of bySession) {
    let tokensSum = 0;
    let hasSave = false;
    for (const e of group) {
      const p = e.payload || {};
      if (typeof p.tokens === "number") tokensSum += p.tokens;
      else if (typeof p.char_count === "number") tokensSum += Math.ceil(p.char_count / 4);
      if (e.event === "session.save") hasSave = true;
    }
    if (tokensSum > 80_000 && !hasSave) {
      return mk("context_bloat", "warn",
        `Session "${sid}" at ~${Math.round(tokensSum / 1000)}K tokens, no save_session yet`,
        group.slice(-3),
        { sessionId: sid, approxTokens: tokensSum },
      );
    }
  }
  return null;
}

function detectFabrication(events: AuditRecord[], cwd: string): DriftSignal | null {
  const responses = events.filter((e) => e.event === "browser.response").slice(-5);
  // Match file paths with a line number: "src/foo.ts:42", "lib/x.py:3-7", etc.
  // Conservative: only flag paths with a recognizable code extension AND a line ref.
  const re = /([A-Za-z0-9_\-./]+\.(?:ts|tsx|js|jsx|py|md|json|yml|yaml|go|rs|rb|java|cs|cpp|c|h)):\d+/g;
  for (const r of responses) {
    const text = getText(r);
    const found = new Set<string>();
    for (const m of text.matchAll(re)) {
      const p = m[1];
      if (found.has(p)) continue;
      found.add(p);
      const abs = isAbsolute(p) ? p : join(cwd, p);
      if (!existsSync(abs)) {
        return mk("fabrication_suspect", "critical",
          `Assistant referenced non-existent file: ${p}`,
          [r],
          { citedPath: p, responseHash: r.hash },
        );
      }
    }
  }
  return null;
}

function detectDrift(events: AuditRecord[]): DriftSignal | null {
  // Per-session: if the last 3 prompts are jointly far (low overlap) from
  // the session's FIRST prompt, the conversation has drifted off-topic.
  const bySession = groupBy(
    events.filter((e) => e.event === "browser.prompt" || e.event === "vscode.prompt_submit"),
    sessionKey,
  );
  for (const [sid, prompts] of bySession) {
    if (prompts.length < 4) continue;
    const first = tokens(getText(prompts[0]));
    if (first.size === 0) continue;
    const last3 = prompts.slice(-3).map((p) => tokens(getText(p)));
    const avgSim = last3.reduce((sum, t) => sum + jaccard(first, t), 0) / 3;
    if (avgSim < 0.10) {
      return mk("drift", "info",
        `Session "${sid}" has drifted from its opening prompt (similarity ${avgSim.toFixed(2)})`,
        prompts.slice(-3),
        { sessionId: sid, similarity: avgSim, firstPrompt: getText(prompts[0]).slice(0, 80) },
      );
    }
  }
  return null;
}

function detectNoInsight(events: AuditRecord[]): DriftSignal | null {
  const lastLearn = [...events].reverse().find((e) => e.event === "learning.save");
  const since = lastLearn ? Date.parse(lastLearn.ts) : 0;
  const toolCalls = events.filter(
    (e) =>
      (e.event === "browser.tool_call" ||
        e.event === "vscode.tool_call") &&
      Date.parse(e.ts) > since,
  );
  if (toolCalls.length >= 30) {
    return mk("no_insight", "info",
      `${toolCalls.length} tool calls since the last save_learning`,
      toolCalls.slice(-3),
      { toolCallCount: toolCalls.length, lastLearningAt: since || null },
    );
  }
  return null;
}

function detectSilentFailure(events: AuditRecord[], now: number): DriftSignal | null {
  const errs = events.filter((e) => {
    if (e.event !== "browser.tool_call" && e.event !== "vscode.tool_call") return false;
    const p = e.payload || {};
    return Boolean(p.error || p.failed || p.status === "error");
  });
  const recent = errs.filter((e) => now - Date.parse(e.ts) < 300_000);
  const byTool = groupBy(recent, (e) => String(e.payload?.tool ?? "unknown"));
  for (const [tool, group] of byTool) {
    if (group.length >= 3) {
      const snippet = String((group[0].payload?.error || group[0].payload?.message || "")).slice(0, 200);
      return mk("silent_failure", "critical",
        `Tool ${tool} failed ${group.length}× in 5 min`,
        group,
        { tool, errorSnippet: snippet, count: group.length },
      );
    }
  }
  return null;
}

function detectStaleDocSignal(_events: AuditRecord[]): DriftSignal | null {
  // Stub: full implementation requires reading .contextengine/policy.json
  // and matching staged edits to doc_coverage rules. Defer to Phase 3.1
  // when the policy module exposes a helper. For now, return null so the
  // heuristic is wired but inert (keeps the union complete + lets tests
  // assert "no signal" against fixtures that don't trigger it).
  return null;
}

// ─── Runner ────────────────────────────────────────────────────────────────

export function runHeuristics(
  events: AuditRecord[],
  opts: { now?: number; cwd?: string } = {},
): DriftSignal[] {
  const now = opts.now ?? Date.now();
  const cwd = opts.cwd ?? process.cwd();
  const signals: DriftSignal[] = [];
  const push = (s: DriftSignal | null) => { if (s) signals.push(s); };
  push(detectLoop(events));
  push(detectStuck(events, now));
  push(detectContextBloat(events));
  push(detectFabrication(events, cwd));
  push(detectDrift(events));
  push(detectNoInsight(events));
  push(detectSilentFailure(events, now));
  push(detectStaleDocSignal(events));
  return signals;
}

/** Convenience for callers: scan recent events and run heuristics in one call. */
export function detect(opts: DetectorOptions = {}): DriftSignal[] {
  const now = opts.now ?? Date.now();
  const events = opts.events ?? scanRecentEvents(opts.windowSeconds ?? 300, now);
  return runHeuristics(events, { now, cwd: opts.cwd });
}

// ─── Live watcher (CLI + MCP) ──────────────────────────────────────────────

/**
 * Watch the audit log and fire `onAlert` for each new signal. Dedupe key is
 * `kind:reason` kept in an in-memory LRU bounded at 100 entries — prevents
 * the same drift from firing every poll cycle.
 *
 * Returns a dispose function. Caller is responsible for handling SIGINT
 * cleanly.
 */
export function watchAuditLog(
  onAlert: (s: DriftSignal) => void,
  opts: { windowSeconds?: number; debounceMs?: number; emitAuditEvent?: boolean } = {},
): () => void {
  const auditPath = join(
    process.env.CONTEXTENGINE_HOME || join(homedir(), ".contextengine"),
    "audit.log",
  );
  const seen = new Set<string>();
  const seenOrder: string[] = [];
  const SEEN_CAP = 100;

  function maybeFire(signal: DriftSignal) {
    const key = `${signal.kind}:${signal.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    seenOrder.push(key);
    if (seenOrder.length > SEEN_CAP) {
      const evict = seenOrder.shift();
      if (evict) seen.delete(evict);
    }
    onAlert(signal);
    if (opts.emitAuditEvent !== false) {
      safeAppend("drift.detected", {
        kind: signal.kind,
        severity: signal.severity,
        reason: signal.reason,
        evidence_count: signal.evidence.length,
        ...signal.payload,
      });
    }
  }

  function tick() {
    const events = scanRecentEvents(opts.windowSeconds ?? 300);
    const signals = runHeuristics(events);
    for (const s of signals) maybeFire(s);
  }

  // Initial scan.
  tick();

  let debounceTimer: NodeJS.Timeout | null = null;
  const debounce = opts.debounceMs ?? 250;

  let watcher: import("fs").FSWatcher | null = null;
  try {
    if (existsSync(auditPath)) {
      watcher = watch(auditPath, { persistent: false }, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(tick, debounce);
      });
    }
  } catch {
    /* fs.watch unsupported on some platforms — fall back to polling below */
  }

  // Poll-based fallback (in case watch doesn't fire, e.g., remote FS).
  const pollTimer = setInterval(tick, 5_000);

  return () => {
    if (watcher) watcher.close();
    clearInterval(pollTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}

// Test-only — clear the dedupe LRU between fixture runs.
export const _internal = {
  detectLoop, detectStuck, detectContextBloat, detectFabrication,
  detectDrift, detectNoInsight, detectSilentFailure, detectStaleDocSignal,
};

export type { AuditRecord, AuditEvent };

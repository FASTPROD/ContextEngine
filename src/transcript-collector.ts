/**
 * Transcript collector — per-subagent token, cost and intensity accounting
 * read from Claude Code's own JSONL transcripts.
 *
 * Layout (verified against 2,310 real agent transcripts on 2026-08-19):
 *
 *   ~/.claude/projects/<project-slug>/<sessionId>.jsonl              parent session
 *   ~/.claude/projects/<project-slug>/<sessionId>/subagents/
 *        agent-<agentId>.jsonl                                       Agent-tool subagent
 *        workflows/<wf_id>/agent-<agentId>.jsonl                     Workflow subagent
 *
 * 🔒 LOCKED [TRANSCRIPT-DEDUP-BY-MESSAGE-ID] — 2026-08-19
 * ⛔ NEVER sum `message.usage` per JSONL line. One assistant `message.id` is
 *    written across SEVERAL lines (one per content block: thinking, text, each
 *    tool_use), and EVERY line repeats the SAME usage object.
 * WHY: measured on a real agent transcript, naive per-line summing reported
 *    624,873 cache_read tokens where the true figure was 225,183 — a 2.8x
 *    overcount, and 4.6x on cache_creation. A cost report that overstates by
 *    3x is worse than no cost report: it gets disbelieved, then ignored.
 * FIX: reduce by `message.id`. Verified invariant over 1,609 message ids in
 *    126 files: input_tokens / cache_creation_input_tokens /
 *    cache_read_input_tokens are CONSTANT within an id (0 exceptions), and
 *    output_tokens increases monotonically, so the max is the final count.
 *    tests/transcript-collector.test.ts pins both halves.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Raw token tallies, in tokens. */
export interface TokenTally {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

/**
 * How a subagent's transcript ended. `capacity_exhausted` is the one that
 * matters on a subscription: the agent was launched, consumed context, and
 * returned nothing because the usage window ran out.
 */
export type AgentStatus =
  | "reported_structured"
  | "reported_text"
  | "capacity_exhausted"
  | "output_cap"
  | "api_error"
  | "no_report";

export interface AgentUsage {
  agentId: string;
  file: string;
  /** Dominant real model, for display. Never `<synthetic>` — see the LOCK below. */
  model: string | null;
  /**
   * Tokens attributed to the model that actually produced them.
   *
   * 🔒 LOCKED [PRICE-PER-MESSAGE-MODEL-NOT-PER-AGENT] — 2026-08-19
   * ⛔ NEVER price an agent's whole tally at one model taken from its last
   *    assistant message.
   * WHY: Claude Code writes client-side notices ("You're out of usage
   *    credits", "API Error: …") as assistant messages with model
   *    `<synthetic>` and ALL-ZERO usage. They land LAST, so last-wins tagged
   *    every capacity-killed agent `<synthetic>`, and since that model has no
   *    price its real consumption was dropped as UNPRICED: 2.2M tokens
   *    silently missing from wf_41771d7b — precisely the agents that died,
   *    i.e. the cost of the failure the report exists to surface.
   * FIX: tally per message model and price each group at its own rate.
   *    `<synthetic>` contributes 0 tokens and is excluded from `model`.
   */
  tokensByModel: Map<string | null, TokenTally>;
  toolCalls: number;
  /** Distinct assistant messages (API round-trips), after dedup. */
  turns: number;
  tokens: TokenTally;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  status: AgentStatus;
  /** True when the agent actually returned a result to its caller. */
  reported: boolean;
}

export type RunKind = "workflow" | "agents" | "session";

export interface RunUsage {
  /** Workflow id (`wf_…`) for workflow runs, else the session id. */
  runId: string;
  kind: RunKind;
  /** Decoded project slug, e.g. `-Users-yan-Projects-ContextEngine`. */
  project: string;
  sessionId: string;
  agents: AgentUsage[];
  totals: TokenTally;
  toolCalls: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Wall-clock span of the run, not the sum of agent durations. */
  durationMs: number | null;
}

// ─── Pricing ───────────────────────────────────────────────────────────────

/** Dollars per million tokens, per tier. */
export interface ModelPricing {
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_5m_per_mtok: number;
  cache_write_1h_per_mtok?: number;
}

export interface CostBreakdown {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  total: number;
  /** What the same tokens would have cost with no cache at all. */
  withoutCache: number;
  /** Tokens with no pricing entry — surfaced, never silently zeroed. */
  unpricedTokens: number;
}

/**
 * Longest-prefix pricing lookup. `*` is the catch-all. Returns null when
 * nothing matches — the caller must report that, not assume free.
 *
 * 🔒 LOCK [ABSENCE-IS-NOT-A-VERDICT] — an unpriced model is "I don't know
 *    what this cost", never "$0". Session 21's recurring bug shape.
 */
export function pricingFor(model: string | null, table: ModelPricing[]): ModelPricing | null {
  if (!model) return null;
  let best: ModelPricing | null = null;
  for (const p of table) {
    if (p.model === "*") { if (!best) best = p; continue; }
    if (model === p.model || model.startsWith(p.model)) {
      if (!best || best.model === "*" || p.model.length > best.model.length) best = p;
    }
  }
  return best;
}

/**
 * Value a token tally at API list prices.
 *
 * 🔒 LOCKED [COST-IS-NOTIONAL-ON-SUBSCRIPTION] — 2026-08-19
 * ⛔ NEVER present this number as money spent, or gate anything on it alone,
 *    without stating the billing mode.
 * WHY: this machine runs Claude Code on a Max subscription (verified:
 *    `subscriptionType: max`, no ANTHROPIC_API_KEY anywhere). No dollar here
 *    is ever debited. The figure is a VALUATION at public API rates, useful
 *    only to compare two approaches against each other.
 * FIX: on subscription the scarce resource is CAPACITY, not money. A $75 run
 *    that finishes beats a $40 run that loses 13% of its agents to the usage
 *    window. `contextengine cost` therefore always prints volume, valued cost
 *    AND intensity — never one alone.
 */
export function costOf(t: TokenTally, p: ModelPricing | null): CostBreakdown {
  if (!p) {
    return {
      input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0, withoutCache: 0,
      unpricedTokens: t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead + t.output,
    };
  }
  const M = 1_000_000;
  // 1h cache write is 2x input where 5m is 1.25x, i.e. 1.6x the 5m rate.
  const w1h = p.cache_write_1h_per_mtok ?? p.cache_write_5m_per_mtok * 1.6;
  const input = (t.input * p.input_per_mtok) / M;
  const cacheWrite = (t.cacheWrite5m * p.cache_write_5m_per_mtok + t.cacheWrite1h * w1h) / M;
  const cacheRead = (t.cacheRead * p.cache_read_per_mtok) / M;
  const output = (t.output * p.output_per_mtok) / M;
  // No cache: every cached token would have been a fresh input token.
  const withoutCache =
    ((t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead) * p.input_per_mtok +
      t.output * p.output_per_mtok) / M;
  return { input, cacheWrite, cacheRead, output, total: input + cacheWrite + cacheRead + output, withoutCache, unpricedTokens: 0 };
}

/**
 * Whether a cost figure can be presented as money at all.
 *
 * 🔒 LOCKED [NEVER-RENDER-AN-UNKNOWN-AS-A-NUMBER] — 2026-08-20
 * ⛔ NEVER print a $0.00 cost row, total, or "caching saved" figure while
 *    `unpricedTokens > 0`.
 * WHY: 2.5.0 rendered a full VALUED COST table of $0.00 over 1.08 billion
 *    unpriced tokens, including "caching saved $0.00 (0%)" — which reads as
 *    "your caching achieves nothing" when the true reuse was 8x. The token
 *    accounting was right; the PRESENTATION layer turned "I have no rates"
 *    into a number. That is Session 21's rule at the display layer: any
 *    plausible-looking value returned from a branch meaning "I could not
 *    determine this" is the bug, however reasonable it looks.
 * FIX: branch on this before formatting. `unpriced` must render the word
 *    UNPRICED, never a currency amount.
 */
export type PricingStatus = "priced" | "partial" | "unpriced";

export function pricingStatus(c: CostBreakdown): PricingStatus {
  if (c.unpricedTokens === 0) return "priced";
  return c.total === 0 ? "unpriced" : "partial";
}

export function emptyTally(): TokenTally {
  return { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
}

export function addTally(a: TokenTally, b: TokenTally): TokenTally {
  return {
    input: a.input + b.input,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  };
}

export function totalTokens(t: TokenTally): number {
  return t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead + t.output;
}

/** Tokens the model actually wrote, as a share of all tokens moved. */
export function outputShare(t: TokenTally): number {
  const all = totalTokens(t);
  return all === 0 ? 0 : t.output / all;
}

/**
 * cache_read / cache_write. HIGH is healthy — it means a prefix was built
 * once and reused many times. LOW means the cache is being rebuilt and thrown
 * away (unstable prefix, cold fan-out). This is the ratio that actually
 * signals waste; a large cache_read on its own does not.
 */
export function cacheEfficiency(t: TokenTally): number {
  const w = t.cacheWrite5m + t.cacheWrite1h;
  if (w === 0) return t.cacheRead > 0 ? Infinity : 0;
  return t.cacheRead / w;
}

// ─── Parsing ───────────────────────────────────────────────────────────────

interface RawUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseTs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Root of Claude Code's transcript store. Env override exists for tests. */
export function transcriptRoot(): string {
  return process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
}

/**
 * Parse one `agent-*.jsonl`. Tolerant by design: transcripts are appended
 * live and a truncated final line is normal, so unparseable lines are
 * skipped rather than failing the whole run.
 */
export function parseAgentTranscript(file: string): AgentUsage {
  const tokens = emptyTally();
  let toolCalls = 0;
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let sawStructuredOutputOk = false;
  const structuredIds = new Set<string>();
  let lastText = "";
  let lastTextSeen = false;

  // message.id → winning usage + the model that produced it (see LOCKs above).
  const byMessageId = new Map<string, { usage: RawUsage; model: string | null }>();

  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { /* unreadable → empty agent */ }

  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let d: any;
    try { d = JSON.parse(s); } catch { continue; }

    const ts = parseTs(d.timestamp);
    if (ts !== null) {
      if (startedAt === null || ts < startedAt) startedAt = ts;
      if (endedAt === null || ts > endedAt) endedAt = ts;
    }

    const m = d.message;
    if (!m || typeof m !== "object") continue;
    const content = Array.isArray(m.content) ? m.content : [];

    // Tool results resolve StructuredOutput calls (the workflow report path).
    for (const b of content) {
      if (b?.type === "tool_result" && structuredIds.has(b.tool_use_id)) {
        if (String(b.content ?? "").toLowerCase().includes("success")) sawStructuredOutputOk = true;
      }
    }

    if (d.type !== "assistant") continue;

    for (const b of content) {
      if (b?.type === "tool_use") {
        toolCalls++;
        if (b.name === "StructuredOutput" && typeof b.id === "string") structuredIds.add(b.id);
      }
    }

    const u: RawUsage | undefined = m.usage;
    if (u && typeof m.id === "string") {
      const prev = byMessageId.get(m.id);
      // output_tokens is monotonic within an id; the largest is the final count.
      if (!prev || num(u.output_tokens) > num(prev.usage.output_tokens)) {
        byMessageId.set(m.id, { usage: u, model: typeof m.model === "string" ? m.model : null });
      }
    }
  }

  // Final text = the last assistant text block in the file.
  for (const line of raw.split("\n").reverse()) {
    if (lastTextSeen) break;
    const s = line.trim();
    if (!s) continue;
    let d: any;
    try { d = JSON.parse(s); } catch { continue; }
    if (d.type !== "assistant") continue;
    const content = Array.isArray(d.message?.content) ? d.message.content : [];
    const texts = content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? ""));
    if (texts.length && texts.join("").trim()) { lastText = texts.join(""); lastTextSeen = true; }
  }

  const tokensByModel = new Map<string | null, TokenTally>();
  for (const { usage: u, model: mm } of byMessageId.values()) {
    let bucket = tokensByModel.get(mm);
    if (!bucket) { bucket = emptyTally(); tokensByModel.set(mm, bucket); }
    const cc = u.cache_creation ?? {};
    const w5 = num(cc.ephemeral_5m_input_tokens);
    const w1 = num(cc.ephemeral_1h_input_tokens);
    const ccTotal = num(u.cache_creation_input_tokens);
    for (const t of [tokens, bucket]) {
      t.input += num(u.input_tokens);
      t.cacheRead += num(u.cache_read_input_tokens);
      t.output += num(u.output_tokens);
      // Prefer the per-TTL split; fall back to the flat total as 5m when the
      // breakdown is absent, so tokens are never dropped.
      if (w5 || w1) { t.cacheWrite5m += w5; t.cacheWrite1h += w1; }
      else t.cacheWrite5m += ccTotal;
    }
  }

  // Dominant REAL model by output, for display. `<synthetic>` is a client-side
  // notice, never a producer of tokens.
  let model: string | null = null;
  let best = -1;
  for (const [mm, t] of tokensByModel) {
    if (mm === null || mm === "<synthetic>") continue;
    if (t.output > best) { best = t.output; model = mm; }
  }

  return {
    agentId: basename(file).replace(/^agent-/, "").replace(/\.jsonl$/, ""),
    file,
    model,
    tokensByModel,
    toolCalls,
    turns: byMessageId.size,
    tokens,
    startedAt,
    endedAt,
    durationMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
    status: classifyStatus(lastText, sawStructuredOutputOk),
    reported: false, // set below
  };
}

/**
 * Terminal state of an agent, read from its own last words.
 *
 * 🔒 LOCKED [AGENT-REPORTED-IS-NOT-LAST-LINE] — 2026-08-19
 * ⛔ NEVER decide "this agent completed" from the last LINE of the transcript.
 * WHY: 2,090 of 2,310 real transcripts end on a `user` line — the tool_result
 *    for the agent's own final `StructuredOutput` call. Reading the last line
 *    classified 2,146 healthy agents as "other" and would have made
 *    fanout_without_canary fire on every workflow ever run.
 * FIX: an agent reported if it produced a final text block, or a
 *    StructuredOutput call that returned success. Measured with this rule:
 *    2,285 reported / 19 capacity_exhausted / 3 api_error / 2 no_report.
 */
export function classifyStatus(lastText: string, structuredOk: boolean): AgentStatus {
  const t = lastText.trim();
  const low = t.toLowerCase();
  if (low.includes("out of usage credits") || low.includes("usage limit")) return "capacity_exhausted";
  if (low.includes("output token maximum")) return "output_cap";
  if (t.startsWith("API Error")) return "api_error";
  if (structuredOk) return "reported_structured";
  if (t) return "reported_text";
  return "no_report";
}

export function isReported(s: AgentStatus): boolean {
  return s === "reported_structured" || s === "reported_text";
}

// ─── Discovery ─────────────────────────────────────────────────────────────

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => {
      try { return statSync(join(dir, e)).isDirectory(); } catch { return false; }
    });
  } catch { return []; }
}

function safeFiles(dir: string, prefix: string): string[] {
  try {
    return readdirSync(dir)
      .filter((e) => e.startsWith(prefix) && e.endsWith(".jsonl"))
      .map((e) => join(dir, e));
  } catch { return []; }
}

export interface CollectOptions {
  /** Only this session id (the uuid naming the transcript dir). */
  session?: string;
  /** Only projects whose slug contains this substring. */
  project?: string;
  /** Only this run id (`wf_…`). */
  run?: string;
  /** Ignore runs that ended before this epoch-ms. */
  since?: number;
  root?: string;
}

function finishRun(
  runId: string, kind: RunKind, project: string, sessionId: string, agents: AgentUsage[],
): RunUsage {
  let totals = emptyTally();
  let toolCalls = 0;
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  for (const a of agents) {
    a.reported = isReported(a.status);
    totals = addTally(totals, a.tokens);
    toolCalls += a.toolCalls;
    if (a.startedAt !== null && (startedAt === null || a.startedAt < startedAt)) startedAt = a.startedAt;
    if (a.endedAt !== null && (endedAt === null || a.endedAt > endedAt)) endedAt = a.endedAt;
  }
  return {
    runId, kind, project, sessionId, agents, totals, toolCalls, startedAt, endedAt,
    durationMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
  };
}

/**
 * Walk the transcript store and return one RunUsage per fan-out.
 *
 * A "run" is a workflow directory (`subagents/workflows/wf_…`) or the loose
 * `subagents/` directory of a session (Agent-tool calls). Parent-session
 * transcripts are not fan-outs and are excluded — this measures the cost of
 * DELEGATION, which is the thing worth deciding about before spending it.
 */
export function collectRuns(opts: CollectOptions = {}): RunUsage[] {
  const root = opts.root || transcriptRoot();
  if (!existsSync(root)) return [];
  const runs: RunUsage[] = [];

  for (const project of safeDirs(root)) {
    if (opts.project && !project.toLowerCase().includes(opts.project.toLowerCase())) continue;
    const projDir = join(root, project);

    for (const sessionId of safeDirs(projDir)) {
      if (opts.session && sessionId !== opts.session) continue;
      const subagents = join(projDir, sessionId, "subagents");
      if (!existsSync(subagents)) continue;

      const loose = safeFiles(subagents, "agent-");
      if (loose.length && (!opts.run || opts.run === sessionId)) {
        runs.push(finishRun(sessionId, "agents", project, sessionId, loose.map(parseAgentTranscript)));
      }

      const wfRoot = join(subagents, "workflows");
      for (const wf of safeDirs(wfRoot)) {
        if (opts.run && wf !== opts.run) continue;
        const files = safeFiles(join(wfRoot, wf), "agent-");
        if (!files.length) continue;
        runs.push(finishRun(wf, "workflow", project, sessionId, files.map(parseAgentTranscript)));
      }
    }
  }

  const filtered = opts.since ? runs.filter((r) => (r.endedAt ?? 0) >= opts.since!) : runs;
  filtered.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return filtered;
}

// ─── Run-level derived metrics ─────────────────────────────────────────────

export interface RunMetrics {
  agents: number;
  reported: number;
  capacityExhausted: number;
  failed: number;
  toolCalls: number;
  medianToolCalls: number;
  outputShare: number;
  cacheEfficiency: number;
  cost: CostBreakdown;
  /** Agents that started before ANY sibling had reported — the un-canaried fleet. */
  launchedBeforeFirstReport: number;
}

export function runCost(run: RunUsage, table: ModelPricing[]): CostBreakdown {
  // Price per model, so a mixed-model run is valued correctly.
  const byModel = new Map<string | null, TokenTally>();
  for (const a of run.agents) {
    for (const [m, t] of a.tokensByModel) {
      byModel.set(m, addTally(byModel.get(m) ?? emptyTally(), t));
    }
  }
  const acc: CostBreakdown = {
    input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0, withoutCache: 0, unpricedTokens: 0,
  };
  for (const [model, t] of byModel) {
    const c = costOf(t, pricingFor(model, table));
    acc.input += c.input; acc.cacheWrite += c.cacheWrite; acc.cacheRead += c.cacheRead;
    acc.output += c.output; acc.total += c.total; acc.withoutCache += c.withoutCache;
    acc.unpricedTokens += c.unpricedTokens;
  }
  return acc;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The canary count. "Run ONE unit and read its consumption before scaling"
 * is only obeyed if some agent finished before the rest were launched, so
 * count the agents whose start precedes the earliest sibling completion.
 */
export function metricsFor(run: RunUsage, table: ModelPricing[]): RunMetrics {
  const reported = run.agents.filter((a) => a.reported);
  const firstReport = reported.reduce<number | null>(
    (min, a) => (a.endedAt !== null && (min === null || a.endedAt < min) ? a.endedAt : min), null);
  const launchedBeforeFirstReport =
    firstReport === null
      ? run.agents.length
      : run.agents.filter((a) => a.startedAt !== null && a.startedAt < firstReport).length;

  return {
    agents: run.agents.length,
    reported: reported.length,
    capacityExhausted: run.agents.filter((a) => a.status === "capacity_exhausted").length,
    failed: run.agents.filter((a) => !a.reported).length,
    toolCalls: run.toolCalls,
    medianToolCalls: median(run.agents.map((a) => a.toolCalls)),
    outputShare: outputShare(run.totals),
    cacheEfficiency: cacheEfficiency(run.totals),
    cost: runCost(run, table),
    launchedBeforeFirstReport,
  };
}

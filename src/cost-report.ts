/**
 * Multi-agent cost report, shared by the CLI (`contextengine cost`) and the MCP tool
 * (`agent_cost`). One renderer, two surfaces.
 *
 * [LOCKED] [COST-REPORT-ONE-RENDERER] — 2026-08-21
 * [NEVER] render the cost report in cli.ts or index.ts directly.
 * WHY: the CLI shipped on 2026-08-20 as 170 lines of console.log; an MCP tool written the same
 *      way would have been a second copy of every threshold, label and guard (NOTIONAL, UNPRICED,
 *      floor-not-cost) that drifts the first time one of them is edited.
 * FIX: buildCostReport() returns { text, json }; cli.ts prints, index.ts responds. Both surfaces
 *      read the same thresholds from .contextengine/policy.json via loadCostThresholds().
 */
import {
  collectRuns,
  metricsFor,
  transcriptRoot,
  emptyTally,
  addTally,
  totalTokens,
  pricingStatus,
  pricingFor,
  type CostBreakdown,
  type ModelPricing,
} from "./transcript-collector.js";
import { DEFAULT_PRICING, DEFAULT_PRICING_ASOF } from "./default-pricing.js";
import {
  runTranscriptHeuristics,
  DEFAULT_COST_THRESHOLDS,
  type CostThresholds,
} from "./detector.js";
import { loadRepoPolicy } from "./policy.js";

export interface CostReportOptions {
  session?: string;
  project?: string;
  run?: string;
  days?: number;
  top?: number;
}

export interface CostReport {
  /** Human-readable report, what the CLI prints. */
  text: string;
  /** Structured report, what `--json` prints. null when no runs were found. */
  json: Record<string, unknown> | null;
  runs: number;
}


function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
}

function fmtDur(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Resolve cost thresholds + pricing from policy, falling back to defaults. */
export function loadCostThresholds(cwd: string): { t: CostThresholds; source: string } {
  const res = loadRepoPolicy(cwd);
  if (res && res.ok && res.policy.agent_cost) {
    const a = res.policy.agent_cost;
    // [DEFAULT-RATES-SHIP-WITH-THE-PACKAGE] — an agent_cost block that omits
    // `pricing` must not silently price nothing.
    const hasOwnRates = (a.pricing as ModelPricing[]).length > 0;
    return {
      t: {
        billing_mode: a.billing_mode,
        pricing: hasOwnRates ? (a.pricing as ModelPricing[]) : DEFAULT_PRICING,
        min_cache_efficiency: a.min_cache_efficiency,
        max_tool_calls_per_agent: a.max_tool_calls_per_agent,
        max_cost_per_agent_usd: a.max_cost_per_agent_usd,
        min_fanout_for_canary: a.min_fanout_for_canary,
        max_failed_share: a.max_failed_share,
      },
      source:
        ".contextengine/policy.json" +
        (hasOwnRates ? "" : ` (rates: built-in, as of ${DEFAULT_PRICING_ASOF})`),
    };
  }
  return {
    t: DEFAULT_COST_THRESHOLDS,
    source: `built-in defaults, rates as of ${DEFAULT_PRICING_ASOF} (no agent_cost in policy.json)`,
  };
}

export function buildCostReport(opts: CostReportOptions = {}, cwd: string = process.cwd()): CostReport {
  const out: string[] = [];
  const line = (s = "") => { out.push(s); };
  const top = Math.max(1, opts.top ?? 10);
  const since = opts.days ? Date.now() - opts.days * 86_400_000 : undefined;

  const { t, source } = loadCostThresholds(cwd);

  const runs = collectRuns({
    session: opts.session,
    project: opts.project,
    run: opts.run,
    since,
  });

  if (!runs.length) {
    line("No multi-agent runs found in " + transcriptRoot());
    line("(fan-outs only: parent sessions are not counted — this measures delegation)");
    return { text: out.join("\n"), json: null, runs: 0 };
  }

  const scored = runs
    .map((r) => ({ run: r, m: metricsFor(r, t.pricing) }))
    .sort((a, b) => b.m.cost.total - a.m.cost.total);

  const signals = runTranscriptHeuristics(runs, t);

  const json = {
      billing_mode: t.billing_mode,
      cost_is_notional: t.billing_mode === "subscription",
      thresholds_source: source,
      runs: scored.map(({ run, m }) => ({
        runId: run.runId, kind: run.kind, project: run.project, sessionId: run.sessionId,
        volume: run.totals, intensity: {
          agents: m.agents, reported: m.reported, failed: m.failed,
          capacityExhausted: m.capacityExhausted, toolCalls: m.toolCalls,
          medianToolCalls: m.medianToolCalls, durationMs: run.durationMs,
          launchedBeforeFirstReport: m.launchedBeforeFirstReport,
        },
        cost: m.cost, cacheEfficiency: Number.isFinite(m.cacheEfficiency) ? m.cacheEfficiency : null,
        outputShare: m.outputShare,
      })),
      signals,
  };

  // Aggregate across everything in scope.
  let vol = emptyTally();
  let agents = 0, toolCalls = 0, failed = 0, capacity = 0, reported = 0;
  let cost = 0, withoutCache = 0, unpriced = 0;
  // Which models carried tokens but matched no rate — named in the output so
  // the fix is actionable instead of "something was unpriced".
  const unpricedModels = new Set<string>();
  for (const { run, m } of scored) {
    for (const a of run.agents) {
      for (const [model, tally] of a.tokensByModel) {
        if (totalTokens(tally) > 0 && !pricingFor(model, t.pricing)) {
          unpricedModels.add(model ?? "(no model recorded)");
        }
      }
    }
    vol = addTally(vol, run.totals);
    agents += m.agents; toolCalls += m.toolCalls; failed += m.failed;
    capacity += m.capacityExhausted; reported += m.reported;
    cost += m.cost.total; withoutCache += m.cost.withoutCache; unpriced += m.cost.unpricedTokens;
  }
  const allTok = totalTokens(vol);
  const cw = vol.cacheWrite5m + vol.cacheWrite1h;

  line();
  line(`MULTI-AGENT COST — ${scored.length} run(s), ${agents} subagents`);
  line(`thresholds: ${source}`);
  line();

  // ── 1. VOLUME ───────────────────────────────────────────────────────────
  line("VOLUME (tokens moved)");
  const volRow = (label: string, n: number) =>
    line(`  ${label.padEnd(16)} ${fmtTok(n).padStart(8)}  ${allTok ? ((100 * n) / allTok).toFixed(1).padStart(5) : "  0.0"}%`);
  volRow("cache read", vol.cacheRead);
  volRow("cache write", cw);
  volRow("input (fresh)", vol.input);
  volRow("output", vol.output);
  line(`  ${"total".padEnd(16)} ${fmtTok(allTok).padStart(8)}`);
  line();

  // ── 2. VALUED COST ──────────────────────────────────────────────────────
  const notional = t.billing_mode === "subscription";
  let ci = 0, ccw = 0, ccr = 0, co = 0;
  for (const { m } of scored) { ci += m.cost.input; ccw += m.cost.cacheWrite; ccr += m.cost.cacheRead; co += m.cost.output; }
  const agg: CostBreakdown = {
    input: ci, cacheWrite: ccw, cacheRead: ccr, output: co,
    total: cost, withoutCache, unpricedTokens: unpriced,
  };
  const status = pricingStatus(agg);

  line(`VALUED COST (API list prices)${notional && status !== "unpriced" ? " — NOTIONAL, NOT BILLED" : ""}`);

  // [NEVER-RENDER-AN-UNKNOWN-AS-A-NUMBER] — with nothing priced there is no
  // cost to show. Printing a $0.00 table here reads as "this run was free"
  // and "caching saved 0%", both false.
  if (status === "unpriced") {
    line(`  UNPRICED — no rate matched any model in this data, so no cost can be`);
    line(`  stated. ${fmtTok(unpriced)} tokens were moved. This is an unknown, not $0.`);
    line();
    line(`  Models seen without a rate: ${[...unpricedModels].sort().join(", ") || "(unknown)"}`);
    line(`  Add them to .contextengine/policy.json → agent_cost.pricing.`);
    line();
  } else {
    if (notional) {
      line("  This machine runs Claude Code on a subscription: no dollar below is");
      line("  debited. Use these figures to compare approaches, not as spend.");
    }
    const costRow = (label: string, n: number) =>
      line(`  ${label.padEnd(16)} ${("$" + n.toFixed(2)).padStart(8)}  ${cost ? ((100 * n) / cost).toFixed(1).padStart(5) : "  0.0"}%`);
    costRow("cache read", ccr);
    costRow("cache write", ccw);
    costRow("input (fresh)", ci);
    costRow("output", co);
    line(`  ${"total".padEnd(16)} ${("$" + cost.toFixed(2)).padStart(8)}`);
    line(`  ${"without cache".padEnd(16)} ${("$" + withoutCache.toFixed(2)).padStart(8)}  ` +
      `caching saved $${(withoutCache - cost).toFixed(2)} (${withoutCache ? (100 * (1 - cost / withoutCache)).toFixed(0) : "0"}%)`);
    if (status === "partial") {
      line(`  ⚠ ${fmtTok(unpriced)} tokens UNPRICED and NOT in the figures above` +
        ` (${[...unpricedModels].sort().join(", ") || "unknown model"}) — the total is a floor, not the cost`);
    }
    line();
  }

  // ── 3. INTENSITY (the capacity proxy) ───────────────────────────────────
  line(`INTENSITY (capacity proxy${notional ? " — the scarce resource here" : ""})`);
  line(`  subagents        ${String(agents).padStart(8)}`);
  line(`  reported         ${String(reported).padStart(8)}`);
  line(`  returned nothing ${String(failed).padStart(8)}${failed ? `  (${((100 * failed) / agents).toFixed(0)}% of the fleet)` : ""}`);
  line(`  died at window   ${String(capacity).padStart(8)}${capacity ? "  ← capacity spent for no result" : ""}`);
  line(`  tool calls       ${String(toolCalls).padStart(8)}  (${(toolCalls / Math.max(1, agents)).toFixed(1)}/agent)`);
  line(`  cache reuse      ${(cw ? (vol.cacheRead / cw).toFixed(1) + "x" : "—").padStart(8)}  ${cw && vol.cacheRead / cw < t.min_cache_efficiency ? "← below floor, prefix is being rebuilt" : "(higher is better)"}`);
  line();

  // ── Top runs ────────────────────────────────────────────────────────────
  line(`TOP RUNS BY VALUED COST (${Math.min(top, scored.length)} of ${scored.length})`);
  line(`  ${"cost".padStart(8)} ${"agents".padStart(6)} ${"dead".padStart(4)} ${"tools".padStart(5)} ${"reuse".padStart(6)} ${"dur".padStart(7)}  run`);
  for (const { run, m } of scored.slice(0, top)) {
    const reuse = Number.isFinite(m.cacheEfficiency) ? m.cacheEfficiency.toFixed(1) + "x" : "—";
    line(
      `  ${("$" + m.cost.total.toFixed(2)).padStart(8)} ${String(m.agents).padStart(6)} ` +
      `${String(m.failed).padStart(4)} ${String(m.medianToolCalls).padStart(5)} ${reuse.padStart(6)} ` +
      `${fmtDur(run.durationMs).padStart(7)}  ${run.runId} ${run.project.replace(/^-Users-yan-/, "")}`);
  }
  line();

  // ── Signals ─────────────────────────────────────────────────────────────
  if (!signals.length) {
    line("✅ No context_burn or fanout_without_canary signals.");
  } else {
    const crit = signals.filter((s) => s.severity === "critical");
    line(`SIGNALS — ${signals.length} (${crit.length} critical)`);
    for (const s of signals.slice(0, 20)) {
      line(`  ${s.severity === "critical" ? "🔴" : "⚠️ "} [${s.kind}] ${s.reason}`);
    }
    if (signals.length > 20) line(`  … ${signals.length - 20} more (use --json)`);
  }
  line();
  return { text: out.join("\n"), json, runs: scored.length };
}

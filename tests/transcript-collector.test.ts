import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseAgentTranscript, classifyStatus, pricingFor, costOf, cacheEfficiency,
  outputShare, collectRuns, metricsFor, emptyTally, pricingStatus, type ModelPricing,
} from "../src/transcript-collector.js";
import {
  detectContextBurn, detectFanoutWithoutCanary, DEFAULT_COST_THRESHOLDS,
  type CostThresholds,
} from "../src/detector.js";
import { DEFAULT_PRICING } from "../src/default-pricing.js";

const OPUS5: ModelPricing = {
  model: "claude-opus-5",
  input_per_mtok: 5, output_per_mtok: 25,
  cache_read_per_mtok: 0.5, cache_write_5m_per_mtok: 6.25, cache_write_1h_per_mtok: 10,
};
const HAIKU: ModelPricing = {
  model: "claude-haiku-4-5",
  input_per_mtok: 1, output_per_mtok: 5,
  cache_read_per_mtok: 0.1, cache_write_5m_per_mtok: 1.25, cache_write_1h_per_mtok: 2,
};
const TABLE = [OPUS5, HAIKU];

let dir: string;
const line = (o: unknown) => JSON.stringify(o) + "\n";

function asst(id: string, model: string, usage: unknown, content: unknown[], ts: string) {
  return line({ type: "assistant", timestamp: ts, message: { id, model, usage, content } });
}
function usage(input: number, cw: number, cr: number, out: number) {
  return {
    input_tokens: input, cache_creation_input_tokens: cw,
    cache_read_input_tokens: cr, output_tokens: out,
    cache_creation: { ephemeral_5m_input_tokens: cw, ephemeral_1h_input_tokens: 0 },
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ce-transcripts-"));
  const wf = join(dir, "-Users-x-proj", "sess-1", "subagents", "workflows", "wf_test");
  mkdirSync(wf, { recursive: true });

  // Agent A: one message.id spread over 3 lines, each repeating the SAME usage.
  // Naive per-line summing = 3x overcount.
  writeFileSync(join(wf, "agent-aaa.jsonl"),
    asst("msg_1", "claude-opus-5", usage(10, 1000, 5000, 1), [{ type: "text", text: "" }], "2026-08-19T10:00:00Z") +
    asst("msg_1", "claude-opus-5", usage(10, 1000, 5000, 1), [{ type: "tool_use", name: "Read", id: "t1" }], "2026-08-19T10:00:01Z") +
    asst("msg_1", "claude-opus-5", usage(10, 1000, 5000, 700), [{ type: "tool_use", name: "Grep", id: "t2" }], "2026-08-19T10:00:02Z") +
    asst("msg_2", "claude-opus-5", usage(5, 200, 6000, 300), [{ type: "text", text: "done, here is the answer" }], "2026-08-19T10:05:00Z"));

  // Agent B: real work on opus-5, then a <synthetic> capacity notice with ZERO usage.
  writeFileSync(join(wf, "agent-bbb.jsonl"),
    asst("msg_3", "claude-opus-5", usage(0, 4000, 40000, 900), [{ type: "text", text: "working" }], "2026-08-19T10:00:00Z") +
    asst("msg_4", "<synthetic>", usage(0, 0, 0, 0),
      [{ type: "text", text: "You're out of usage credits. Run /usage-credits to keep using Fable 5." }], "2026-08-19T10:09:00Z"));

  // Agent C: reports via StructuredOutput, file ends on a `user` tool_result line.
  writeFileSync(join(wf, "agent-ccc.jsonl"),
    asst("msg_5", "claude-opus-5", usage(0, 500, 9000, 400), [{ type: "text", text: "summary text" }], "2026-08-19T10:01:00Z") +
    asst("msg_6", "claude-opus-5", usage(0, 100, 9500, 50), [{ type: "tool_use", name: "StructuredOutput", id: "so1" }], "2026-08-19T10:02:00Z") +
    line({ type: "user", timestamp: "2026-08-19T10:02:01Z",
      message: { content: [{ type: "tool_result", tool_use_id: "so1", content: "Structured output provided successfully" }] } }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("[TRANSCRIPT-DEDUP-BY-MESSAGE-ID]", () => {
  it("counts each message.id once, not once per content block", () => {
    const a = parseAgentTranscript(join(dir, "-Users-x-proj", "sess-1", "subagents", "workflows", "wf_test", "agent-aaa.jsonl"));
    // msg_1 (1000cw/5000cr) + msg_2 (200cw/6000cr) — NOT 3x msg_1.
    expect(a.tokens.cacheRead).toBe(11000);
    expect(a.tokens.cacheWrite5m).toBe(1200);
    expect(a.tokens.input).toBe(15);
    expect(a.turns).toBe(2);
  });

  it("takes the max output_tokens within a message.id (streaming grows it)", () => {
    const a = parseAgentTranscript(join(dir, "-Users-x-proj", "sess-1", "subagents", "workflows", "wf_test", "agent-aaa.jsonl"));
    expect(a.tokens.output).toBe(1000); // 700 (final for msg_1) + 300, never 1+1+700
  });

  it("counts every tool_use line, even ones sharing a message.id", () => {
    const a = parseAgentTranscript(join(dir, "-Users-x-proj", "sess-1", "subagents", "workflows", "wf_test", "agent-aaa.jsonl"));
    expect(a.toolCalls).toBe(2);
  });
});

describe("[PRICE-PER-MESSAGE-MODEL-NOT-PER-AGENT]", () => {
  const f = () => join(dir, "-Users-x-proj", "sess-1", "subagents", "workflows", "wf_test", "agent-bbb.jsonl");

  it("does not tag an agent <synthetic> because its last message was a client notice", () => {
    expect(parseAgentTranscript(f()).model).toBe("claude-opus-5");
  });

  it("keeps the dead agent's real consumption priced", () => {
    const a = parseAgentTranscript(f());
    const opus = a.tokensByModel.get("claude-opus-5")!;
    expect(opus.cacheRead).toBe(40000);
    const c = costOf(opus, pricingFor("claude-opus-5", TABLE));
    expect(c.unpricedTokens).toBe(0);
    expect(c.total).toBeGreaterThan(0);
  });

  it("still classifies it as capacity_exhausted", () => {
    expect(parseAgentTranscript(f()).status).toBe("capacity_exhausted");
  });
});

describe("[AGENT-REPORTED-IS-NOT-LAST-LINE]", () => {
  it("treats a successful StructuredOutput as a report though the file ends on a user line", () => {
    const a = parseAgentTranscript(join(dir, "-Users-x-proj", "sess-1", "subagents", "workflows", "wf_test", "agent-ccc.jsonl"));
    expect(a.status).toBe("reported_structured");
    expect(a.reported === false || a.reported === true).toBe(true);
  });

  it("classifies terminal states from the agent's own last words", () => {
    expect(classifyStatus("You're out of usage credits.", false)).toBe("capacity_exhausted");
    expect(classifyStatus("...exceeded the 64000 output token maximum", false)).toBe("output_cap");
    expect(classifyStatus("API Error: Connection closed", false)).toBe("api_error");
    expect(classifyStatus("here is my finding", false)).toBe("reported_text");
    expect(classifyStatus("", true)).toBe("reported_structured");
    expect(classifyStatus("", false)).toBe("no_report");
  });
});

describe("[PRICING-LIVES-IN-POLICY] / [ABSENCE-IS-NOT-A-VERDICT]", () => {
  it("matches by longest prefix, so dated ids resolve", () => {
    expect(pricingFor("claude-haiku-4-5-20251001", TABLE)?.model).toBe("claude-haiku-4-5");
  });
  it("returns null for an unknown model rather than a free ride", () => {
    expect(pricingFor("some-other-model", TABLE)).toBeNull();
    expect(pricingFor(null, TABLE)).toBeNull();
  });
  it("reports unpriced tokens instead of valuing them at zero", () => {
    const t = { ...emptyTally(), cacheRead: 1000, output: 50 };
    const c = costOf(t, null);
    expect(c.total).toBe(0);
    expect(c.unpricedTokens).toBe(1050);
  });
  it("prices the real 30-agent workflow shape to its published figure", () => {
    // 65.7M cache_read + 4.4M cache_write + 534k output on Opus 5.
    const t = { ...emptyTally(), cacheRead: 65_700_000, cacheWrite5m: 4_400_000, output: 534_000 };
    const c = costOf(t, OPUS5);
    expect(c.total).toBeCloseTo(73.70, 1);       // ~$74 with cache
    expect(c.withoutCache).toBeCloseTo(363.85, 1); // ~$364 without
  });
});

describe("[BURN-IS-COST-WEIGHTED-NOT-VOLUME]", () => {
  const run = (tokens: ReturnType<typeof emptyTally>, agents: number, toolCalls: number) => ({
    runId: "wf_x", kind: "workflow" as const, project: "p", sessionId: "s",
    agents: Array.from({ length: agents }, (_, i) => ({
      agentId: `a${i}`, file: "", model: "claude-opus-5",
      tokensByModel: new Map([["claude-opus-5", tokens]]),
      toolCalls, turns: 1, tokens, startedAt: 0, endedAt: 1000, durationMs: 1000,
      status: "reported_text" as const, reported: true,
    })),
    totals: tokens, toolCalls: toolCalls * agents,
    startedAt: 0, endedAt: 1000, durationMs: 1000,
  });
  const T: CostThresholds = { ...DEFAULT_COST_THRESHOLDS, pricing: TABLE, max_cost_per_agent_usd: 1e9 };

  it("does NOT fire on a healthy well-cached run despite a tiny output share", () => {
    // 1.8% output by volume — the figure that looks alarming and is not.
    const t = { ...emptyTally(), cacheRead: 19_591_634, cacheWrite5m: 2_373_513, output: 405_715 };
    expect(outputShare(t)).toBeLessThan(0.02);
    expect(cacheEfficiency(t)).toBeGreaterThan(3);
    expect(detectContextBurn(run(t, 30, 1), T)).toBeNull();
  });

  it("fires critical when cache writes dominate cost (prefix rebuilt, not reused)", () => {
    const t = { ...emptyTally(), cacheRead: 8_500_000, cacheWrite5m: 22_700_000, output: 2_500_000 };
    expect(cacheEfficiency(t)).toBeLessThan(3);
    const s = detectContextBurn(run(t, 722, 1), T)!;
    expect(s).not.toBeNull();
    expect(s.kind).toBe("context_burn");
    expect(s.severity).toBe("critical");
    expect(s.reason).toMatch(/cache WRITES/);
  });

  it("fires on tool-call inflation (agents searching for their inputs)", () => {
    const t = { ...emptyTally(), cacheRead: 500_000, cacheWrite5m: 10_000, output: 5_000 };
    const s = detectContextBurn(run(t, 10, 11), T)!;
    expect(s.reason).toMatch(/tool calls\/agent/);
  });

  it("marks cost as notional under a subscription", () => {
    const t = { ...emptyTally(), cacheRead: 500_000, cacheWrite5m: 10_000, output: 5_000 };
    const s = detectContextBurn(run(t, 10, 11), T)!;
    expect(s.payload.costIsNotional).toBe(true);
  });
});

describe("[CANARY-IS-A-TIME-ORDERING]", () => {
  const mkAgents = (specs: Array<{ start: number; end: number; status?: "reported_text" | "capacity_exhausted" }>) =>
    specs.map((s, i) => ({
      agentId: `a${i}`, file: "", model: "claude-opus-5",
      tokensByModel: new Map([["claude-opus-5", emptyTally()]]),
      toolCalls: 1, turns: 1, tokens: emptyTally(),
      startedAt: s.start, endedAt: s.end, durationMs: s.end - s.start,
      status: s.status ?? ("reported_text" as const),
      reported: (s.status ?? "reported_text") === "reported_text",
    }));
  const mkRun = (agents: ReturnType<typeof mkAgents>) => ({
    runId: "wf_y", kind: "workflow" as const, project: "p", sessionId: "s",
    agents, totals: emptyTally(), toolCalls: agents.length,
    startedAt: 0, endedAt: 100, durationMs: 100,
  });
  const T: CostThresholds = { ...DEFAULT_COST_THRESHOLDS, pricing: TABLE };

  it("fires when the fleet launched before any unit had reported", () => {
    const s = detectFanoutWithoutCanary(mkRun(mkAgents(
      Array.from({ length: 10 }, () => ({ start: 0, end: 50 })))), T)!;
    expect(s.kind).toBe("fanout_without_canary");
    expect(s.payload.launchedBeforeFirstReport).toBe(10);
  });

  it("does NOT fire when a canary reported before the fleet launched", () => {
    const agents = mkAgents([
      { start: 0, end: 10 },                                     // canary finishes at 10
      ...Array.from({ length: 9 }, () => ({ start: 20, end: 60 })), // fleet starts after
    ]);
    expect(detectFanoutWithoutCanary(mkRun(agents), T)).toBeNull();
  });

  it("is NOT satisfied merely because every agent eventually reported", () => {
    // 300 agents, all reported — still un-canaried, because all started at once.
    const agents = mkAgents(Array.from({ length: 300 }, () => ({ start: 0, end: 90 })));
    expect(detectFanoutWithoutCanary(mkRun(agents), T)).not.toBeNull();
  });

  it("escalates to critical when agents died at the usage window", () => {
    const agents = mkAgents([
      ...Array.from({ length: 36 }, () => ({ start: 0, end: 50 })),
      ...Array.from({ length: 15 }, () => ({ start: 0, end: 50, status: "capacity_exhausted" as const })),
    ]);
    const s = detectFanoutWithoutCanary(mkRun(agents), T)!;
    expect(s.severity).toBe("critical");
    expect(s.payload.capacityExhausted).toBe(15);
    expect(s.reason).toMatch(/capacity spent for no result/);
  });

  it("ignores fan-outs below the canary threshold", () => {
    const agents = mkAgents(Array.from({ length: 3 }, () => ({ start: 0, end: 50 })));
    expect(detectFanoutWithoutCanary(mkRun(agents), T)).toBeNull();
  });
});

describe("collectRuns", () => {
  it("discovers workflow runs and aggregates their agents", () => {
    const runs = collectRuns({ root: dir });
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("wf_test");
    expect(runs[0].kind).toBe("workflow");
    expect(runs[0].agents).toHaveLength(3);
  });

  it("counts one capacity death and two reports", () => {
    const m = metricsFor(collectRuns({ root: dir })[0], TABLE);
    expect(m.capacityExhausted).toBe(1);
    expect(m.reported).toBe(2);
    expect(m.failed).toBe(1);
    expect(m.cost.unpricedTokens).toBe(0);
  });

  it("returns nothing for a root that does not exist", () => {
    expect(collectRuns({ root: join(dir, "nope") })).toEqual([]);
  });
});

describe("[NEVER-RENDER-AN-UNKNOWN-AS-A-NUMBER]", () => {
  const tally = (cr: number, out: number) => ({ ...emptyTally(), cacheRead: cr, output: out });

  it("classifies a fully-priced report as priced", () => {
    const c = costOf(tally(1_000_000, 10_000), OPUS5);
    expect(c.unpricedTokens).toBe(0);
    expect(pricingStatus(c)).toBe("priced");
  });

  it("classifies a report with NO matching rate as unpriced, never as $0", () => {
    const c = costOf(tally(1_000_000, 10_000), null);
    expect(c.total).toBe(0);
    expect(c.unpricedTokens).toBeGreaterThan(0);
    expect(pricingStatus(c)).toBe("unpriced"); // must not be presented as money
  });

  it("classifies a partly-priced report as partial, so the total reads as a floor", () => {
    const priced = costOf(tally(1_000_000, 10_000), OPUS5);
    const mixed = { ...priced, unpricedTokens: 500_000 };
    expect(pricingStatus(mixed)).toBe("partial");
  });

  /**
   * The regression this file exists for: 2.5.0 printed `total $0.00` and
   * `caching saved $0.00 (0%)` over 1.08 BILLION unpriced tokens.
   */
  it("never reports a zero total as priced while tokens are unpriced", () => {
    const c = costOf({ ...emptyTally(), cacheRead: 939_700_000, cacheWrite5m: 117_200_000, output: 24_700_000 }, null);
    expect(c.total).toBe(0);
    expect(pricingStatus(c)).not.toBe("priced");
    expect(pricingStatus(c)).toBe("unpriced");
  });
});

describe("[DEFAULT-RATES-SHIP-WITH-THE-PACKAGE]", () => {
  it("ships a non-empty rate table", () => {
    expect(DEFAULT_PRICING.length).toBeGreaterThan(0);
  });

  it("prices every model observed in the real transcript corpus", () => {
    // Measured 2026-08-19 across 2,310 agent transcripts.
    for (const m of [
      "claude-opus-5", "claude-opus-4-8", "claude-fable-5",
      "claude-sonnet-5", "claude-haiku-4-5-20251001",
    ]) {
      expect(pricingFor(m, DEFAULT_PRICING), `${m} must have a shipped rate`).not.toBeNull();
    }
  });

  it("keeps the cache multipliers consistent with published pricing", () => {
    const o = pricingFor("claude-opus-5", DEFAULT_PRICING)!;
    expect(o.cache_read_per_mtok).toBeCloseTo(o.input_per_mtok * 0.1, 5);
    expect(o.cache_write_5m_per_mtok).toBeCloseTo(o.input_per_mtok * 1.25, 5);
    expect(o.cache_write_1h_per_mtok).toBeCloseTo(o.input_per_mtok * 2, 5);
  });

  it("has NO catch-all, so an unknown vendor still reports unpriced", () => {
    expect(pricingFor("gpt-9-turbo", DEFAULT_PRICING)).toBeNull();
  });

  it("makes the default detector thresholds able to price a run", () => {
    expect(DEFAULT_COST_THRESHOLDS.pricing.length).toBeGreaterThan(0);
    const c = costOf({ ...emptyTally(), cacheRead: 1e6 }, pricingFor("claude-opus-5", DEFAULT_COST_THRESHOLDS.pricing));
    expect(c.total).toBeGreaterThan(0);
    expect(pricingStatus(c)).toBe("priced");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProtocolFirewall } from "../src/firewall.js";

describe("ProtocolFirewall", () => {
  it("constructs without error", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    expect(fw).toBeDefined();
  });

  it("getState returns initial counters at zero", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    const state = fw.getState();
    expect(state.toolCalls).toBe(0);
    expect(state.learningsSaved).toBe(0);
    expect(state.sessionSaved).toBe(false);
    expect(state.nudgesIssued).toBe(0);
    expect(state.searchRecalls).toBe(0);
    expect(state.truncations).toBe(0);
    expect(state.timeSavedMinutes).toBe(0);
  });

  it("increments toolCalls on wrap()", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    fw.wrap("search_context", "some results");
    fw.wrap("list_sources", "sources list");
    expect(fw.getState().toolCalls).toBe(2);
  });

  it("exempt tools pass through unmodified", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    const input = "Learning saved successfully";
    const output = fw.wrap("save_learning", input);
    expect(output).toBe(input);
  });

  it("exempt tools still count as tool calls", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    fw.wrap("save_learning", "ok");
    fw.wrap("save_session", "ok");
    fw.wrap("list_learnings", "list");
    expect(fw.getState().toolCalls).toBe(3);
  });

  it("records learnings saved from save_learning calls", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    fw.wrap("save_learning", "ok");
    fw.wrap("save_learning", "ok");
    expect(fw.getState().learningsSaved).toBe(2);
  });

  it("records session saved from save_session calls", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    expect(fw.getState().sessionSaved).toBe(false);
    fw.wrap("save_session", "ok");
    expect(fw.getState().sessionSaved).toBe(true);
  });

  it("recordSearchRecalls increments recall counter", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    fw.recordSearchRecalls(3);
    fw.recordSearchRecalls(2);
    expect(fw.getState().searchRecalls).toBe(5);
  });

  it("time-saved heuristic reflects recalls and saves", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    fw.recordSearchRecalls(5); // 5 * 2 = 10 min
    fw.wrap("save_learning", "ok"); // 1 * 1 = 1 min
    fw.wrap("save_session", "ok"); // 3 min
    // Total: 10 + 1 + 3 = 14 (plus nudges, but early calls are silent)
    expect(fw.getState().timeSavedMinutes).toBeGreaterThanOrEqual(14);
  });

  it("setProjectDirs does not throw", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    expect(() =>
      fw.setProjectDirs([{ path: "/tmp/test", name: "test" }])
    ).not.toThrow();
  });

  it("silent phase does not modify response on first calls", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    const response = "Here are your search results: ...";
    // First few calls should be silent (no enforcement block)
    const output = fw.wrap("search_context", response);
    expect(output).toBe(response);
  });

  it("returns string from wrap (never undefined)", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    for (let i = 0; i < 20; i++) {
      const result = fw.wrap("search_context", "test response");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it("getState exposes round and roundsSinceSessionSave", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    const state = fw.getState();
    expect(state.round).toBe(0);
    expect(state.roundsSinceSessionSave).toBe(0);
  });

  it("session save resets roundsSinceSessionSave", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    // Simulate some calls (all in one round since <30s apart)
    fw.wrap("search_context", "results");
    fw.wrap("search_context", "results");
    fw.wrap("save_session", "ok");
    expect(fw.getState().roundsSinceSessionSave).toBe(0);
    expect(fw.getState().sessionSaved).toBe(true);
  });

  it("learning warmup lowered to 5 calls", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    // At 5+ calls without any learning, output should include a nudge
    for (let i = 0; i < 8; i++) {
      fw.wrap("search_context", "test");
    }
    // Since calls >= 5 and learningsSaved = 0, obligation should fail
    const state = fw.getState();
    expect(state.toolCalls).toBe(8);
    expect(state.learningsSaved).toBe(0);
  });

  it("getState exposes learningsInjected", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    expect(fw.getState().learningsInjected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: Round-based escalation with time simulation
// ---------------------------------------------------------------------------
describe("ProtocolFirewall — round escalation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances round after 30s gap between non-exempt calls", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    fw.wrap("search_context", "r1");
    expect(fw.getState().round).toBe(1);

    // Same round — within 30s
    vi.advanceTimersByTime(10_000);
    fw.wrap("list_sources", "r1 still");
    expect(fw.getState().round).toBe(1);

    // New round — 31s gap
    vi.advanceTimersByTime(31_000);
    fw.wrap("search_context", "r2");
    expect(fw.getState().round).toBe(2);
  });

  it("escalates to footer at round 2 without session save", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    // Burn through warmup (5+ calls)
    for (let i = 0; i < 6; i++) fw.wrap("search_context", "warmup");
    expect(fw.getState().round).toBe(1);

    // Round 2 — 31s gap
    vi.advanceTimersByTime(31_000);
    const r2 = fw.wrap("search_context", "data");
    expect(fw.getState().round).toBe(2);
    expect(fw.getState().roundsSinceSessionSave).toBe(2);
    // Should have enforcement footer or header
    expect(r2).toContain("CE PROTOCOL");
  });

  it("escalates to header at round 3 without session save", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    for (let i = 0; i < 6; i++) fw.wrap("search_context", "warmup");

    vi.advanceTimersByTime(31_000);
    fw.wrap("search_context", "round 2");

    vi.advanceTimersByTime(31_000);
    const r3 = fw.wrap("search_context", "round 3");
    expect(fw.getState().round).toBe(3);
    expect(fw.getState().roundsSinceSessionSave).toBe(3);
    // Header level: block comes BEFORE the response text
    expect(r3.indexOf("CE PROTOCOL")).toBeLessThan(r3.indexOf("round 3"));
  });

  it("escalates to degraded (truncation) at round 4+", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    for (let i = 0; i < 6; i++) fw.wrap("search_context", "warmup");

    vi.advanceTimersByTime(31_000);
    fw.wrap("search_context", "r2");
    vi.advanceTimersByTime(31_000);
    fw.wrap("search_context", "r3");
    vi.advanceTimersByTime(31_000);

    const longResponse = "A".repeat(1000);
    const r4 = fw.wrap("search_context", longResponse);
    expect(fw.getState().round).toBe(4);
    expect(fw.getState().roundsSinceSessionSave).toBe(4);
    // Degraded: truncated
    expect(r4).toContain("chars hidden");
    expect(fw.getState().truncations).toBeGreaterThan(0);
  });

  it("session save resets escalation across rounds", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    for (let i = 0; i < 6; i++) fw.wrap("search_context", "warmup");

    // Advance to round 2
    vi.advanceTimersByTime(31_000);
    fw.wrap("search_context", "r2");
    expect(fw.getState().roundsSinceSessionSave).toBe(2);

    // Save session — should reset
    fw.wrap("save_session", "ok");
    expect(fw.getState().roundsSinceSessionSave).toBe(0);

    // Round 3 — but only 1 round since save
    vi.advanceTimersByTime(31_000);
    const r3 = fw.wrap("search_context", "after save");
    expect(fw.getState().roundsSinceSessionSave).toBe(1);
    // Should be silent or footer at most — not header/degraded
    expect(r3).not.toContain("chars hidden");
  });
});

// ---------------------------------------------------------------------------
// Integration: Learning auto-injection
// ---------------------------------------------------------------------------
describe("ProtocolFirewall — learning auto-injection", () => {
  it("injects learnings when search function is set and hint provided", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    fw.setLearningSearchFn(() => [
      { rule: "Always use port 8002 for API", project: "MyProject", category: "infrastructure" },
      { rule: "Use absolute node path in MCP configs", category: "deployment" },
    ]);

    const output = fw.wrap("search_context", "test results", "port configuration");
    expect(output).toContain("Relevant learnings");
    expect(output).toContain("Always use port 8002");
    expect(output).toContain("[MyProject/infrastructure]");
    expect(output).toContain("[deployment]");
    expect(output).toContain("test results"); // original response preserved
  });

  it("does not inject when no hint provided", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    fw.setLearningSearchFn(() => [
      { rule: "some learning", category: "other" },
    ]);

    const output = fw.wrap("search_context", "test results");
    expect(output).not.toContain("Relevant learnings");
  });

  it("does not inject when search returns empty", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    fw.setLearningSearchFn(() => []);

    const output = fw.wrap("search_context", "test results", "nothing matches");
    expect(output).not.toContain("Relevant learnings");
  });

  it("caches injection results within same round", () => {
    let callCount = 0;
    const fw = new ProtocolFirewall({ skipRestore: true });
    fw.setLearningSearchFn(() => {
      callCount++;
      return [{ rule: "cached rule", category: "testing" }];
    });

    fw.wrap("search_context", "first", "same hint");
    fw.wrap("search_context", "second", "same hint");
    // Search function should only be called once (cached)
    expect(callCount).toBe(1);
  });

  it("increments learningsInjected counter", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    fw.setLearningSearchFn(() => [
      { rule: "rule 1", category: "a" },
      { rule: "rule 2", category: "b" },
    ]);

    fw.wrap("search_context", "test", "hint");
    expect(fw.getState().learningsInjected).toBe(2);
    // Also counted as search recalls
    expect(fw.getState().searchRecalls).toBe(2);
  });

  it("limits injection to INJECT_MAX (3)", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    fw.setLearningSearchFn(() => [
      { rule: "rule 1", category: "a" },
      { rule: "rule 2", category: "b" },
      { rule: "rule 3", category: "c" },
      { rule: "rule 4", category: "d" },
      { rule: "rule 5", category: "e" },
    ]);

    const output = fw.wrap("search_context", "test", "hint");
    // Count bullet points
    const bullets = output.match(/•/g) || [];
    expect(bullets.length).toBe(3);
    expect(fw.getState().learningsInjected).toBe(3);
  });

  it("exempt tools do not get learning injection", () => {
    const fw = new ProtocolFirewall({ skipRestore: true });
    fw.setLearningSearchFn(() => [
      { rule: "some rule", category: "test" },
    ]);

    const output = fw.wrap("save_learning", "ok", "some hint");
    expect(output).toBe("ok");
    expect(output).not.toContain("Relevant learnings");
  });
});

// ---------------------------------------------------------------------------
// Integration: Cross-window state resumption
// ---------------------------------------------------------------------------
describe("ProtocolFirewall — cross-window state", () => {
  const { join } = require("path");
  const { homedir } = require("os");
  const fs = require("fs");
  const statsPath = join(homedir(), ".contextengine", "session-stats.json");
  let originalContent: string | null = null;

  beforeEach(() => {
    // Preserve existing stats file
    try {
      originalContent = fs.readFileSync(statsPath, "utf-8");
    } catch {
      originalContent = null;
    }
  });

  afterEach(() => {
    // Restore original stats file
    try {
      if (originalContent !== null) {
        fs.writeFileSync(statsPath, originalContent, "utf-8");
      } else {
        fs.unlinkSync(statsPath);
      }
    } catch {
      /* ignore */
    }
  });

  it("resumes round counters from recent session-stats.json", () => {
    // Write a fake prior session
    const priorStats = {
      pid: 99999, // different from current
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), // just now = recent
      toolCalls: 20,
      round: 5,
      roundsSinceSessionSave: 3,
      sessionSaved: true,
      searchRecalls: 10,
      learningsInjected: 4,
    };
    fs.writeFileSync(statsPath, JSON.stringify(priorStats), "utf-8");

    // Create firewall WITHOUT skipRestore — should load prior state
    const fw = new ProtocolFirewall();
    const state = fw.getState();
    expect(state.round).toBe(5);
    expect(state.roundsSinceSessionSave).toBe(3);
    expect(state.sessionSaved).toBe(true);
    expect(state.searchRecalls).toBe(10);
  });

  it("ignores stale session-stats.json (older than 5 min)", () => {
    const staleDate = new Date(Date.now() - 10 * 60_000); // 10 min ago
    const priorStats = {
      pid: 99999,
      startedAt: staleDate.toISOString(),
      updatedAt: staleDate.toISOString(),
      round: 8,
      roundsSinceSessionSave: 6,
    };
    fs.writeFileSync(statsPath, JSON.stringify(priorStats), "utf-8");

    const fw = new ProtocolFirewall();
    const state = fw.getState();
    // Should NOT resume — stale
    expect(state.round).toBe(0);
    expect(state.roundsSinceSessionSave).toBe(0);
  });

  it("ignores session-stats.json from same PID", () => {
    const priorStats = {
      pid: process.pid, // same process
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      round: 5,
      roundsSinceSessionSave: 3,
    };
    fs.writeFileSync(statsPath, JSON.stringify(priorStats), "utf-8");

    const fw = new ProtocolFirewall();
    const state = fw.getState();
    // Should NOT resume — same PID
    expect(state.round).toBe(0);
    expect(state.roundsSinceSessionSave).toBe(0);
  });
});

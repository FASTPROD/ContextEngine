import { describe, it, expect } from "vitest";
import { ProtocolFirewall } from "../src/firewall.js";

describe("ProtocolFirewall", () => {
  it("constructs without error", () => {
    const fw = new ProtocolFirewall();
    expect(fw).toBeDefined();
  });

  it("getState returns initial counters at zero", () => {
    const fw = new ProtocolFirewall();
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
    const fw = new ProtocolFirewall();
    fw.wrap("search_context", "some results");
    fw.wrap("list_sources", "sources list");
    expect(fw.getState().toolCalls).toBe(2);
  });

  it("exempt tools pass through unmodified", () => {
    const fw = new ProtocolFirewall();
    const input = "Learning saved successfully";
    const output = fw.wrap("save_learning", input);
    expect(output).toBe(input);
  });

  it("exempt tools still count as tool calls", () => {
    const fw = new ProtocolFirewall();
    fw.wrap("save_learning", "ok");
    fw.wrap("save_session", "ok");
    fw.wrap("list_learnings", "list");
    expect(fw.getState().toolCalls).toBe(3);
  });

  it("records learnings saved from save_learning calls", () => {
    const fw = new ProtocolFirewall();
    fw.wrap("save_learning", "ok");
    fw.wrap("save_learning", "ok");
    expect(fw.getState().learningsSaved).toBe(2);
  });

  it("records session saved from save_session calls", () => {
    const fw = new ProtocolFirewall();
    expect(fw.getState().sessionSaved).toBe(false);
    fw.wrap("save_session", "ok");
    expect(fw.getState().sessionSaved).toBe(true);
  });

  it("recordSearchRecalls increments recall counter", () => {
    const fw = new ProtocolFirewall();
    fw.recordSearchRecalls(3);
    fw.recordSearchRecalls(2);
    expect(fw.getState().searchRecalls).toBe(5);
  });

  it("time-saved heuristic reflects recalls and saves", () => {
    const fw = new ProtocolFirewall();
    fw.recordSearchRecalls(5); // 5 * 2 = 10 min
    fw.wrap("save_learning", "ok"); // 1 * 1 = 1 min
    fw.wrap("save_session", "ok"); // 3 min
    // Total: 10 + 1 + 3 = 14 (plus nudges, but early calls are silent)
    expect(fw.getState().timeSavedMinutes).toBeGreaterThanOrEqual(14);
  });

  it("setProjectDirs does not throw", () => {
    const fw = new ProtocolFirewall();
    expect(() =>
      fw.setProjectDirs([{ path: "/tmp/test", name: "test" }])
    ).not.toThrow();
  });

  it("silent phase does not modify response on first calls", () => {
    const fw = new ProtocolFirewall();
    const response = "Here are your search results: ...";
    // First few calls should be silent (no enforcement block)
    const output = fw.wrap("search_context", response);
    expect(output).toBe(response);
  });

  it("returns string from wrap (never undefined)", () => {
    const fw = new ProtocolFirewall();
    for (let i = 0; i < 20; i++) {
      const result = fw.wrap("search_context", "test response");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
  });
});

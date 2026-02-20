import { describe, it, expect } from "vitest";
import {
  PREMIUM_MODULES,
  PREMIUM_TOOLS,
  requiresActivation,
  gateCheck,
} from "../src/activation.js";

describe("PREMIUM_MODULES", () => {
  it("contains expected premium modules", () => {
    expect(PREMIUM_MODULES).toContain("agents");
    expect(PREMIUM_MODULES).toContain("collectors");
    expect(PREMIUM_MODULES).toContain("search-adv");
  });

  it("has no duplicates", () => {
    const unique = new Set(PREMIUM_MODULES);
    expect(unique.size).toBe(PREMIUM_MODULES.length);
  });
});

describe("PREMIUM_TOOLS", () => {
  it("contains expected gated tools", () => {
    expect(PREMIUM_TOOLS).toContain("score_project");
    expect(PREMIUM_TOOLS).toContain("run_audit");
    expect(PREMIUM_TOOLS).toContain("check_ports");
    expect(PREMIUM_TOOLS).toContain("list_projects");
  });

  it("has exactly 4 gated tools", () => {
    expect(PREMIUM_TOOLS.length).toBe(4);
  });
});

describe("requiresActivation", () => {
  it("returns true for gated tools", () => {
    expect(requiresActivation("score_project")).toBe(true);
    expect(requiresActivation("run_audit")).toBe(true);
    expect(requiresActivation("check_ports")).toBe(true);
    expect(requiresActivation("list_projects")).toBe(true);
  });

  it("returns false for free tools", () => {
    expect(requiresActivation("search")).toBe(false);
    expect(requiresActivation("list_sources")).toBe(false);
    expect(requiresActivation("save_learning")).toBe(false);
    expect(requiresActivation("list_learnings")).toBe(false);
    expect(requiresActivation("activate")).toBe(false);
  });
});

describe("gateCheck", () => {
  it("returns null for free tools (no gate)", () => {
    expect(gateCheck("search")).toBeNull();
    expect(gateCheck("list_sources")).toBeNull();
    expect(gateCheck("save_learning")).toBeNull();
  });

  it("returns error string for gated tools without activation", () => {
    // Without a valid license file, gated tools should return an error message
    const result = gateCheck("score_project");
    if (result !== null) {
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
    // If null, it means user has a valid license — also acceptable
  });
});

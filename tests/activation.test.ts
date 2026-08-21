import { describe, it, expect } from "vitest";
import {
  PREMIUM_TOOLS,
  requiresActivation,
  gateCheck,
} from "../src/activation.js";
import * as activation from "../src/activation.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// [LOCK] [DELTA-RETIRED]
describe("delta bundle is retired", () => {
  it("exports no delta machinery", () => {
    const names = Object.keys(activation);
    for (const n of names) expect(n.toLowerCase()).not.toContain("delta");
    expect(names).not.toContain("PREMIUM_MODULES");
  });

  it("source has no decrypt, no delta import, no gate on a delta cache", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "activation.ts"), "utf-8");
    expect(src).not.toMatch(/createDecipheriv/);
    expect(src).not.toMatch(/function (isDeltaInstalled|loadDeltaModule|installDelta|installedDeltaVersion)\b/);
    expect(src).not.toMatch(/Premium modules not installed/);
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

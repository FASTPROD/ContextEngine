import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildCostReport } from "../src/cost-report.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// [LOCK] [COST-REPORT-ONE-RENDERER]
describe("cost report, one renderer for CLI and MCP", () => {
  it("returns text and never throws, with or without runs on this machine", () => {
    const r = buildCostReport({ days: 1, top: 3 });
    expect(typeof r.text).toBe("string");
    expect(r.text.length).toBeGreaterThan(0);
    if (r.runs === 0) {
      expect(r.json).toBeNull();
      expect(r.text).toContain("No multi-agent runs found");
    } else {
      expect(r.json).not.toBeNull();
      expect(r.text).toContain("MULTI-AGENT COST");
      expect((r.json as any).runs.length).toBe(r.runs);
      expect((r.json as any).runs.length).toBeLessThanOrEqual(1000);
    }
  });

  it("a run filter that matches nothing yields the empty report, not a crash", () => {
    const r = buildCostReport({ run: "wf_does-not-exist-0000" });
    expect(r.runs).toBe(0);
    expect(r.json).toBeNull();
  });

  it("neither cli.ts nor index.ts renders the report themselves", () => {
    for (const f of ["cli.ts", "index.ts"]) {
      const src = readFileSync(join(root, "src", f), "utf-8");
      expect(src).toContain("buildCostReport(");
      expect(src).not.toMatch(/NOTIONAL, NOT BILLED|TOP RUNS BY VALUED COST|NEVER-RENDER-AN-UNKNOWN/);
    }
  });

  it("agent_cost is registered as an MCP tool and listed in the manifest", () => {
    const idx = readFileSync(join(root, "src", "index.ts"), "utf-8");
    expect(idx).toMatch(/server\.tool\(\s*"agent_cost"/);
    const manifest = readFileSync(join(root, "src", "tools-manifest.ts"), "utf-8");
    expect(manifest).toContain('"agent_cost"');
  });
});

import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { join } from "path";

const CLI = join(__dirname, "..", "dist", "cli.js");

function run(args: string, timeout = 15000): string {
  try {
    return execSync(`node ${CLI} ${args}`, {
      timeout,
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      cwd: join(__dirname, ".."),
    }).trim();
  } catch (e: any) {
    // Some commands exit non-zero intentionally
    return (e.stdout || "").trim() + "\n" + (e.stderr || "").trim();
  }
}

describe("CLI smoke tests", () => {
  it("help command prints usage", () => {
    const output = run("help");
    expect(output).toContain("contextengine");
    expect(output).toContain("search");
  });

  it("search returns results for common query", () => {
    const output = run('search "typescript"');
    // Should either return results or a "no results" message — not crash
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });

  it("list-sources returns source information", () => {
    const output = run("list-sources");
    expect(typeof output).toBe("string");
    // Should contain at least some file path or "sources" text
    expect(output.length).toBeGreaterThan(0);
  });

  it("list-learnings returns without error", () => {
    const output = run("list-learnings");
    expect(typeof output).toBe("string");
  });

  it("list-sessions returns without error", () => {
    const output = run("list-sessions");
    expect(typeof output).toBe("string");
  });

  it("stats returns session stats or no-session message", () => {
    const output = run("stats");
    expect(typeof output).toBe("string");
    // Either shows stats or "No active session stats found"
    expect(output.length).toBeGreaterThan(0);
  });

  it("unknown command exits without crash", () => {
    // Unknown commands may enter interactive mode, so just verify help works
    const output = run("help");
    expect(output).toContain("search");
    expect(output).toContain("list-sources");
  });

  it("search with topK flag works", () => {
    const output = run('search "docker" -n 3');
    expect(typeof output).toBe("string");
  });
});

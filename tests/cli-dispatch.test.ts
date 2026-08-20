import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { KNOWN_COMMANDS, SERVER_COMMANDS, suggestCommands, isKnownCommand } from "../src/cli-commands.js";

const CLI_SRC = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");

/** Every literal the dispatcher actually compares argv[2] against. */
function dispatchedLiterals(): string[] {
  const out = new Set<string>();
  for (const m of CLI_SRC.matchAll(/command === "([^"]+)"/g)) out.add(m[1]);
  return [...out].sort();
}

describe("[UNKNOWN-COMMAND-MUST-NOT-START-A-SERVER] parity", () => {
  it("every dispatched literal is listed in KNOWN_COMMANDS", () => {
    const missing = dispatchedLiterals().filter((c) => !KNOWN_COMMANDS.includes(c));
    expect(missing, `add these to KNOWN_COMMANDS in src/cli-commands.ts: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("every KNOWN_COMMAND is either dispatched or a server alias", () => {
    const literals = dispatchedLiterals();
    const orphaned = KNOWN_COMMANDS.filter(
      (c) => !literals.includes(c) && !SERVER_COMMANDS.includes(c),
    );
    expect(orphaned, `listed but unreachable: ${orphaned.join(", ")}`).toEqual([]);
  });

  it("the dispatcher no longer falls through to the MCP server", () => {
    // The exact shape of the old bug: a bare `else` importing the server.
    expect(CLI_SRC).not.toMatch(/}\s*else\s*{\s*\/\/ Default: start MCP server/);
    expect(CLI_SRC).toMatch(/command === undefined \|\| SERVER_COMMANDS\.includes\(command\)/);
  });
});

describe("suggestCommands", () => {
  it("suggests the nearest command for a typo", () => {
    expect(suggestCommands("scor")).toContain("score");
    expect(suggestCommands("audit-verfy")).toContain("audit-verify");
    expect(suggestCommands("cots")).toContain("cost");
  });

  it("suggests the family for a prefix", () => {
    expect(suggestCommands("audit")).toContain("audit-export");
  });

  it("returns nothing rather than a wrong guess when nothing is close", () => {
    expect(suggestCommands("zzzzzzzzzzzz")).toEqual([]);
  });

  it("never suggests flag aliases", () => {
    expect(suggestCommands("-help").some((c) => c.startsWith("-"))).toBe(false);
  });
});

describe("isKnownCommand", () => {
  it("knows the commands the help text advertises", () => {
    for (const c of ["search", "score", "cost", "audit-verify", "audit-rotate", "init"]) {
      expect(isKnownCommand(c)).toBe(true);
    }
  });
  it("rejects a command that does not exist", () => {
    // SESSION_22 §E3 measured this one and mistook a booting MCP server for a missing gate.
    expect(isKnownCommand("check-ports")).toBe(false);
  });
});

describe("built CLI behaviour", () => {
  const run = (args: string[]) => {
    try {
      const stdout = execFileSync("node", ["dist/cli.js", ...args], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      });
      return { code: 0, stdout, stderr: "" };
    } catch (e: any) {
      return { code: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  };

  it("exits 1 and names the unknown command instead of hanging", () => {
    const r = run(["scor"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Unknown command: scor/);
    expect(r.stderr).toMatch(/Did you mean: .*score/);
  });

  it("prints the package version for --version", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
    const r = run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it("still exits 0 on help", () => {
    expect(run(["help"]).code).toBe(0);
  });
});

// [LOCK] [HOOKS-COMPARED-BY-EXPANDED-PATH] [INSTALL-VERIFIES-BY-COUNT]: the 2026-09-06 doubling,
// replayed through the real installer. Throwaway HOME via src/test-setup.ts: the real
// ~/.claude/settings.json is never read or written here.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookEntry, Settings } from "./install-claude-hook.js";

let I: typeof import("./install-claude-hook.js");
const HOME = process.env.HOME as string;
const EMIT = join(HOME, ".claude", "hooks", "opscontext-emit.sh");
const GATE = join(HOME, ".claude", "hooks", "opscontext-session-gate.sh");
const SETTINGS = join(HOME, ".claude", "settings.json");
const SIMPLICITY = join(HOME, ".claude", "hooks", "opscontext-simplicity-gate.py");
const KINDS = ["UserPromptSubmit", "PostToolUse", "SessionStart"];

beforeAll(async () => {
  I = await import("./install-claude-hook.js");
});
afterEach(() => {
  vi.restoreAllMocks();
});

const cmd = (command: string, timeout = 5) => ({ type: "command", command, timeout });
const dollarEmit = (kind: string) => cmd(`$HOME/.claude/hooks/opscontext-emit.sh ${kind}`);
const absEmit = (kind: string) => cmd(`${EMIT} ${kind}`);

/** Runs the installer with console and process.exit captured; returns what it printed. */
async function install(args: string[] = []): Promise<{ out: string; err: string }> {
  expect(HOME).toMatch(/ce-test-home-/); // never the real HOME
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  await I.cliInstallClaudeHook(args);
  return { out: log.mock.calls.flat().join("\n"), err: error.mock.calls.flat().join("\n") };
}

function writeSettings(settings: Settings): void {
  mkdirSync(join(HOME, ".claude"), { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
}

describe("hookScriptPath", () => {
  const home = "/Users/me";
  const emit = "/Users/me/.claude/hooks/opscontext-emit.sh";

  it("gives the same file for $HOME, ${HOME}, ~, quoted and absolute spellings", () => {
    for (const c of [
      "$HOME/.claude/hooks/opscontext-emit.sh PostToolUse",
      "${HOME}/.claude/hooks/opscontext-emit.sh PostToolUse",
      "~/.claude/hooks/opscontext-emit.sh PostToolUse",
      `"${emit}" PostToolUse`,
      `${emit} PostToolUse`,
    ]) {
      expect(I.hookScriptPath(c, home)).toBe(emit);
    }
  });

  it("does not take another file, another variable or a quoted path with spaces for ours", () => {
    expect(I.hookScriptPath("$HOMEBREW/.claude/hooks/opscontext-emit.sh", home)).toBe("$HOMEBREW/.claude/hooks/opscontext-emit.sh");
    expect(I.hookScriptPath(`${emit}.bak PostToolUse`, home)).not.toBe(emit);
    expect(I.hookScriptPath('"/Users/me/My Hooks/x.sh" arg', home)).toBe("/Users/me/My Hooks/x.sh");
    expect(I.hookScriptPath("jq -r '.x'", home)).toBe("jq");
  });
});

describe("dropDuplicateHooks", () => {
  const home = "/Users/me";
  const emit = "/Users/me/.claude/hooks/opscontext-emit.sh";
  const ours = [emit, "/Users/me/.claude/hooks/opscontext-session-gate.sh"];

  it("removes the absolute copy of a $HOME-form hook and keeps the first one", () => {
    const entries: HookEntry[] = [
      { hooks: [cmd("$HOME/.claude/hooks/opscontext-emit.sh UserPromptSubmit")] },
      { hooks: [cmd(`${emit} UserPromptSubmit`)] },
    ];
    const r = I.dropDuplicateHooks(entries, ours, home);
    expect(r.removed).toBe(1);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].hooks[0].command).toMatch(/^\$HOME\//);
  });

  it("never touches hooks that are not ours, even inside an entry that loses a duplicate", () => {
    const entries: HookEntry[] = [
      { matcher: "Read|Edit|Write", hooks: [cmd("jq -r '.tool_input.file_path'")] },
      { matcher: ".*", hooks: [cmd(`${emit} PostToolUse`)] },
      { matcher: ".*", hooks: [cmd("~/.claude/hooks/opscontext-emit.sh PostToolUse"), cmd("other.sh")] },
    ];
    const r = I.dropDuplicateHooks(entries, ours, home);
    expect(r.removed).toBe(1);
    expect(r.entries).toHaveLength(3);
    expect(r.entries[0].hooks[0].command).toMatch(/^jq/);
    expect(r.entries[2].hooks.map((h) => h.command)).toEqual(["other.sh"]);
  });

  it("keeps the same script under different matchers or with different arguments", () => {
    const entries: HookEntry[] = [
      { matcher: ".*", hooks: [cmd(`${emit} PostToolUse`)] },
      { matcher: "Bash", hooks: [cmd(`${emit} PostToolUse`)] },
      { matcher: ".*", hooks: [cmd(`${emit} SessionStart`)] },
    ];
    expect(I.dropDuplicateHooks(entries, ours, home).removed).toBe(0);
  });
});

describe("cliInstallClaudeHook on the settings of 2026-09-06", () => {
  it("recognises the $HOME-form hooks, removes the absolute duplicates, keeps everything else, verifies one per event", async () => {
    writeSettings({
      model: "keep-me",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [cmd("guard.sh")] }],
        PostToolUse: [
          { matcher: "Read|Edit|Write", hooks: [cmd("jq -r '.tool_input.file_path'")] },
          { matcher: ".*", hooks: [dollarEmit("PostToolUse")] },
          { matcher: ".*", hooks: [absEmit("PostToolUse")] },
        ],
        UserPromptSubmit: [{ hooks: [dollarEmit("UserPromptSubmit")] }, { hooks: [absEmit("UserPromptSubmit")] }],
        SessionStart: [{ hooks: [dollarEmit("SessionStart")] }, { hooks: [absEmit("SessionStart")] }],
        Stop: [{ hooks: [cmd(GATE, 15)] }],
      },
    });

    const first = await install();
    expect(first.out).toMatch(/0 hook entries added, 4 already present, 3 duplicate registrations removed\./);
    expect(first.out).toMatch(/Verified in settings\.json: exactly one registration/);
    expect(process.exit).not.toHaveBeenCalled();

    const s = JSON.parse(readFileSync(SETTINGS, "utf-8")) as Settings;
    expect(I.countOurHooks(s, KINDS, EMIT)).toEqual({ UserPromptSubmit: 1, PostToolUse: 1, SessionStart: 1 });
    expect(I.countOurHooks(s, ["Stop"], GATE)).toEqual({ Stop: 1 });
    expect(s.model).toBe("keep-me");
    expect(s.hooks?.PreToolUse?.[0].hooks[0].command).toBe("guard.sh");
    expect(s.hooks?.PostToolUse?.[0].matcher).toBe("Read|Edit|Write");

    vi.restoreAllMocks();
    const second = await install();
    expect(second.out).toMatch(/0 hook entries added, 4 already present\./);
    expect(second.out).not.toMatch(/duplicate/);
  });

  it("counts a $HOME-form hook as installed and adds only the events that are missing", async () => {
    writeSettings({ hooks: { UserPromptSubmit: [{ hooks: [dollarEmit("UserPromptSubmit")] }] } });
    const r = await install();
    expect(r.out).toMatch(/3 hook entries added, 1 already present\./);
    const s = JSON.parse(readFileSync(SETTINGS, "utf-8")) as Settings;
    expect(I.countOurHooks(s, KINDS, EMIT)).toEqual({ UserPromptSubmit: 1, PostToolUse: 1, SessionStart: 1 });
  });

  it("refuses to report success when an event still runs our hook twice (two matchers)", async () => {
    writeSettings({
      hooks: {
        PostToolUse: [
          { matcher: ".*", hooks: [absEmit("PostToolUse")] },
          { matcher: "Bash", hooks: [absEmit("PostToolUse")] },
        ],
      },
    });
    await expect(install()).rejects.toThrow("exit 1");
    const error = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(error).toMatch(/exactly one OpsContext hook per event, found PostToolUse=2/);
    expect(error).toMatch(/Backup: .*bak-pre-opscontext-/);
  });
});

describe("cliInstallClaudeHook --simplicity", () => {
  const readBack = () => JSON.parse(readFileSync(SETTINGS, "utf-8")) as Settings;
  const simplicityEntries = (s: Settings) =>
    (s.hooks?.PostToolUse ?? []).filter((e) => e.hooks.some((h) => I.hookScriptPath(h.command) === SIMPLICITY));

  it("registers the gate once under Edit|Write|MultiEdit, writes the script, and a re-run with or without the flag keeps exactly one", async () => {
    writeSettings({ hooks: {} });
    const first = await install(["--simplicity"]);
    expect(first.out).toMatch(/5 hook entries added, 0 already present\./);
    expect(first.out).toMatch(/Installed simplicity gate: .*opscontext-simplicity-gate\.py \(PostToolUse Edit\|Write\|MultiEdit\)/);
    expect(first.out).toMatch(/exactly one registration for UserPromptSubmit, PostToolUse, SessionStart, Stop, PostToolUse\(simplicity\)\./);
    expect(readFileSync(SIMPLICITY, "utf-8")).toMatch(/SIMPLICITY-GATE-SILENT-WHEN-BLIND/);
    let entries = simplicityEntries(readBack());
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBe("Edit|Write|MultiEdit");
    expect(entries[0].hooks).toEqual([{ type: "command", command: SIMPLICITY, timeout: 30 }]);
    expect(I.countOurHooks(readBack(), KINDS, EMIT)).toEqual({ UserPromptSubmit: 1, PostToolUse: 1, SessionStart: 1 });

    vi.restoreAllMocks();
    const again = await install(["--simplicity"]);
    expect(again.out).toMatch(/0 hook entries added, 5 already present\./);
    vi.restoreAllMocks();
    const plain = await install();
    expect(plain.out).toMatch(/0 hook entries added, 5 already present\./);
    entries = simplicityEntries(readBack());
    expect(entries).toHaveLength(1);
  });

  it("a plain install does not add the gate, and says so in the verified list", async () => {
    writeSettings({ hooks: {} });
    const r = await install();
    expect(r.out).toMatch(/4 hook entries added, 0 already present\./);
    expect(r.out).toMatch(/exactly one registration for UserPromptSubmit, PostToolUse, SessionStart, Stop\./);
    expect(simplicityEntries(readBack())).toHaveLength(0);
  });

  it("removes a duplicated gate registration like any other of ours", async () => {
    writeSettings({
      hooks: {
        PostToolUse: [
          { matcher: "Edit|Write|MultiEdit", hooks: [cmd("$HOME/.claude/hooks/opscontext-simplicity-gate.py", 30)] },
          { matcher: "Edit|Write|MultiEdit", hooks: [cmd(SIMPLICITY, 30)] },
        ],
      },
    });
    const r = await install();
    expect(r.out).toMatch(/1 duplicate registrations removed/);
    expect(simplicityEntries(readBack())).toHaveLength(1);
  });

  it("uninstall --simplicity removes only the gate; a full uninstall removes all of ours", async () => {
    writeSettings({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [cmd("guard.sh")] }] } });
    await install(["--simplicity"]);
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await I.cliUninstallClaudeHook(["--simplicity"]);
    let s = readBack();
    expect(simplicityEntries(s)).toHaveLength(0);
    expect(I.countOurHooks(s, KINDS, EMIT)).toEqual({ UserPromptSubmit: 1, PostToolUse: 1, SessionStart: 1 });
    expect(I.countOurHooks(s, ["Stop"], GATE)).toEqual({ Stop: 1 });
    await I.cliUninstallClaudeHook([]);
    s = readBack();
    expect(s.hooks?.PostToolUse).toBeUndefined();
    expect(s.hooks?.Stop).toBeUndefined();
    expect(s.hooks?.PreToolUse?.[0].hooks[0].command).toBe("guard.sh");
  });
});

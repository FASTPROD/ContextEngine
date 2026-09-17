// [LOCK] [SIMPLICITY-GATE-SILENT-WHEN-BLIND]: defaults/simplicity-gate.py fired for real with
// python3 on temp git repos. The ruff cases run wherever ruff is found (SIMPLICITY_RUFF, PATH,
// the usual install dirs; CI installs it) and are skipped elsewhere, never faked.
import { describe, it, expect } from "vitest";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const SCRIPT = join(process.cwd(), "defaults", "simplicity-gate.py");

function findRuff(): string | null {
  if (process.env.SIMPLICITY_RUFF) return process.env.SIMPLICITY_RUFF;
  try {
    const p = execSync("command -v ruff 2>/dev/null", { encoding: "utf-8" }).trim();
    if (p) return p;
  } catch {
    /* not on PATH */
  }
  for (const c of ["/opt/homebrew/bin/ruff", "/usr/local/bin/ruff", join(homedir(), ".local", "bin", "ruff"), join(homedir(), ".cargo", "bin", "ruff")]) {
    if (existsSync(c)) return c;
  }
  return null;
}
const RUFF = findRuff();

function fire(input: string, env: Record<string, string> = {}) {
  const r = spawnSync("python3", [SCRIPT], { input, encoding: "utf-8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const event = (file_path: string) => JSON.stringify({ tool_name: "Edit", tool_input: { file_path } });

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ce-simplicity-"));
  execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: dir });
  return dir;
}
function commit(dir: string, name: string, source: string): string {
  const file = join(dir, name);
  mkdirSync(join(dir), { recursive: true });
  writeFileSync(file, source);
  execSync(`git add . && git -c user.email=t@t -c user.name=t commit -q -m "${name}"`, { cwd: dir });
  return file;
}

const SIMPLE = "def f(x):\n    return x + 1\n";
/** Cyclomatic complexity 12 (C901 limit 10) and 12 branches (PLR0912 limit 12 is exclusive). */
const COMPLEX = [
  "def f(x):",
  ...Array.from({ length: 11 }, (_, i) => `    if x == ${i}:\n        return ${i}`),
  "    return -1",
  "",
].join("\n");

describe("simplicity gate: silent when blind", () => {
  it("exits 0 with no output on bad JSON, a non-Python file, and a Python file outside git", () => {
    expect(fire("not json")).toEqual({ code: 0, out: "", err: "" });
    expect(fire(event("/etc/hosts"))).toEqual({ code: 0, out: "", err: "" });
    const dir = mkdtempSync(join(tmpdir(), "ce-nogit-"));
    const file = join(dir, "a.py");
    writeFileSync(file, COMPLEX);
    expect(fire(event(file), { GIT_CEILING_DIRECTORIES: tmpdir() })).toEqual({ code: 0, out: "", err: "" });
  });

  it("exits 0 with no output when ruff cannot be run, even on a complex edit", () => {
    const dir = gitRepo();
    const file = commit(dir, "a.py", SIMPLE);
    writeFileSync(file, COMPLEX);
    expect(fire(event(file), { SIMPLICITY_RUFF: join(dir, "no-such-ruff") })).toEqual({ code: 0, out: "", err: "" });
  });
});

describe.skipIf(!RUFF)("simplicity gate with ruff", () => {
  const env = { SIMPLICITY_RUFF: RUFF as string };

  it("exits 2 and names the function when the edit made it more complex than HEAD", () => {
    const dir = gitRepo();
    const file = commit(dir, "a.py", SIMPLE);
    writeFileSync(file, COMPLEX);
    const r = fire(event(file), env);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/Simplicity gate: your edit of a\.py made these functions more complex/);
    expect(r.err).toMatch(/- f: `f` is too complex \(12 > 10\)/);
    expect(r.err).toMatch(/Keep every LOCK comment/);
  });

  it("stays silent on complexity that was already at HEAD, and on a simple new function beside it", () => {
    const dir = gitRepo();
    const file = commit(dir, "a.py", COMPLEX);
    writeFileSync(file, COMPLEX + "\ndef g(y):\n    return y * 2\n");
    expect(fire(event(file), env)).toEqual({ code: 0, out: "", err: "" });
  });

  it("stays silent when the edit made the function simpler", () => {
    const dir = gitRepo();
    const file = commit(dir, "a.py", COMPLEX);
    writeFileSync(file, SIMPLE);
    expect(fire(event(file), env)).toEqual({ code: 0, out: "", err: "" });
  });

  it("reports a new file only for its own offenders", () => {
    const dir = gitRepo();
    const file = join(dir, "new.py");
    writeFileSync(file, COMPLEX);
    const r = fire(event(file), env);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/new\.py/);
  });
});

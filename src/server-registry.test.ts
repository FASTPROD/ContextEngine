// [LOCK] [SERVERS-ARE-INVENTORIED]: the registry must name every live server, its build against
// the file on disk, and drop dead records. Throwaway HOME via src/test-setup.ts.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let R: typeof import("./server-registry.js");
const home = () => process.env.CONTEXTENGINE_HOME as string;
const dir = () => join(home(), "servers");

beforeAll(async () => { R = await import("./server-registry.js"); });

describe("registerServer", () => {
  it("writes a record for this process with a build hash of the script it loaded, and removes it on stop", () => {
    const script = join(home(), "fake-server.js");
    mkdirSync(home(), { recursive: true });
    writeFileSync(script, "console.log('v1')");
    const { record, stop } = R.registerServer({ version: "9.9.9", script });
    expect(record.pid).toBe(process.pid);
    expect(record.build).toBe(R.buildHashOf(script));
    expect(existsSync(join(dir(), `${process.pid}.json`))).toBe(true);
    const rep = R.listServers();
    expect(rep.servers.map((s) => s.pid)).toContain(process.pid);
    expect(rep.servers.find((s) => s.pid === process.pid)?.staleBuild).toBe(false);
    stop();
    expect(existsSync(join(dir(), `${process.pid}.json`))).toBe(false);
  });
  it("flags a server whose script changed on disk after it started, the 2026-09-05 shape", () => {
    const script = join(home(), "fake-server2.js");
    writeFileSync(script, "console.log('old build')");
    const { stop } = R.registerServer({ version: "9.9.9", script });
    writeFileSync(script, "console.log('new build')"); // a rebuild while the server keeps the old code
    const me = R.listServers().servers.find((s) => s.pid === process.pid);
    expect(me?.staleBuild).toBe(true);
    expect(R.listServers().warnings.some((w) => /older than the file on disk/.test(w))).toBe(true);
    stop();
  });
});

describe("listServers", () => {
  it("removes records of dead processes and warns above the server-count ceiling", () => {
    mkdirSync(dir(), { recursive: true });
    // A process that has certainly exited: spawn `true` and use its pid.
    const dead = spawnSync("true").pid as number;
    const script = join(home(), "fake-server3.js");
    writeFileSync(script, "x");
    const rec = (pid: number) => ({ pid, ppid: 1, parent: "test", started: "2026-09-05T00:00:00.000Z", heartbeat: "2026-09-05T00:00:00.000Z", version: "1", script, build: R.buildHashOf(script), cwd: "/", node: "v20" });
    writeFileSync(join(dir(), `${dead}.json`), JSON.stringify(rec(dead)));
    // Alive impostors: this process under several fake pids is not possible, so use live pids that exist: our own and our parent.
    writeFileSync(join(dir(), `${process.pid}.json`), JSON.stringify(rec(process.pid)));
    writeFileSync(join(dir(), `${process.ppid}.json`), JSON.stringify(rec(process.ppid)));
    writeFileSync(join(dir(), `1.json`), JSON.stringify(rec(1)));
    writeFileSync(join(dir(), `broken.json`), "{not json");
    const rep = R.listServers();
    expect(rep.removed).toBeGreaterThanOrEqual(2); // the dead pid and the broken file
    expect(rep.servers.some((s) => s.pid === dead)).toBe(false);
    expect(readdirSync(dir())).not.toContain(`${dead}.json`);
    expect(rep.servers.length).toBeGreaterThanOrEqual(3);
    if (rep.servers.length > R.SERVER_COUNT_WARN) expect(rep.warnings.some((w) => /servers run at once/.test(w))).toBe(true);
    const text = R.formatServers(rep, "/");
    expect(text).toMatch(/server\(s\) running/);
  });
});

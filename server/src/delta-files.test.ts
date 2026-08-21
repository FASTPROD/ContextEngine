import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listDeltaFiles, loadDeltaModulesFrom, deltaModuleName, LEGACY_FILES } from "./delta-files.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "ce-delta-"));
}

describe("delta-files", () => {
  it("serves exactly what the manifest lists, in order", () => {
    const d = dir();
    const files = ["agents.mjs", "rubric.js", "collectors.mjs", "search-adv.mjs", "firewall.mjs"];
    for (const f of files) writeFileSync(join(d, f), `// ${f}`);
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ version: "2.5.3", moduleFiles: files }));
    expect(listDeltaFiles(d)).toEqual({ files, source: "manifest" });
    const mods = loadDeltaModulesFrom(d);
    expect(mods.map((m) => m.name)).toEqual(["agents", "rubric", "collectors", "search-adv", "firewall"]);
    expect(mods[1].content).toBe("// rubric.js");
  });

  it("falls back to the legacy three without a manifest", () => {
    const d = dir();
    for (const f of LEGACY_FILES) writeFileSync(join(d, f), "x");
    expect(listDeltaFiles(d).source).toBe("legacy");
    expect(loadDeltaModulesFrom(d).map((m) => m.name)).toEqual(["agents", "collectors", "search-adv"]);
  });

  it("falls back on a corrupt manifest or one without moduleFiles", () => {
    const d = dir();
    writeFileSync(join(d, "manifest.json"), "{not json");
    expect(listDeltaFiles(d).source).toBe("legacy");
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ version: "1.0.0" }));
    expect(listDeltaFiles(d).source).toBe("legacy");
  });

  it("ignores path-like or non-string entries in moduleFiles", () => {
    const d = dir();
    writeFileSync(join(d, "agents.mjs"), "x");
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ moduleFiles: ["../etc/passwd", 42, "agents.mjs", "x.txt"] }));
    expect(listDeltaFiles(d).files).toEqual(["agents.mjs"]);
  });

  it("skips listed files missing on disk and returns [] for a missing dir", () => {
    const d = dir();
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ moduleFiles: ["agents.mjs", "ghost.mjs"] }));
    writeFileSync(join(d, "agents.mjs"), "x");
    expect(loadDeltaModulesFrom(d).map((m) => m.name)).toEqual(["agents"]);
    expect(loadDeltaModulesFrom(join(d, "nope"))).toEqual([]);
  });

  it("strips only .mjs/.js", () => {
    expect(deltaModuleName("search-adv.mjs")).toBe("search-adv");
    expect(deltaModuleName("rubric.js")).toBe("rubric");
  });
});

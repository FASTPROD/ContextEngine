// [LOCK] [AUTO-IMPORT-ONLY-MARKED-LEARNINGS]: what the importer takes from a doc, and what it
// leaves alone. Throwaway HOME; the real ~/.contextengine is never touched.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "ce-import-test-"));
const dir = join(home, ".contextengine");
const storePath = join(dir, "learnings.json");
let L: typeof import("./learnings.js");

const ORDINARY_DOC = [
  "# Project notes",
  "",
  "## Architecture (where things live)",
  "",
  "### Flow A — Forecast sync from Odoo to invoc.me",
  "export sales history, import the forecast back",
  "",
  "- **Design Language**: rounded cards, one accent colour",
  "| **Pattern with a long enough name** | example | description |",
  "",
  "## Deployment",
  "",
  "### Deploy with the script, never by hand: it snapshots first",
  "context line for the deploy rule",
  "- [git] Never run a bare git push from a repo you only touched one file in → it publishes every unpushed commit",
  "",
  "## Lessons learned",
  "",
  "### A red test is only evidence once you have read why it is red",
  "PLANK S77",
  "- **Restart the Flask backend after every model change**: stale to_dict() cache",
  "",
  "## Backlog",
  "",
  "### Lessons from the store wipe",
  "- **Never turn an unreadable store into an empty one**: copy it aside and throw",
  "### Just a TODO heading that is long enough",
  "",
].join("\n");

// Imported records only: the first load merges the 14 bundled defaults, which carry no source.
function rules(): string[] { return records().map((l: any) => l.rule); }
// The first load merges the 14 bundled defaults into a fresh store; they carry no source.
function records(): any[] { return JSON.parse(readFileSync(storePath, "utf-8")).learnings.filter((l: any) => l.source !== undefined); }
function byRule(rule: string): any { return JSON.parse(readFileSync(storePath, "utf-8")).learnings.find((l: any) => l.rule === rule); }
function reset(): void { mkdirSync(dir, { recursive: true }); writeFileSync(storePath, JSON.stringify({ version: 1, count: 0, learnings: [] })); }

beforeAll(async () => {
  process.env.HOME = home;
  process.env.CONTEXTENGINE_HOME = dir;
  L = await import("./learnings.js");
});
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

describe("strict import (the default, and the only mode of the auto-import)", () => {
  it("takes marked learnings and leaves ordinary headings, bold bullets and table rows alone", () => {
    reset();
    const p = join(home, "copilot-instructions.md");
    writeFileSync(p, ORDINARY_DOC);
    const r = L.importLearningsFromFile(p, "other", "Proj");
    const got = rules();
    // (1) the inline-category bullet, anywhere
    expect(got).toContain("Never run a bare git push from a repo you only touched one file in");
    // (3) everything under a heading that says learnings / lessons, H2 or H3
    expect(got).toContain("A red test is only evidence once you have read why it is red");
    expect(got).toContain("Restart the Flask backend after every model change");
    expect(got).toContain("Never turn an unreadable store into an empty one");
    // ordinary sections: the H3s, the bold bullet and the table row are not rules
    expect(got).not.toContain("Flow A — Forecast sync from Odoo to invoc.me");
    expect(got).not.toContain("Design Language");
    expect(got).not.toContain("Pattern with a long enough name");
    expect(got).not.toContain("Deploy with the script, never by hand: it snapshots first");
    expect(got).not.toContain("Just a TODO heading that is long enough");
    expect(got).not.toContain("Lessons from the store wipe"); // the scope-opening heading is not a rule
    expect(got.length).toBe(4);
    expect(r.imported).toBe(4);
    expect(r.ignored).toBe(5);
  });
  it("records the source file on every imported learning", () => {
    reset();
    const p = join(home, "copilot-instructions.md");
    writeFileSync(p, ORDINARY_DOC);
    L.importLearningsFromFile(p, "other", "Proj");
    expect(records().length).toBe(4);
    for (const l of records()) expect(l.source).toBe(p);
    const saved = L.saveLearning("testing", "an agent-saved rule carries no source field", "ctx");
    expect(saved.source).toBeUndefined();
  });
  it("reads a *LEARNINGS.md file in full, whatever its headings", () => {
    reset();
    const p = join(home, "AGENT-LEARNINGS.md");
    writeFileSync(p, ORDINARY_DOC.replace("# Project notes", "# Agent notes"));
    const r = L.importLearningsFromFile(p, "other", "Proj");
    expect(rules()).toContain("Flow A — Forecast sync from Odoo to invoc.me");
    expect(r.ignored).toBe(0);
    expect(r.imported).toBe(10); // the 9 candidates plus "Lessons from the store wipe" itself, as before 2.5.7
  });
  it("an H1 that says learnings puts the whole file in scope", () => {
    reset();
    const p = join(home, "notes.md");
    writeFileSync(p, ORDINARY_DOC.replace("# Project notes", "# Learnings of this repo"));
    expect(L.importLearningsFromFile(p, "other", "Proj").ignored).toBe(0);
  });
  it("the category of an imported rule comes from the text, not from the section title", () => {
    reset();
    const p = join(home, "notes.md");
    writeFileSync(p, ["# Notes", "## Gotchas", "### MongoDB aggregate $cond with $ne null does not catch missing fields", "use $exists false", ""].join("\n"));
    L.importLearningsFromFile(p, "other", "Proj");
    expect(byRule("MongoDB aggregate $cond with $ne null does not catch missing fields").category).toBe("database");
  });
  it("autoImportFromSources is strict and reports what it ignored", () => {
    reset();
    const p = join(home, "copilot-instructions.md");
    writeFileSync(p, ORDINARY_DOC);
    const r = L.autoImportFromSources([{ path: p, name: "Proj — copilot-instructions.md" }]);
    expect(r.imported).toBe(4);
    expect(r.ignored).toBe(5);
    expect(rules().length).toBe(4);
  });
});

describe("permissive import (opt-in, for a file the user chose)", () => {
  it("restores the old parser: every H3, bold bullet and table row", () => {
    reset();
    const p = join(home, "copilot-instructions.md");
    writeFileSync(p, ORDINARY_DOC);
    const r = L.importLearningsFromFile(p, "other", "Proj", { permissive: true });
    expect(rules()).toContain("Flow A — Forecast sync from Odoo to invoc.me");
    expect(rules()).toContain("Design Language");
    expect(r.ignored).toBe(0);
    expect(r.imported).toBe(10);
  });
});

describe("JSON import", () => {
  it("is explicit by construction and carries the source", () => {
    reset();
    const p = join(home, "rules.json");
    writeFileSync(p, JSON.stringify([{ category: "git", rule: "never rewrite a pushed branch", context: "" }]));
    expect(L.importLearningsFromFile(p).imported).toBe(1);
    expect(byRule("never rewrite a pushed branch").source).toBe(p);
  });
});

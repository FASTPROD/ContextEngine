import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runHeuristics, detect, type DriftSignal } from "../src/detector.js";
import type { AuditRecord } from "../src/audit.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, "__fixtures__", "audit-logs");
const REPO_ROOT = join(__dirname, "..");

function loadFixture(name: string): AuditRecord[] {
  const raw = readFileSync(join(FIXTURE_DIR, name), "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
}

// All fixtures are pinned to 2026-06-23 ~10:00Z onward. FIXTURE_NOW must sit
// within the tightest heuristic window (stuck = 2 min, silent_failure = 5 min)
// of the *latest* time-bounded event we want the test to see. 10:03:00Z is
// 90s after the last stuck-grep call and 60s after the last silent-failure
// error, so both windows are satisfied. The drift / no_insight / bloat /
// fabrication heuristics don't use `now`, so this fixed point works for them
// too (even when some fixture events are "in the future" relative to now —
// those heuristics ignore timestamps and look at content/grouping).
const FIXTURE_NOW = Date.parse("2026-06-23T10:03:00.000Z");

function findSignal(signals: DriftSignal[], kind: DriftSignal["kind"]) {
  return signals.find((s) => s.kind === kind);
}

describe("detector — heuristics catalog (12 fixtures)", () => {
  it("1. loop — 3× similar prompts in 5 min → warn", () => {
    const events = loadFixture("loop-3x-similar.ndjson");
    const signals = runHeuristics(events, { now: FIXTURE_NOW, cwd: REPO_ROOT });
    const loop = findSignal(signals, "loop");
    expect(loop).toBeDefined();
    expect(loop!.severity).toBe("warn");
    expect(loop!.payload.repetitions).toBeGreaterThanOrEqual(3);
  });

  it("2. loop — 3 different prompts → no signal", () => {
    const events = loadFixture("loop-3x-different.ndjson");
    const signals = runHeuristics(events, { now: FIXTURE_NOW, cwd: REPO_ROOT });
    expect(findSignal(signals, "loop")).toBeUndefined();
  });

  it("3. stuck — Grep 4× with identical args → warn", () => {
    const events = loadFixture("stuck-grep-x4.ndjson");
    const signals = runHeuristics(events, { now: FIXTURE_NOW, cwd: REPO_ROOT });
    const stuck = findSignal(signals, "stuck");
    expect(stuck).toBeDefined();
    expect(stuck!.severity).toBe("warn");
    expect(stuck!.payload.tool).toBe("Grep");
    expect(stuck!.payload.count).toBe(4);
  });

  it("4. stuck — same tool, different args → no signal", () => {
    const events = loadFixture("stuck-different-args.ndjson");
    const signals = runHeuristics(events, { now: FIXTURE_NOW, cwd: REPO_ROOT });
    expect(findSignal(signals, "stuck")).toBeUndefined();
  });

  it("5. context_bloat — ~97K tokens (4-char-to-token estimate), no save → warn", () => {
    const events = loadFixture("bloat-90k-no-save.ndjson");
    const signals = runHeuristics(events, { now: FIXTURE_NOW, cwd: REPO_ROOT });
    const bloat = findSignal(signals, "context_bloat");
    expect(bloat).toBeDefined();
    expect(bloat!.severity).toBe("warn");
    expect(bloat!.payload.approxTokens).toBeGreaterThan(80_000);
  });

  it("6. context_bloat — same tokens but with session.save → no signal", () => {
    const events = loadFixture("bloat-90k-with-save.ndjson");
    const signals = runHeuristics(events, { now: FIXTURE_NOW, cwd: REPO_ROOT });
    expect(findSignal(signals, "context_bloat")).toBeUndefined();
  });

  it("7. fabrication_suspect — assistant cites src/imaginary/nonexistent.ts:42 → critical", () => {
    const events = loadFixture("fabrication-phantom-file.ndjson");
    const signals = runHeuristics(events, { now: FIXTURE_NOW, cwd: REPO_ROOT });
    const fab = findSignal(signals, "fabrication_suspect");
    expect(fab).toBeDefined();
    expect(fab!.severity).toBe("critical");
    expect(fab!.payload.citedPath).toMatch(/nonexistent\.ts/);
  });

  it("8. fabrication_suspect — assistant cites src/audit.ts:1 (real file) → no signal", () => {
    const events = loadFixture("fabrication-real-file.ndjson");
    const signals = runHeuristics(events, { now: FIXTURE_NOW, cwd: REPO_ROOT });
    expect(findSignal(signals, "fabrication_suspect")).toBeUndefined();
  });

  it("9. drift — auth bug opening → cake recipes → info", () => {
    const events = loadFixture("drift-far-prompts.ndjson");
    const signals = runHeuristics(events, { now: FIXTURE_NOW, cwd: REPO_ROOT });
    const drift = findSignal(signals, "drift");
    expect(drift).toBeDefined();
    expect(drift!.severity).toBe("info");
    expect((drift!.payload.similarity as number)).toBeLessThan(0.1);
  });

  it("10. no_insight — 40 tool calls since last save_learning → info", () => {
    const events = loadFixture("no-insight-40-tools.ndjson");
    const signals = runHeuristics(events, { now: FIXTURE_NOW, cwd: REPO_ROOT });
    const ni = findSignal(signals, "no_insight");
    expect(ni).toBeDefined();
    expect(ni!.severity).toBe("info");
    expect(ni!.payload.toolCallCount).toBeGreaterThanOrEqual(30);
  });

  it("11. silent_failure — Bash 'git push' 5× with identical error → critical", () => {
    const events = loadFixture("silent-failure-5-errors.ndjson");
    const signals = runHeuristics(events, { now: FIXTURE_NOW, cwd: REPO_ROOT });
    const sf = findSignal(signals, "silent_failure");
    expect(sf).toBeDefined();
    expect(sf!.severity).toBe("critical");
    expect(sf!.payload.tool).toBe("Bash");
    expect(sf!.payload.count).toBe(5);
  });

  it("12. empty audit log → zero signals", () => {
    const events = loadFixture("empty.ndjson");
    const signals = runHeuristics(events, { now: FIXTURE_NOW, cwd: REPO_ROOT });
    expect(signals).toHaveLength(0);
  });
});

describe("detector — integration", () => {
  it("detect() with injected events runs the full pipeline", () => {
    const events = loadFixture("fabrication-phantom-file.ndjson");
    const signals = detect({ events, now: FIXTURE_NOW, cwd: REPO_ROOT });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.find((s) => s.kind === "fabrication_suspect")).toBeDefined();
  });

  it("evidence is bounded at 5 records per signal", () => {
    const events = loadFixture("silent-failure-5-errors.ndjson");
    const signals = runHeuristics(events, { now: FIXTURE_NOW, cwd: REPO_ROOT });
    for (const s of signals) {
      expect(s.evidence.length).toBeLessThanOrEqual(5);
    }
  });
});

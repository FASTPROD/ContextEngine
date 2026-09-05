// [LOCK] [LEARNINGS-LIST-SHOWS-CREATED]: the listing must show WHEN a learning was
// created, in UTC and in Europe/Zurich, and "--since today" must answer the question
// that two agents answered wrongly by hand on 2026-09-05 (a probe on a missing key
// returned a confident zero). Pure functions only: no store, no filesystem.
import { describe, it, expect } from "vitest";
import {
  formatLearnedAt,
  parseSince,
  filterSince,
  formatLearnings,
  type Learning,
} from "./learnings.js";

function mk(id: string, created: string, extra: Partial<Learning> = {}): Learning {
  return {
    id,
    rule: `rule ${id}`,
    category: "deployment",
    context: "",
    tags: [],
    created,
    updated: created,
    ...extra,
  } as Learning;
}

describe("formatLearnedAt", () => {
  it("prints the UTC instant and the Zurich wall time, summer offset", () => {
    expect(formatLearnedAt("2026-09-05T10:30:41.975Z")).toBe("2026-09-05 10:30Z (12:30 CEST)");
  });
  it("prints the winter offset", () => {
    expect(formatLearnedAt("2026-01-05T10:30:00Z")).toBe("2026-01-05 10:30Z (11:30 CET)");
  });
  it("says undated for a missing or unparseable value, never an empty string", () => {
    expect(formatLearnedAt(undefined)).toBe("undated");
    expect(formatLearnedAt("")).toBe("undated");
    expect(formatLearnedAt("not a date")).toBe("undated");
  });
});

describe("parseSince", () => {
  it("today is Zurich midnight as a UTC instant (22:00Z the evening before, in summer)", () => {
    const now = new Date("2026-09-05T10:00:00Z"); // 12:00 CEST
    expect(parseSince("today", now)?.toISOString()).toBe("2026-09-04T22:00:00.000Z");
  });
  it("today follows the Zurich calendar, not the UTC one, just before UTC midnight", () => {
    // 23:30Z on the 4th is already 01:30 CEST on the 5th in Zurich.
    const now = new Date("2026-09-04T23:30:00Z");
    expect(parseSince("today", now)?.toISOString()).toBe("2026-09-04T22:00:00.000Z");
  });
  it("winter: today is 23:00Z the evening before", () => {
    const now = new Date("2026-01-05T10:00:00Z");
    expect(parseSince("today", now)?.toISOString()).toBe("2026-01-04T23:00:00.000Z");
  });
  it("yesterday is one calendar day earlier", () => {
    const now = new Date("2026-09-05T10:00:00Z");
    expect(parseSince("yesterday", now)?.toISOString()).toBe("2026-09-03T22:00:00.000Z");
  });
  it("accepts an ISO date and an ISO instant", () => {
    expect(parseSince("2026-09-01")?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(parseSince("2026-09-01T08:15:00Z")?.toISOString()).toBe("2026-09-01T08:15:00.000Z");
  });
  it("returns null for anything else, so the caller errors instead of answering zero", () => {
    expect(parseSince("last week")).toBeNull();
    expect(parseSince("")).toBeNull();
    expect(parseSince("05/09/2026")).toBeNull();
    expect(parseSince("2026-13-45")).toBeNull();
  });
});

describe("filterSince", () => {
  const a = mk("a", "2026-09-04T21:59:59Z");
  const b = mk("b", "2026-09-04T22:00:00Z");
  const c = mk("c", "2026-09-05T10:43:41Z");
  const undated = mk("u", "" as string);
  it("keeps records at or after the boundary, oldest first, and drops undated ones", () => {
    const since = new Date("2026-09-04T22:00:00Z");
    expect(filterSince([c, undated, a, b], since).map((l) => l.id)).toEqual(["b", "c"]);
  });
});

describe("formatLearnings", () => {
  it("shows the created instant on every entry", () => {
    const out = formatLearnings([mk("x", "2026-09-05T10:30:41.975Z")]);
    expect(out).toContain("- **Learned:** 2026-09-05 10:30Z (12:30 CEST)");
  });
  it("with since, the header names the boundary and only newer entries are listed", () => {
    const since = parseSince("today", new Date("2026-09-05T10:00:00Z"))!;
    const out = formatLearnings(
      [mk("old", "2026-09-01T09:00:00Z"), mk("new", "2026-09-05T08:00:00Z")],
      { since, sinceSpec: "today" },
    );
    expect(out).toContain("since today = 2026-09-04 22:00Z (00:00 CEST)");
    expect(out).toContain("rule new");
    expect(out).not.toContain("rule old");
    expect(out).toContain("(1 rules since today");
  });
  it("an empty since-result names the boundary and the real date field, never a bare zero", () => {
    const since = parseSince("today", new Date("2026-09-05T10:00:00Z"))!;
    const out = formatLearnings([mk("old", "2026-09-01T09:00:00Z")], { since, sinceSpec: "today" });
    expect(out).toMatch(/^0 learnings since today = 2026-09-04 22:00Z \(00:00 CEST\)/);
    expect(out).toContain("`created`");
  });
  it("without since, an empty store keeps the original message", () => {
    expect(formatLearnings([])).toContain("No learnings stored yet");
  });
});

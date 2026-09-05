// [LOCK] [CATEGORY-BY-WHOLE-WORD-SCORE]: the category inference is measured, not trusted.
// tests/fixtures/category-labels.json is a hand-labelled spread sample of the real store
// (2026-09-05); the floors below are what the whole-word scorer reached that day. The old
// first-hit substring matcher scored 11% on agent-labelled records; a regression to that
// shape fails here.
import { describe, it, expect } from "vitest";
import { inferCategory, normalizeCategory, scoreCategories } from "./learnings.js";

// A generic labelled set, written for this test. The measurement on the real store lives outside
// the repo (scripts/measure-categories.mjs on ~/.contextengine/category-labels-20260905.json,
// that sample quotes other repos' internal notes). On 2026-09-05: 84 hand-labelled rules, legacy 25.0%,
// this scorer 50.0%; 189 agent-labelled store records, legacy 11.1%, this scorer 27.5%.
const LABELLED: Array<[string, string, string]> = [
  ["deployment", "Deploy with the script, never by hand: it snapshots before it writes", "a bad rsync target wiped a sibling site"],
  ["deployment", "Run the release from a clean tree; the preflight refuses uncommitted files", ""],
  ["devops", "The GitHub Actions workflow needs the secret in the repo settings, not in the yaml", ""],
  ["devops", "Rebuild the docker image after changing the Dockerfile base", "compose cached the old layer"],
  ["infrastructure", "Nginx must reload after every certificate renewal", "letsencrypt cron"],
  ["infrastructure", "fail2ban bans after 3 attempts on this VPS, use the jump host", ""],
  ["api", "The endpoint returns 200 with an empty body when the id is unknown", "clients must check the payload"],
  ["api", "Send the webhook signature header on every retry", ""],
  ["database", "Widen the column before the code writes longer values into it", "postgres migration order"],
  ["database", "The aggregate with $ne null does not catch missing fields", "mongodb, use $exists false"],
  ["frontend", "Clear derived state before the async refetch or the old rows flash", "react useEffect"],
  ["frontend", "The modal needs a visible contrast against the dark background", "css"],
  ["backend", "Restart the Flask backend after every model change", "stale to_dict() cache"],
  ["backend", "Laravel queue workers keep the old code until restarted", "artisan queue:restart"],
  ["security", "Never log the JWT, even at debug level", ""],
  ["security", "Rate-limit the login endpoint on day one", "passkeys and passwords alike"],
  ["performance", "The nested loop re-reads the whole file per row, cache it once", "latency went from 40 s to 1 s"],
  ["performance", "Batch the writes; one save per rule was the bottleneck", ""],
  ["testing", "A red test is only evidence once you have read why it is red", "vitest"],
  ["testing", "Run the e2e suite headless with the real accept button, not a spoofed cookie", ""],
  ["debugging", "Read the stack trace before theorising; the crash names the file", ""],
  ["debugging", "A silent failure under pipefail leaves no error output at all", "diagnose with set -x"],
  ["tooling", "Run tsc before every commit; the editor hides type errors in untouched files", ""],
  ["tooling", "The shell script must be benched under zsh and bash; grep -E ignores \\xNN", "regex quoting"],
  ["git", "Never run a bare git push from a repo you only touched one file in", "it publishes every unpushed commit"],
  ["git", "Rebase the branch before the merge so the hook sees one commit", ""],
  ["dependencies", "Pin the npm package version; the upgrade broke the peer dependency", "package.json"],
  ["dependencies", "pip installs the wrong build without requirements.txt pinned", ""],
  ["architecture", "Absence must never be encoded as a decision; emit unknown", "a guard that cannot check its condition"],
  ["architecture", "One single source of truth for the constants, the other copies drift", "refactor into a module"],
  ["data", "The CSV dump is a world file, 4.5M rows; parse only the country slice", "dataset"],
  ["data", "The categoriser tie-break is what fails, not the description", "taxonomy labels"],
  ["mobile", "Android needs FlutterFragmentActivity, not FlutterActivity", "MainActivity.kt"],
  ["mobile", "The App Store Connect icon comes from the attached build, not a separate upload", "ios"],
  ["other", "Talk short, plain words, get to the point", "owner instruction"],
  ["other", "Read the session doc before answering a question about the previous day", ""],
];

describe("inferCategory: whole words only", () => {
  it("does not read 'expose' as expo, 'access' as css, 'restart' as rest, 'build' as ui, 'login' as log", () => {
    expect(inferCategory("Scoring internals are trade secrets", "don't expose point values or anti-gaming methods")).not.toBe("mobile");
    expect(inferCategory("Grant access to the shared folder before the run", "")).not.toBe("frontend");
    expect(inferCategory("Restart the worker after every config change", "")).not.toBe("api");
    expect(inferCategory("Run the build twice when the first one is cold", "")).not.toBe("frontend");
    expect(inferCategory("The login form posts twice on slow networks", "")).not.toBe("debugging");
  });
  it("scores every match instead of stopping at the first", () => {
    // 'deploy' appears once; the text is about a database migration and says so three times.
    const cat = inferCategory("Run the migration before the deploy touches the postgres schema", "the migration widens a column");
    expect(cat).toBe("database");
  });
  it("weighs the rule text over the context", () => {
    expect(inferCategory("Never run a bare git push from a repo you only touched one file in", "the deploy script had already published it")).toBe("git");
  });
  it("returns other when nothing matches, never a guess", () => {
    expect(inferCategory("Talk short, plain words, get to the point", "owner instruction")).toBe("other");
    expect(scoreCategories("Talk short, plain words, get to the point", "").size).toBe(0);
  });
  it("keeps the documented examples", () => {
    expect(inferCategory("Always restart Flask backend after model changes", "stale to_dict() cache")).toBe("backend");
    expect(inferCategory("Expo --port flag only controls Metro, NOT webpack dev server", "")).toBe("mobile");
    expect(inferCategory("MongoDB collection is products2, not products", "OFF data lives in products2")).toBe("database");
  });
});

describe("inferCategory: accuracy floor on the generic labelled set", () => {
  it(`agrees with the label on at least 80% of the ${LABELLED.length} rules`, () => {
    const misses: string[] = [];
    for (const [label, rule, context] of LABELLED) {
      const got = inferCategory(rule, context);
      if (got !== label) misses.push(`${label} -> ${got} | ${rule}`);
    }
    expect(1 - misses.length / LABELLED.length, misses.join("\n")).toBeGreaterThanOrEqual(0.8);
  });
});

describe("normalizeCategory: headings", () => {
  it("maps a category-named heading directly", () => {
    expect(normalizeCategory("deployment")).toBe("deployment");
    expect(normalizeCategory("## Testing".replace(/^##\s+/, ""))).toBe("testing");
    expect(normalizeCategory("Frontend")).toBe("frontend");
  });
  it("does not read 'Apple App Store' as api on a prefix, and a learnings heading is not a category", () => {
    expect(normalizeCategory("Apple App Store")).toBe("mobile");
    expect(normalizeCategory("Lessons learned")).toBe("other");
    expect(normalizeCategory("Gotchas")).toBe("other");
  });
  it("falls back to the same scorer as rules", () => {
    expect(normalizeCategory("Security Hardening (Feb 16, 2026)")).toBe("security");
    expect(normalizeCategory("Git Workflow")).toBe("git");
  });
});

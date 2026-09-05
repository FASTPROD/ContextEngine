#!/usr/bin/env node
// Delete a list of learnings by id, from a plan file, under the store lock, with a backup first.
// Dry run by default: prints the counts and the first records, writes nothing.
//
//   node scripts/learnings-prune.mjs <plan.json>            # dry run
//   node scripts/learnings-prune.mjs <plan.json> --apply    # deletes, after a backup copy
//
// The plan is { ids: [...] } (Session 25 wrote ~/.contextengine/learnings-cleanup-plan-20260905.json
// from a replay of the importer over every doc source). A plan that removes more than half the
// store trips [STORE-NEVER-STARTS-FRESH-OVER-DATA]'s shrink guard on purpose; --apply sets
// CONTEXTENGINE_ALLOW_SHRINK=1 for this one process, after the backup, and says so.
import { readFileSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const planPath = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
if (!planPath) {
  console.error("usage: node scripts/learnings-prune.mjs <plan.json> [--apply]");
  process.exit(2);
}
const plan = JSON.parse(readFileSync(resolve(planPath), "utf-8"));
const ids = new Set(plan.ids || []);
if (ids.size === 0) { console.error("plan has no ids"); process.exit(2); }

const home = process.env.CONTEXTENGINE_HOME || join(homedir(), ".contextengine");
const storePath = join(home, "learnings.json");
const store = JSON.parse(readFileSync(storePath, "utf-8"));
const present = store.learnings.filter((l) => ids.has(l.id));
const missing = ids.size - present.length;
const remaining = store.learnings.length - present.length;
const byCat = {};
for (const l of present) byCat[l.category] = (byCat[l.category] || 0) + 1;

console.log(`[learnings-prune] store ${storePath}: ${store.learnings.length} records`);
console.log(`[learnings-prune] plan ${planPath}: ${ids.size} ids, ${present.length} present, ${missing} already gone`);
console.log(`[learnings-prune] would delete ${present.length}, keep ${remaining}`);
console.log(`[learnings-prune] by category: ${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
for (const l of present.slice(0, 5)) console.log(`   ${l.id} [${l.category}] ${l.rule.slice(0, 90)}`);
if (!apply) {
  console.log("[learnings-prune] dry run, nothing written. Re-run with --apply to delete.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${storePath}.pre-prune-${stamp}`;
copyFileSync(storePath, backup);
console.log(`[learnings-prune] backup: ${backup}`);
if (present.length > store.learnings.length / 2) {
  console.log(`[learnings-prune] deleting more than half the store: CONTEXTENGINE_ALLOW_SHRINK=1 for this process only`);
  process.env.CONTEXTENGINE_ALLOW_SHRINK = "1";
}
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "learnings.js");
if (!existsSync(dist)) { console.error(`[learnings-prune] ${dist} missing: run npm run build`); process.exit(2); }
const L = await import(dist);
let deleted = 0;
L.withStoreBatch(() => { for (const l of present) if (L.deleteLearning(l.id)) deleted++; });
const after = JSON.parse(readFileSync(storePath, "utf-8")).learnings.length;
console.log(`[learnings-prune] deleted ${deleted}; store now ${after} records (expected ${remaining})`);
if (after !== remaining) { console.error("[learnings-prune] COUNT MISMATCH, check the backup"); process.exit(1); }

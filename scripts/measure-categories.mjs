#!/usr/bin/env node
// Measure inferCategory() against a labelled sample: {items:[{rule, context, label}]}, label
// "noise" excluded. Prints accuracy and the confusions, for the current scorer and for the
// pre-2026-09-05 first-hit substring matcher (kept here verbatim as the baseline).
//
//   node scripts/measure-categories.mjs ~/.contextengine/category-labels-20260905.json [-v]
//
// The sample stays outside the repo on purpose: it quotes other repos' internal notes.
import { readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/measure-categories.mjs <labels.json> [-v]"); process.exit(2); }
const verbose = process.argv.includes("-v");
const items = JSON.parse(readFileSync(resolve(file), "utf-8")).items.filter((i) => i.label && i.label !== "noise");
const L = await import(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "learnings.js"));

// Baseline: the matcher as it stood before [CATEGORY-BY-WHOLE-WORD-SCORE]. First unanchored
// substring hit wins, in this order.
const LEGACY = [
  ["deploy", "deployment"],
  ["rsync", "deployment"],
  ["publish", "deployment"],
  ["release", "deployment"],
  ["ci/cd", "devops"],
  ["ci cd", "devops"],
  ["pipeline", "devops"],
  ["github actions", "devops"],
  ["docker", "devops"],
  ["nginx", "infrastructure"],
  ["ssl", "infrastructure"],
  ["server", "infrastructure"],
  ["pm2", "infrastructure"],
  ["vps", "infrastructure"],
  ["api", "api"],
  ["endpoint", "api"],
  ["rest", "api"],
  ["graphql", "api"],
  ["webhook", "api"],
  ["sql", "database"],
  ["sqlite", "database"],
  ["mysql", "database"],
  ["postgres", "database"],
  ["query", "database"],
  ["migration", "database"],
  ["react", "frontend"],
  ["vue", "frontend"],
  ["css", "frontend"],
  ["html", "frontend"],
  ["dom", "frontend"],
  ["component", "frontend"],
  ["ui", "frontend"],
  ["express", "backend"],
  ["node", "backend"],
  ["flask", "backend"],
  ["middleware", "backend"],
  ["auth", "security"],
  ["cors", "security"],
  ["xss", "security"],
  ["csrf", "security"],
  ["helmet", "security"],
  ["encrypt", "security"],
  ["password", "security"],
  ["test", "testing"],
  ["vitest", "testing"],
  ["jest", "testing"],
  ["spec", "testing"],
  ["assert", "testing"],
  ["debug", "debugging"],
  ["error", "debugging"],
  ["stack trace", "debugging"],
  ["breakpoint", "debugging"],
  ["log", "debugging"],
  ["npm", "dependencies"],
  ["package", "dependencies"],
  ["yarn", "dependencies"],
  ["pnpm", "dependencies"],
  ["version", "dependencies"],
  ["git", "git"],
  ["commit", "git"],
  ["branch", "git"],
  ["merge", "git"],
  ["rebase", "git"],
  ["perf", "performance"],
  ["latency", "performance"],
  ["cache", "performance"],
  ["optimize", "performance"],
  ["eslint", "tooling"],
  ["lint", "tooling"],
  ["prettier", "tooling"],
  ["vscode", "tooling"],
  ["editor", "tooling"],
  ["pattern", "architecture"],
  ["refactor", "architecture"],
  ["module", "architecture"],
  ["design", "architecture"],
  ["ios", "mobile"],
  ["android", "mobile"],
  ["expo", "mobile"],
  ["react native", "mobile"],
];
function legacy(rule, context) {
  const text = `${rule} ${context}`.toLowerCase();
  for (const [k, cat] of LEGACY) if (text.includes(k)) return cat;
  return "other";
}

function run(name, fn) {
  let hit = 0; const conf = {}; const misses = [];
  for (const i of items) { const got = fn(i.rule, i.context || ""); if (got === i.label) hit++; else { const k = `${i.label}->${got}`; conf[k] = (conf[k] || 0) + 1; misses.push({ ...i, got }); } }
  console.log(`${name}: ${hit}/${items.length} = ${(100 * hit / items.length).toFixed(1)}%`);
  console.log(`  confusions: ${Object.entries(conf).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (verbose) for (const m of misses) console.log(`   ${m.label} -> ${m.got} | ${m.rule.slice(0, 90)}`);
}
run("legacy first-hit substring matcher", legacy);
run("current whole-word scorer         ", L.inferCategory);

#!/usr/bin/env node
/**
 * Rewrites dist/rubric.js so the published package carries no readable scoring thresholds.
 *
 * 🔒 LOCKED [RUBRIC-OBFUSCATION] — 2026-08-14
 * ⛔ NEVER present this as security. It is a speed bump against casual score-gaming, nothing more.
 * WHY: the thresholds decide what earns what ("50 lines = the full 10 points"), so shipping them
 *      readable invites padding a file to a number instead of writing the content. But the
 *      comparison logic still ships in dist/agents.js, the checked filenames are real paths, and
 *      2.1.3 remains on npm forever as a plaintext reference — anyone determined recovers these
 *      values in under an hour. The real protections are the activation gate and BSL-1.1.
 * FIX: encode the table at build time, decode at module load. Values are byte-identical, so the
 *      [SCORE-CANARY] guards this step: if decoding ever drifts, the canary blocks every write.
 *
 * Runs from `prepublishOnly` — local `npm run build` keeps dist readable for debugging, and the
 * tests import from src/ anyway, so this never changes what is under test.
 *
 * Idempotent: re-running on an already-encoded file is a no-op.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = join(__dirname, "..", "dist", "rubric.js");
const dtsTarget = join(__dirname, "..", "dist", "rubric.d.ts");
const MARKER = "/*__RUBRIC_ENCODED__*/";
const KEY = "ce-rubric-v1"; // not a secret — obfuscation, not encryption. See the LOCK above.

if (!existsSync(target)) {
  console.error(`✗ obfuscate-rubric: ${target} not found — run \`npm run build\` first`);
  process.exit(1);
}

const source = readFileSync(target, "utf-8");

if (source.includes(MARKER)) {
  console.error("• obfuscate-rubric: already encoded, nothing to do");
  process.exit(0);
}

// Pull the literal table out of the compiled module by executing it. Importing is safer than
// regex-parsing the emitted JS, which changes shape with every tsc target bump.
const { RUBRIC } = await import(`file://${target}`);

if (!RUBRIC || typeof RUBRIC !== "object" || Object.keys(RUBRIC).length === 0) {
  console.error("✗ obfuscate-rubric: RUBRIC export missing or empty — refusing to write a stub");
  process.exit(1);
}

const xor = (text, key) =>
  Buffer.from(text.split("").map((ch, i) => ch.charCodeAt(0) ^ key.charCodeAt(i % key.length)).map(n => String.fromCharCode(n)).join(""), "binary");

const encoded = xor(JSON.stringify(RUBRIC), KEY).toString("base64");

// An unexplained encoded blob invites the wrong suspicion. Anyone opening this file in the
// published package should learn, in place, exactly what is hidden (proprietary threshold VALUES)
// and what is not (any behaviour, network call, or data flow) — see README "What's obfuscated,
// and what isn't". Transparency about the mechanism is what makes withholding the values fair.
const out = `${MARKER}
/*
 * Scoring thresholds — encoded deliberately.
 *
 * WHAT THIS IS: the point values and cut-offs behind the AI-readiness score. They are commercial
 * IP under BSL-1.1, and publishing them exactly makes the score trivial to game by padding files
 * to hit a number instead of doing the work.
 *
 * WHAT THIS IS NOT: hidden behaviour. This file contains numbers and nothing else — no network
 * calls, no file access, no data collection. Every code path in this package ships readable,
 * including the two (and only two) network calls the tool ever makes: licence activation and the
 * daily heartbeat, both in activation.js. Full source: https://github.com/FASTPROD/ContextEngine
 *
 * Your project data never leaves your machine. See the Privacy section of the README, and verify
 * it in the source rather than taking our word for it.
 */
const _k = ${JSON.stringify(KEY)};
const _d = (b) => {
  const raw = Buffer.from(b, "base64").toString("binary");
  let s = "";
  for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw.charCodeAt(i) ^ _k.charCodeAt(i % _k.length));
  return JSON.parse(s);
};
export const RUBRIC = Object.freeze(_d(${JSON.stringify(encoded)}));
`;

// Verify the round trip BEFORE overwriting — a broken rubric silently changes every score.
const check = (() => {
  const raw = Buffer.from(encoded, "base64").toString("binary");
  let s = "";
  for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length));
  return JSON.parse(s);
})();

for (const [k, v] of Object.entries(RUBRIC)) {
  if (check[k] !== v) {
    console.error(`✗ obfuscate-rubric: round trip changed ${k}: ${v} → ${check[k]}. Refusing to write.`);
    process.exit(1);
  }
}

writeFileSync(target, out, "utf-8");

// The .d.ts is the other half of the job and was missed in 2.3.0: tsc emits the full interface
// INCLUDING the doc comments, so the published package carried a plain-language glossary
// ("copilot-instructions.md line counts for the 10 / 6 point tiers") right next to the encoded
// values. Encoding the data and shipping the legend protects nothing. Replace it with a minimal
// declaration that still type-checks for any consumer.
if (existsSync(dtsTarget)) {
  writeFileSync(
    dtsTarget,
    `${MARKER}\nexport interface Rubric { [key: string]: number }\nexport declare const RUBRIC: Readonly<Rubric>;\n`,
    "utf-8"
  );
}

console.error(
  `✓ obfuscate-rubric: ${Object.keys(RUBRIC).length} thresholds encoded in dist/rubric.js` +
    (existsSync(dtsTarget) ? " (+ dist/rubric.d.ts stripped)" : "")
);

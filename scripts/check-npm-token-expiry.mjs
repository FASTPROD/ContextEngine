#!/usr/bin/env node
/**
 * Pre-publish guard: warns or blocks when the npm publish token is near
 * (or past) its expiry. Runs from `prepublishOnly` in package.json so it
 * fires before every `npm publish`.
 *
 * Source of truth: ./.npm-token-meta.json — update its `expiresAt` field
 * whenever the token is rotated. The token VALUE itself stays in ~/.npmrc
 * + .copilot-credentials.md; this file holds metadata only.
 *
 * Exit codes:
 *   0 — green (>14 days) or yellow (<=14 days) — publish allowed
 *   1 — red (<=0 days, past expiry) — publish blocked
 *   2 — meta file missing or unreadable — publish blocked (refuse to
 *       publish if we don't know token state)
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const metaPath = join(__dirname, "..", ".npm-token-meta.json");

// ANSI colors — work on most terminals; no-op when piped (no TTY).
const isTTY = process.stderr.isTTY;
const c = (code, s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = (s) => c("31;1", s);
const yellow = (s) => c("33;1", s);
const green = (s) => c("32;1", s);
const dim = (s) => c("2", s);

function fail(code, msg) {
  process.stderr.write(red("✗ npm token check: ") + msg + "\n");
  process.exit(code);
}

if (!existsSync(metaPath)) {
  fail(2, `.npm-token-meta.json not found at ${metaPath}`);
}

let meta;
try {
  meta = JSON.parse(readFileSync(metaPath, "utf8"));
} catch (err) {
  fail(2, `failed to parse .npm-token-meta.json: ${err.message}`);
}

const { tokenName, expiresAt, warnDaysBefore = 14, blockDaysBefore = 0, rotationDocPath } = meta;

if (!expiresAt) {
  fail(2, "`expiresAt` is missing from .npm-token-meta.json");
}

const now = new Date();
const expiry = new Date(expiresAt + "T00:00:00Z");
if (Number.isNaN(expiry.getTime())) {
  fail(2, `invalid expiresAt date "${expiresAt}" — expected YYYY-MM-DD`);
}
const msPerDay = 24 * 60 * 60 * 1000;
const daysLeft = Math.ceil((expiry.getTime() - now.getTime()) / msPerDay);

const banner = (color, title, body) => {
  const line = "─".repeat(60);
  process.stderr.write(
    "\n" +
    color(line) + "\n" +
    color("  " + title) + "\n" +
    "  " + body + "\n" +
    "  " + dim(`token : ${tokenName}`) + "\n" +
    "  " + dim(`expiry: ${expiresAt}  (${daysLeft >= 0 ? daysLeft + "d left" : Math.abs(daysLeft) + "d PAST"})`) + "\n" +
    "  " + dim(`rotate: see ${rotationDocPath || ".copilot-credentials.md"}`) + "\n" +
    color(line) + "\n\n"
  );
};

if (daysLeft <= blockDaysBefore) {
  banner(
    red,
    "✗ npm publish token has expired — refusing to publish.",
    "Rotate the token before retrying."
  );
  process.exit(1);
}

if (daysLeft <= warnDaysBefore) {
  banner(
    yellow,
    "⚠ npm publish token expires soon.",
    `Rotate within the next ${daysLeft} day(s) to avoid a broken publish.`
  );
  // warn-only — exit 0 so publish continues
  process.exit(0);
}

// Green: still healthy. One quiet line, no banner.
process.stderr.write(
  green("✓ ") + dim(`npm token ok — ${daysLeft} days until expiry (${tokenName})`) + "\n"
);
process.exit(0);

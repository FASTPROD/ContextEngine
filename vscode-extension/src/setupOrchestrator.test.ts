/**
 * Tests for setupOrchestrator — source-grep regression tests.
 *
 * The B2 audit verifier flagged "no unit tests for setupOrchestrator.ts"
 * as a non-blocking gap. Full behavioural tests (runSetup / runUninstall)
 * would need a vscode-mock harness larger than reasonable for the current
 * test surface; that's deferred to Sprint-5.
 *
 * This file partially closes the gap by asserting invariants on the source
 * that PROTECT against silent regressions of the B2 design decisions:
 *   - HEALTH_URL stays loopback-bound
 *   - NODEJS_DOWNLOAD_URL points at nodejs.org
 *   - vscode.window.withProgress is the orchestration primitive (not raw terminal)
 *   - terminal.sendText is NEVER reintroduced
 *   - The three install steps appear in source order
 *   - looksAlreadyInstalled keeps its idempotency phrase set
 *
 * Run:
 *   npx tsc -p ./
 *   node --test dist/setupOrchestrator.test.js
 *
 * tsconfig excludes `**\/*.test.ts` from production compile so this file
 * is checked-in source the team can run on demand without bloating the
 * shipped extension.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Resolve the source file relative to the compiled test location
// (out lives at dist/setupOrchestrator.test.js, source at src/setupOrchestrator.ts).
function readOrchSource(): string {
  // From dist/setupOrchestrator.test.js, go up to vscode-extension/, then into src/.
  const here = __dirname;
  const tryPaths = [
    join(here, "..", "src", "setupOrchestrator.ts"),
    join(here, "..", "..", "src", "setupOrchestrator.ts"),
    join(here, "setupOrchestrator.ts"),
  ];
  for (const p of tryPaths) {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `Could not locate setupOrchestrator.ts from ${here}; tried: ${tryPaths.join(", ")}`,
  );
}

test("HEALTH_URL is pinned to 127.0.0.1 loopback (LOCKED — any other host leaves the user's machine)", () => {
  const src = readOrchSource();
  assert.match(
    src,
    /HEALTH_URL\s*=\s*["']http:\/\/127\.0\.0\.1:7842\/health["']/,
    "HEALTH_URL must remain http://127.0.0.1:7842/health — phishing-resistant + privacy-preserving",
  );
});

test("NODEJS_DOWNLOAD_URL points at nodejs.org (LOCKED — phishing-resistant default)", () => {
  const src = readOrchSource();
  assert.match(
    src,
    /NODEJS_DOWNLOAD_URL\s*=\s*["']https:\/\/nodejs\.org/,
    "NODEJS_DOWNLOAD_URL must point at nodejs.org",
  );
});

test("orchestration uses vscode.window.withProgress (B2 design requirement)", () => {
  const src = readOrchSource();
  assert.match(
    src,
    /vscode\.window\.withProgress/,
    "B2 audit demanded withProgress orchestration",
  );
});

test("terminal.sendText is NEVER reintroduced (was the original B2 root cause)", () => {
  const src = readOrchSource();
  assert.ok(
    !/terminal\.sendText\(/.test(src),
    "B2 audit forbade terminal.sendText — the old & &-chain UX is the regression we MUST NOT walk back into",
  );
});

test("three install steps appear in canonical source order", () => {
  const src = readOrchSource();
  // Search for the canonical "Step 1/3" / "Step 2/3" / "Step 3/3" markers
  // — those are unambiguous step labels that appear ONLY at the actual
  // execution sites. Naive .indexOf("install-autostart") would match a
  // comment near the top of the file and skew the ordering check.
  const step1 = src.indexOf("Step 1/3");
  const step2 = src.indexOf("Step 2/3");
  const step3 = src.indexOf("Step 3/3");
  assert.ok(step1 > 0, "Step 1/3 marker must appear in source");
  assert.ok(step2 > step1, "Step 2/3 marker must follow Step 1/3");
  assert.ok(step3 > step2, "Step 3/3 marker must follow Step 2/3");
});

test("looksAlreadyInstalled keeps its idempotency phrase set", () => {
  const src = readOrchSource();
  // Phrases the heuristic sniffs to recognize "already installed" exit
  // codes — each is the canonical wording for one of the upstream CLI
  // failure messages. If any goes stale, the orchestrator will scare the
  // user with a spurious "install failed" notification.
  const requiredPhrases = [
    "already exists",
    "already installed",
    "already wired",
    "no changes needed",
    "plist already",
  ];
  for (const p of requiredPhrases) {
    assert.match(
      src,
      new RegExp(p),
      `idempotency heuristic must continue to recognize "${p}"`,
    );
  }
});

test("openExternal is used for the nodejs.org download (no shell-out)", () => {
  const src = readOrchSource();
  assert.match(
    src,
    /vscode\.env\.openExternal/,
    "Missing-Node modal must use openExternal to launch the browser — never shell-exec a curl/wget download (security)",
  );
});

test("uninstall is registered as a public export", () => {
  const src = readOrchSource();
  assert.match(
    src,
    /export\s+async\s+function\s+runUninstall/,
    "Uninstall path must be public so extension.ts can register the contextengine.uninstall command",
  );
});

test("module imports child_process for execFile (not exec which is shell-vulnerable)", () => {
  const src = readOrchSource();
  // We want execFile, NOT exec — exec runs through a shell and is an
  // injection vector if any input is user-controlled. The orchestrator
  // should be uniformly execFile.
  assert.match(
    src,
    /import\s+\*\s+as\s+cp\s+from\s+["']child_process["']/,
    "Must import the child_process module",
  );
  // Spot-check: somewhere in the file, cp.execFile must be referenced.
  assert.match(src, /cp\.execFile/, "Must use cp.execFile (not cp.exec)");
  // And cp.exec(...) — the bare exec form — must not appear.
  // (Match `cp.exec(` but NOT `cp.execFile(` — use negative lookahead.)
  assert.ok(
    !/cp\.exec\((?!File)/.test(src),
    "Must NOT use cp.exec() — shell-vulnerable. Use cp.execFile() exclusively.",
  );
});

test("HEALTH_TIMEOUT_MS is conservative (≤ 2 seconds)", () => {
  const src = readOrchSource();
  const m = src.match(/HEALTH_TIMEOUT_MS\s*=\s*(\d[\d_]*)/);
  assert.ok(m, "HEALTH_TIMEOUT_MS must be defined");
  const ms = parseInt(m![1].replace(/_/g, ""), 10);
  assert.ok(
    ms <= 2000,
    `HEALTH_TIMEOUT_MS = ${ms}ms is too long — health probe should fail fast so the install-already-running short-circuit doesn't block the user`,
  );
});

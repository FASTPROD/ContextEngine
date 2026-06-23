#!/usr/bin/env node
// 🔒 LOCKED [MANIFEST-VERSION-SYNC] — 2026-06-23
// ⛔ NEVER let chrome-extension/src/manifest.json drift from package.json's
//    version. Chrome reads ONLY the manifest version for the extension card,
//    so a mismatch makes "did the user reload after the bump?" undebuggable.
// WHY: The 0.1.3 dedupe-fix release shipped with manifest at 0.1.0 because
//    these are separate files and `npm version` only touches package.json.
//    The user saw the same "0.1.0" on chrome://extensions and assumed the
//    reload didn't take effect; spent time chasing a phantom bug.
// FIX: This script is invoked from `npm run build` after the `tsc` step.
//    To add another versioned manifest (e.g. a second browser target),
//    extend the MANIFEST_FILES array.

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const MANIFEST_FILES = [join(ROOT, "src", "manifest.json")];

for (const mf of MANIFEST_FILES) {
  const manifest = JSON.parse(readFileSync(mf, "utf-8"));
  if (manifest.version !== pkg.version) {
    manifest.version = pkg.version;
    writeFileSync(mf, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`✓ Synced ${mf} version → ${pkg.version}`);
  }
}

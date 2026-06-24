#!/usr/bin/env node
// 🔒 LOCKED [CONTENT-SCRIPT-BUNDLE] — 2026-06-23
// ⛔ NEVER remove this script in favor of plain tsc output for content scripts.
//    Chrome MV3 content scripts DO NOT support ES module `import` statements
//    at the top level. Background service workers do (via "type": "module" in
//    manifest) but content_scripts have no equivalent. A tsc-only build
//    produces dist/content/claude.js with imports; Chrome silently fails to
//    load the script and the entire capture surface goes dark.
// ⛔ NEVER add `"type": "module"` to a content_scripts entry — it's not a
//    valid MV3 manifest field for content_scripts (only background). Chrome
//    rejects the whole manifest.
// WHY: The Sept 2026 bug report from the user surfaced exactly this — the
//    Options page loaded fine (popup/options run as classic page scripts so
//    inline imports work via `<script type="module">`), but the content
//    script threw at line 13 (`import { ... } from "./shared/..."`) before
//    any capture code could attach DOM listeners.
// FIX: Add new content scripts to CONTENT_SCRIPTS below + add a content_scripts
//    entry in src/manifest.json. The bundler will produce a self-contained
//    IIFE per entry — no external file references at runtime.

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// 🔒 LOCKED [SELF-CONTAINED-ESBUILD] — 2026-06-24
// ⛔ NEVER reach into ../package.json or ../node_modules to resolve esbuild.
// WHY: The original lookup (createRequire rooted at ../package.json) silently
//    broke fresh clones — the parent package.json did NOT list esbuild as a
//    direct devDep (it only existed transitively via vitest), so users who
//    skipped `npm install` in the parent got `Cannot find module 'esbuild'`
//    the moment they ran `npm run build` in chrome-extension. Audit blocker B1.
// FIX: esbuild is now a direct devDependency of chrome-extension/package.json.
//    Resolve from this script's own package context so the extension builds
//    standalone with only `cd chrome-extension && npm install && npm run build`.
const requireFromHere = createRequire(import.meta.url);
const esbuildPath = requireFromHere.resolve("esbuild");
const { build } = await import(esbuildPath);

const CONTENT_SCRIPTS = ["claude", "chatgpt"];

const results = await Promise.all(
  CONTENT_SCRIPTS.map((name) =>
    build({
      entryPoints: [join(ROOT, "src", "content", `${name}.ts`)],
      outfile: join(ROOT, "dist", "content", `${name}.js`),
      bundle: true,
      format: "iife", // wrap in IIFE — no ES module syntax in output
      target: "chrome110", // matches minimum_chrome_version in manifest.json
      platform: "browser",
      sourcemap: false,
      legalComments: "none",
      minify: false, // keep readable for users who Inspect the unpacked source
      logLevel: "warning",
      // The content scripts call chrome.* APIs that are globals at runtime —
      // mark them external so esbuild doesn't try to resolve them as modules.
      external: ["chrome"],
    }),
  ),
);

console.log(`✓ Bundled ${CONTENT_SCRIPTS.length} content scripts as IIFE (MV3-safe)`);
for (let i = 0; i < CONTENT_SCRIPTS.length; i++) {
  const name = CONTENT_SCRIPTS[i];
  const warnings = results[i].warnings.length;
  console.log(`  dist/content/${name}.js  ${warnings > 0 ? `(${warnings} warnings)` : ""}`);
}

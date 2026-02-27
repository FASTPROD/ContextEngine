#!/usr/bin/env node
/**
 * Obfuscate firewall.js in dist/ to protect IP (thresholds, scoring, escalation).
 * Run after `tsc` build step.
 *
 * Same terser config as gen-delta.ts — mangle toplevel, 2-pass compress,
 * strip comments, keep property names for exports.
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { minify } from "terser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");

const OBFUSCATE_FILES = ["firewall.js"];

async function main() {
  for (const file of OBFUSCATE_FILES) {
    const path = join(DIST, file);
    const original = readFileSync(path, "utf-8");
    const originalSize = Buffer.byteLength(original);

    const result = await minify(original, {
      mangle: {
        toplevel: true,
        properties: false, // keep exported names
      },
      compress: {
        passes: 2,
        drop_console: false,
        dead_code: true,
        collapse_vars: true,
        reduce_vars: true,
      },
      format: {
        comments: false,
        beautify: false,
      },
      module: true,
      sourceMap: false,
    });

    if (result.code) {
      writeFileSync(path, result.code);
      const finalSize = Buffer.byteLength(result.code);
      const reduction = Math.round((1 - finalSize / originalSize) * 100);
      console.log(`  ✅ ${file}: ${(originalSize / 1024).toFixed(1)}KB → ${(finalSize / 1024).toFixed(1)}KB (${reduction}% smaller)`);
    }
  }
}

main().catch((err) => {
  console.error("Obfuscation failed:", err);
  process.exit(1);
});

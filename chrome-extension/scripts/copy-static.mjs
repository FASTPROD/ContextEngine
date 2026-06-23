#!/usr/bin/env node
// Copies manifest.json + HTML pages from src/ to dist/ so the unpacked
// extension dir is a complete drop-in for `chrome://extensions → Load unpacked`.
// Build pipeline: `tsc` compiles src/**/*.ts → dist/**/*.js, then this script
// mirrors the static assets that tsc doesn't touch.

import { cpSync, mkdirSync, readdirSync, statSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");

// 1. manifest.json at the dist root
mkdirSync(DIST, { recursive: true });
copyFileSync(join(SRC, "manifest.json"), join(DIST, "manifest.json"));

// 2. HTML files keep their src/ subdirectory structure (popup/, options/)
function copyHtmlRecursive(srcDir, distDir) {
  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    const distPath = join(distDir, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      mkdirSync(distPath, { recursive: true });
      copyHtmlRecursive(srcPath, distPath);
    } else if (entry.endsWith(".html") || entry.endsWith(".css")) {
      mkdirSync(dirname(distPath), { recursive: true });
      copyFileSync(srcPath, distPath);
    }
  }
}
copyHtmlRecursive(SRC, DIST);

// 3. icons/ if it exists — copy verbatim
const ICONS = join(ROOT, "icons");
try {
  statSync(ICONS).isDirectory() && cpSync(ICONS, join(DIST, "icons"), { recursive: true });
} catch {
  console.log("  (no icons/ — manifest will load without action icon)");
}

console.log("✓ Copied manifest + HTML/CSS + icons to dist/");

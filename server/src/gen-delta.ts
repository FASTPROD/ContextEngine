/**
 * Delta Module Generator
 *
 * Extracts premium modules from the main ContextEngine source,
 * compiles them to standalone .mjs files, and places them in
 * the delta-modules/ directory for the activation server.
 *
 * Usage:
 *   node dist/gen-delta.js [version]
 *
 * This reads from the parent ContextEngine dist/ directory and
 * copies the compiled premium modules into server/delta-modules/.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { minify } from "terser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Support CONTEXTENGINE_DIST env var for VPS where dist/ is at a different path
const CONTEXTENGINE_DIST = process.env.CONTEXTENGINE_DIST || join(__dirname, "..", "..", "dist");
const DELTA_DIR = join(__dirname, "..", "delta-modules");

// Premium modules to extract (these are the files with the real IP)
const PREMIUM_MODULES = [
  { src: "agents.js", dest: "agents.mjs", description: "Scorer, auditor, port checker, formatters (1653 lines)" },
  { src: "collectors.js", dest: "collectors.mjs", description: "11 operational data collectors (705 lines)" },
  { src: "search.js", dest: "search-adv.mjs", description: "Advanced BM25 search with tuned parameters" },
];

async function main(): Promise<void> {
  const version = process.argv[2] || "1.0.0";

  console.log(`\n📦 ContextEngine Delta Generator v${version}\n`);

  // Check source exists
  if (!existsSync(CONTEXTENGINE_DIST)) {
    console.error(`❌ ContextEngine dist/ not found at: ${CONTEXTENGINE_DIST}`);
    console.error(`   Run 'npm run build' in the parent directory first.`);
    process.exit(1);
  }

  // Create delta directory
  if (!existsSync(DELTA_DIR)) mkdirSync(DELTA_DIR, { recursive: true });

  const modules: string[] = [];

  for (const mod of PREMIUM_MODULES) {
    const srcPath = join(CONTEXTENGINE_DIST, mod.src);
    const destPath = join(DELTA_DIR, mod.dest);

    if (!existsSync(srcPath)) {
      console.warn(`  ⚠ Skipping ${mod.src} — not found in dist/`);
      continue;
    }

    // Read the compiled JS
    let content = readFileSync(srcPath, "utf-8");
    const originalSize = Buffer.byteLength(content);

    // Obfuscate: mangle variable names, compress, remove comments
    // This makes the decrypted delta files unreadable even on disk
    try {
      const result = await minify(content, {
        mangle: {
          toplevel: true,           // mangle top-level names
          properties: false,        // keep property names (needed for exports)
        },
        compress: {
          passes: 2,               // double-pass compression
          drop_console: false,     // keep console.error for debugging
          dead_code: true,
          collapse_vars: true,
          reduce_vars: true,
        },
        format: {
          comments: false,         // strip all comments
          beautify: false,
        },
        module: true,              // treat as ES module
        sourceMap: false,          // no source map
      });
      if (result.code) {
        content = result.code;
      }
    } catch (err) {
      console.warn(`  ⚠ Obfuscation failed for ${mod.src}, using original: ${(err as Error).message}`);
    }

    // Add a minimal delta header (no readable function names)
    const header = `// CE-DELTA:${mod.dest}:${version}:${new Date().toISOString()}\n`;
    content = header + content;

    writeFileSync(destPath, content);
    modules.push(mod.dest);

    const finalSize = Buffer.byteLength(content);
    const reduction = Math.round((1 - finalSize / originalSize) * 100);
    console.log(`  ✅ ${mod.dest} (${(finalSize / 1024).toFixed(1)} KB, ${reduction}% smaller) — ${mod.description}`);
  }

  // Write manifest
  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    modules: modules.map((m) => m.replace(".mjs", "")),
    moduleFiles: modules,
    obfuscated: true,
  };

  writeFileSync(join(DELTA_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\n  📋 Manifest written (v${version}, ${modules.length} modules, obfuscated)`);
  console.log(`  📂 Delta dir: ${DELTA_DIR}\n`);
}

main();

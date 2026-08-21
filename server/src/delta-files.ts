/**
 * Delta module listing, shared by server.ts.
 *
 * [LOCKED] [DELTA-MANIFEST-IS-THE-LIST] — 2026-08-21
 * [NEVER] hardcode the list of delta files in server.ts again.
 * WHY: gen-delta.ts emitted 5 modules (agents, rubric, collectors, search-adv, firewall) while
 *      server.ts served a hardcoded 3. rubric.js and firewall.mjs were generated on every deploy
 *      and never served. Two lists, no test between them, forked silently for months
 *      (SESSION_23, open item 1).
 * FIX: gen-delta writes manifest.json with `moduleFiles`; the server reads that. One writer,
 *      one reader, nothing to keep in sync. LEGACY_FILES is only the fallback for a delta dir
 *      that predates the manifest, and the unit test pins both paths.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const LEGACY_FILES = ["agents.mjs", "collectors.mjs", "search-adv.mjs"];

export interface DeltaModule {
  name: string;
  content: string;
}

/** "agents.mjs" -> "agents", "rubric.js" -> "rubric". */
export function deltaModuleName(file: string): string {
  return file.replace(/\.(mjs|js)$/, "");
}

/**
 * File names to serve, in manifest order. Falls back to LEGACY_FILES when the manifest
 * is missing, unreadable, or has no usable `moduleFiles` array.
 */
export function listDeltaFiles(deltaDir: string): { files: string[]; source: "manifest" | "legacy" } {
  const manifestPath = join(deltaDir, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const files = Array.isArray(manifest.moduleFiles)
        ? manifest.moduleFiles.filter((f: unknown) => typeof f === "string" && /^[A-Za-z0-9_-]+\.(mjs|js)$/.test(f))
        : [];
      if (files.length > 0) return { files, source: "manifest" };
    } catch {
      // fall through to legacy
    }
  }
  return { files: LEGACY_FILES, source: "legacy" };
}

/** Read every listed module that exists on disk. Missing files are skipped, not fatal. */
export function loadDeltaModulesFrom(deltaDir: string): DeltaModule[] {
  if (!existsSync(deltaDir)) return [];
  const { files } = listDeltaFiles(deltaDir);
  const modules: DeltaModule[] = [];
  for (const file of files) {
    const filePath = join(deltaDir, file);
    if (!existsSync(filePath)) continue;
    modules.push({ name: deltaModuleName(file), content: readFileSync(filePath, "utf-8") });
  }
  return modules;
}

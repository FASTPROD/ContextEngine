import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import type { Chunk } from "./ingest.js";

/**
 * ContextEngine Plugin/Adapter System
 *
 * Adapters are pluggable data source connectors that extend ContextEngine
 * with custom data collection. Each adapter implements the Adapter interface
 * and returns Chunk[] compatible with the existing search pipeline.
 *
 * Built-in collectors (git, package.json, docker, pm2, etc.) remain as-is.
 * Adapters add NEW sources without modifying core code.
 *
 * Usage in contextengine.json:
 * {
 *   "adapters": [
 *     { "name": "notion", "module": "./adapters/notion-adapter.js", "config": { "token": "$NOTION_TOKEN" } },
 *     { "name": "jira", "module": "@compr/contextengine-jira", "config": { "baseUrl": "https://myorg.atlassian.net" } }
 *   ]
 * }
 */

// ---------------------------------------------------------------------------
// Adapter Interface
// ---------------------------------------------------------------------------

/**
 * Configuration for a single adapter entry in contextengine.json
 */
export interface AdapterEntry {
  /** Unique identifier for this adapter instance */
  name: string;
  /** Module path — local file (./adapters/foo.js) or npm package (@compr/contextengine-jira) */
  module: string;
  /** Adapter-specific configuration (passed to init/collect) */
  config?: Record<string, unknown>;
  /** Whether this adapter is enabled (default: true) */
  enabled?: boolean;
}

/**
 * The interface every adapter must implement.
 *
 * Adapters are ES modules that export a default object implementing this interface,
 * OR export a `createAdapter(config)` factory function.
 */
export interface Adapter {
  /** Human-readable adapter name */
  name: string;

  /** Short description of what this adapter collects */
  description: string;

  /**
   * Collect data and return searchable chunks.
   * Called during reindex. Must be safe (read-only, no side effects).
   * Should never throw — return empty array on failure.
   *
   * @param config — Adapter-specific config from contextengine.json
   * @returns Array of chunks to merge into the search index
   */
  collect(config?: Record<string, unknown>): Promise<Chunk[]> | Chunk[];

  /**
   * Optional: validate configuration before collect().
   * Return an error message string if config is invalid, or null if OK.
   */
  validate?(config?: Record<string, unknown>): string | null;

  /**
   * Optional: one-time initialization (e.g. auth handshake).
   * Called once when the adapter is first loaded.
   */
  init?(config?: Record<string, unknown>): Promise<void> | void;

  /**
   * Optional: cleanup resources on shutdown.
   */
  destroy?(): Promise<void> | void;
}

/**
 * Factory function signature — adapters can export this instead of a static object.
 * Allows per-instance configuration.
 */
export type AdapterFactory = (config?: Record<string, unknown>) => Adapter | Promise<Adapter>;

// ---------------------------------------------------------------------------
// Adapter Registry
// ---------------------------------------------------------------------------

/** Active adapter instances keyed by name */
const adapterRegistry = new Map<string, Adapter>();

/**
 * Resolve environment variable references in config values.
 * Supports "$ENV_VAR" syntax — replaces with process.env value.
 */
function resolveEnvVars(config: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string" && value.startsWith("$")) {
      const envVar = value.slice(1);
      resolved[key] = process.env[envVar] || value;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      resolved[key] = resolveEnvVars(value as Record<string, unknown>);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Load a single adapter from its module path.
 * Supports:
 * - Local files: "./adapters/foo.js" (relative to config file)
 * - npm packages: "@compr/contextengine-jira"
 * - Named exports: "my-package#myAdapter"
 */
async function loadAdapterModule(
  modulePath: string,
  config?: Record<string, unknown>
): Promise<Adapter> {
  let moduleSpecifier = modulePath;
  let exportName: string | null = null;

  // Support "module#export" syntax
  if (modulePath.includes("#")) {
    const [mod, exp] = modulePath.split("#", 2);
    moduleSpecifier = mod;
    exportName = exp;
  }

  // Resolve relative paths from CWD
  if (moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/")) {
    moduleSpecifier = resolve(process.cwd(), moduleSpecifier);
  }

  const mod = await import(moduleSpecifier);

  // Check for factory function
  if (exportName && typeof mod[exportName] === "function") {
    return await mod[exportName](config);
  }

  if (typeof mod.createAdapter === "function") {
    return await mod.createAdapter(config);
  }

  // Check for default export
  if (mod.default) {
    if (typeof mod.default === "function") {
      return await mod.default(config);
    }
    if (typeof mod.default.collect === "function") {
      return mod.default as Adapter;
    }
  }

  // Check for named adapter export
  if (typeof mod.adapter === "object" && typeof mod.adapter.collect === "function") {
    return mod.adapter as Adapter;
  }

  throw new Error(
    `Module "${modulePath}" does not export a valid adapter. ` +
    `Expected: default export with collect(), createAdapter() factory, or named 'adapter' export.`
  );
}

/**
 * Load and register all adapters from config.
 * Safe — logs errors but never crashes.
 *
 * @param entries — Adapter entries from contextengine.json
 * @returns Number of successfully loaded adapters
 */
export async function loadAdapters(entries: AdapterEntry[]): Promise<number> {
  let loaded = 0;

  for (const entry of entries) {
    if (entry.enabled === false) {
      console.error(`[ContextEngine] 🔌 Adapter "${entry.name}" — disabled, skipping`);
      continue;
    }

    try {
      const resolvedConfig = entry.config ? resolveEnvVars(entry.config) : undefined;

      const adapter = await loadAdapterModule(entry.module, resolvedConfig);

      // Validate config if adapter supports it
      if (adapter.validate) {
        const error = adapter.validate(resolvedConfig);
        if (error) {
          console.error(
            `[ContextEngine] ⚠ Adapter "${entry.name}" config invalid: ${error}`
          );
          continue;
        }
      }

      // Initialize
      if (adapter.init) {
        await adapter.init(resolvedConfig);
      }

      adapterRegistry.set(entry.name, adapter);
      loaded++;
      console.error(
        `[ContextEngine] 🔌 Adapter "${entry.name}" loaded — ${adapter.description}`
      );
    } catch (err) {
      console.error(
        `[ContextEngine] ⚠ Failed to load adapter "${entry.name}" from "${entry.module}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return loaded;
}

/**
 * Collect data from all registered adapters.
 * Returns combined chunks from all adapters.
 * Safe — individual adapter failures don't affect others.
 *
 * @param entries — Adapter entries (for config lookup)
 * @returns Combined chunks from all adapters
 */
export async function collectFromAdapters(entries: AdapterEntry[]): Promise<Chunk[]> {
  const allChunks: Chunk[] = [];

  for (const entry of entries) {
    const adapter = adapterRegistry.get(entry.name);
    if (!adapter) continue;

    try {
      const resolvedConfig = entry.config ? resolveEnvVars(entry.config) : undefined;
      const startMs = Date.now();
      const chunks = await adapter.collect(resolvedConfig);
      const elapsedMs = Date.now() - startMs;

      // Tag chunks with adapter source
      for (const chunk of chunks) {
        if (!chunk.source.includes(entry.name)) {
          chunk.source = `${entry.name} — ${chunk.source}`;
        }
      }

      allChunks.push(...chunks);

      if (chunks.length > 0) {
        console.error(
          `[ContextEngine] 🔌 Adapter "${entry.name}" collected ${chunks.length} chunks (${elapsedMs}ms)`
        );
      }
    } catch (err) {
      console.error(
        `[ContextEngine] ⚠ Adapter "${entry.name}" collect() failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return allChunks;
}

/**
 * Destroy all registered adapters (cleanup).
 */
export async function destroyAdapters(): Promise<void> {
  for (const [name, adapter] of adapterRegistry) {
    try {
      if (adapter.destroy) {
        await adapter.destroy();
      }
    } catch (err) {
      console.error(
        `[ContextEngine] ⚠ Adapter "${name}" destroy() failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  adapterRegistry.clear();
}

/**
 * Get list of registered adapter names and their descriptions.
 */
export function listRegisteredAdapters(): Array<{ name: string; description: string }> {
  return Array.from(adapterRegistry.entries()).map(([name, adapter]) => ({
    name,
    description: adapter.description,
  }));
}

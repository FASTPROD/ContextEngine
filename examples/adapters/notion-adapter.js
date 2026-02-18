/**
 * Example ContextEngine Adapter — Notion Integration
 *
 * This is a SKELETON adapter showing how to build a custom data source
 * connector for ContextEngine. It demonstrates the full Adapter interface.
 *
 * To use this adapter:
 * 1. Copy this file to your project
 * 2. Install the Notion SDK: npm install @notionhq/client
 * 3. Add to contextengine.json:
 *    {
 *      "adapters": [{
 *        "name": "notion",
 *        "module": "./adapters/notion-adapter.js",
 *        "config": { "token": "$NOTION_API_TOKEN", "databases": ["db-id-1", "db-id-2"] }
 *      }]
 *    }
 * 4. Set NOTION_API_TOKEN in your environment
 *
 * @module
 */

// Import the Adapter type from ContextEngine
// import type { Adapter } from "@compr/contextengine-mcp/adapters";

/**
 * Notion adapter — fetches pages and databases from Notion
 * and converts them into searchable ContextEngine chunks.
 */
const notionAdapter = {
  name: "notion",
  description: "Fetches pages and databases from Notion workspace",

  /**
   * Validate adapter configuration.
   * Return null if valid, error message string if invalid.
   */
  validate(config) {
    if (!config?.token) {
      return "Missing 'token' in config. Set NOTION_API_TOKEN env var and use \"$NOTION_API_TOKEN\" in config.";
    }
    return null;
  },

  /**
   * Optional initialization — called once when adapter loads.
   * Use for auth handshake, API client setup, etc.
   */
  async init(config) {
    // Example: Initialize Notion client
    // const { Client } = await import("@notionhq/client");
    // this._client = new Client({ auth: config.token });
    console.error(`[Notion Adapter] Initialized with token: ${config?.token ? "✓" : "✗"}`);
  },

  /**
   * Collect data — the core method.
   * Called during every reindex. Must be safe (read-only, no side effects).
   * Returns Chunk[] compatible with ContextEngine's search index.
   */
  async collect(config) {
    const chunks = [];

    try {
      // Example: Fetch pages from configured databases
      const databases = config?.databases || [];

      for (const dbId of databases) {
        // In a real adapter, you'd call the Notion API here:
        // const response = await this._client.databases.query({ database_id: dbId });
        // for (const page of response.results) { ... }

        // Example chunk structure:
        chunks.push({
          source: `Notion DB ${dbId}`,
          section: "## Page Title",
          content: "Page content extracted from Notion blocks...",
          lineStart: 1,
          lineEnd: 1,
          // Optional: add indexedAt for temporal decay
          indexedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      // Never throw — return empty array on failure
      console.error(`[Notion Adapter] Error: ${err?.message || err}`);
      return [];
    }

    return chunks;
  },

  /**
   * Optional cleanup — called on server shutdown.
   */
  async destroy() {
    // Close connections, flush buffers, etc.
    console.error("[Notion Adapter] Destroyed");
  },
};

// Export as default (ContextEngine auto-detects)
export default notionAdapter;

// Alternative: export a factory function for per-instance config
// export function createAdapter(config) {
//   return { ...notionAdapter, _config: config };
// }

/**
 * Tools Manifest — single source of truth for the MCP tool catalog.
 *
 * Why: the info panel in the VS Code extension (and the README) historically
 * hardcoded the tool count ("Active on all 17 MCP tools"). When new tools
 * shipped (drift_status was the 21st), those displays silently drifted.
 *
 * Fix: every tool exposed via `server.tool(...)` in `index.ts` MUST appear
 * in `ALL_TOOLS` below. A regression test in `tests/tools-manifest.test.ts`
 * counts `^server.tool(` lines in `index.ts` and asserts the count matches
 * `ALL_TOOLS.length`. If you add or remove a tool, this list + the test
 * fail together — no silent drift possible.
 *
 * Consumers:
 *   - `index.ts` writes `~/.contextengine/server-meta.json` on startup with
 *     `{ toolCount, premiumCount, freeCount, version, generatedAt }` so the
 *     VS Code extension can read it without needing an active MCP session.
 *   - `activation.ts` imports `PREMIUM_TOOL_NAMES` (the subset that requires
 *     a PRO license).
 *
 * @module tools-manifest
 */

/**
 * Every tool name registered on the MCP server, in registration order.
 * Order is not load-bearing — kept stable for easier diffs.
 */
export const ALL_TOOLS = [
  "search_context",
  "list_sources",
  "read_source",
  "reindex",
  "list_projects",
  "check_ports",
  "run_audit",
  "score_project",
  "save_session",
  "load_session",
  "list_sessions",
  "delete_session",
  "audit_verify",
  "drift_status",
  "end_session",
  "save_learning",
  "list_learnings",
  "delete_learning",
  "import_learnings",
  "activate",
  "activation_status",
] as const;

/**
 * The 4 tools gated behind PRO activation. Subset of `ALL_TOOLS`.
 * Must match `PREMIUM_TOOLS` in `src/activation.ts` (asserted by test).
 */
export const PREMIUM_TOOL_NAMES = [
  "score_project",
  "run_audit",
  "check_ports",
  "list_projects",
] as const;

/** Total count — what users see as "Active on all N MCP tools". */
export const TOOL_COUNT = ALL_TOOLS.length;

/** Free-tier tool count — everything except `PREMIUM_TOOL_NAMES`. */
export const FREE_TOOL_COUNT = ALL_TOOLS.length - PREMIUM_TOOL_NAMES.length;

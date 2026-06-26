/**
 * Reads ~/.contextengine/server-meta.json — the metadata the MCP server writes
 * on startup (added in @compr/opscontext-mcp@2.1.3). Used by the info panel
 * to render an accurate tool count instead of a hardcoded number.
 *
 * Falls back gracefully when:
 *   - The file doesn't exist (MCP server hasn't run yet on this machine, or
 *     server is at <2.1.3) — caller renders "all MCP tools" without a number.
 *   - The file is malformed (concurrent write half-flushed, manual edit, etc.)
 *     — same fallback. We never throw.
 *
 * @module serverMeta
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ServerMeta {
  toolCount: number;
  freeCount: number;
  premiumCount: number;
  version: string;
  generatedAt: string;
}

const META_PATH = path.join(os.homedir(), ".contextengine", "server-meta.json");

/**
 * Synchronously reads ~/.contextengine/server-meta.json. Returns null on any
 * failure (missing file, parse error, schema mismatch).
 *
 * Synchronous on purpose: callers render HTML strings inline (info panel),
 * and the file is tiny (~128 bytes). The fs.readFileSync hit is well under
 * 1ms on every platform the extension supports.
 */
export function readServerMeta(): ServerMeta | null {
  try {
    const raw = fs.readFileSync(META_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.toolCount === "number" &&
      typeof parsed.freeCount === "number" &&
      typeof parsed.premiumCount === "number" &&
      typeof parsed.version === "string"
    ) {
      return parsed as ServerMeta;
    }
    return null;
  } catch {
    return null;
  }
}

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * Session Persistence — save/restore conversation context between sessions.
 *
 * Sessions are saved as JSON files in ~/.contextengine/sessions/.
 * Each session has a name, timestamp, and key-value data store.
 *
 * Use cases:
 * - AI agent saves decisions/context at end of session → picks up next time
 * - Track what was discussed, changed, or planned across sessions
 * - Store project-specific notes that persist between agent restarts
 */

const SESSIONS_DIR = join(homedir(), ".contextengine", "sessions");

export interface SessionEntry {
  key: string;
  value: string;
  timestamp: string;
}

export interface Session {
  name: string;
  created: string;
  updated: string;
  entries: SessionEntry[];
}

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function sessionPath(name: string): string {
  // Sanitize name for filesystem
  const safe = name.replace(/[^a-zA-Z0-9_\-\.]/g, "_").substring(0, 100);
  return join(SESSIONS_DIR, `${safe}.json`);
}

/**
 * Save or update a key-value pair in a named session.
 */
export function saveSession(name: string, key: string, value: string): Session {
  ensureDir();
  const path = sessionPath(name);
  const now = new Date().toISOString();

  let session: Session;
  if (existsSync(path)) {
    session = JSON.parse(readFileSync(path, "utf-8"));
    session.updated = now;
  } else {
    session = { name, created: now, updated: now, entries: [] };
  }

  // Update existing key or add new one
  const existing = session.entries.find((e) => e.key === key);
  if (existing) {
    existing.value = value;
    existing.timestamp = now;
  } else {
    session.entries.push({ key, value, timestamp: now });
  }

  writeFileSync(path, JSON.stringify(session, null, 2));
  return session;
}

/**
 * Load a session by name.
 */
export function loadSession(name: string): Session | null {
  const path = sessionPath(name);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * List all saved sessions.
 */
export function listSessions(): Array<{ name: string; entries: number; created: string; updated: string }> {
  ensureDir();

  try {
    return readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const session: Session = JSON.parse(
            readFileSync(join(SESSIONS_DIR, f), "utf-8")
          );
          return {
            name: session.name,
            entries: session.entries.length,
            created: session.created,
            updated: session.updated,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Array<{ name: string; entries: number; created: string; updated: string }>;
  } catch {
    return [];
  }
}

/**
 * Delete a session.
 */
export function deleteSession(name: string): boolean {
  const path = sessionPath(name);
  if (existsSync(path)) {
    unlinkSync(path);
    return true;
  }
  return false;
}

/**
 * Format a session for display.
 */
export function formatSession(session: Session): string {
  const lines: string[] = [];
  lines.push(`# Session: ${session.name}`);
  lines.push(`Created: ${session.created}`);
  lines.push(`Updated: ${session.updated}`);
  lines.push(`Entries: ${session.entries.length}`);
  lines.push("");

  for (const entry of session.entries) {
    lines.push(`## ${entry.key}`);
    lines.push(`_Updated: ${entry.timestamp}_`);
    lines.push("");
    lines.push(entry.value);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format session list for display.
 */
export function formatSessionList(sessions: Array<{ name: string; entries: number; created: string; updated: string }>): string {
  if (sessions.length === 0) {
    return "No saved sessions. Use `save_session` to create one.";
  }

  const lines: string[] = [];
  lines.push("# 📋 Saved Sessions\n");
  lines.push("| Session | Entries | Created | Last Updated |");
  lines.push("|---------|---------|---------|-------------|");

  for (const s of sessions) {
    const created = s.created.split("T")[0];
    const updated = s.updated.split("T")[0];
    lines.push(`| ${s.name} | ${s.entries} | ${created} | ${updated} |`);
  }

  return lines.join("\n");
}

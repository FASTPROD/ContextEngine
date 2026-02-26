import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  formatSession,
  formatSessionList,
} from "../src/sessions.js";

const SESSIONS_DIR = join(homedir(), ".contextengine", "sessions");
const TEST_SESSION = "vitest-session-temp";

describe("sessions", () => {
  // Clean up test session before and after
  beforeEach(() => {
    const path = join(SESSIONS_DIR, `${TEST_SESSION}.json`);
    if (existsSync(path)) rmSync(path);
  });

  afterEach(() => {
    const path = join(SESSIONS_DIR, `${TEST_SESSION}.json`);
    if (existsSync(path)) rmSync(path);
  });

  it("saveSession creates a new session", () => {
    const session = saveSession(TEST_SESSION, "status", "in-progress");
    expect(session.name).toBe(TEST_SESSION);
    expect(session.entries).toHaveLength(1);
    expect(session.entries[0].key).toBe("status");
    expect(session.entries[0].value).toBe("in-progress");
  });

  it("saveSession appends entries to existing session", () => {
    saveSession(TEST_SESSION, "key1", "value1");
    const session = saveSession(TEST_SESSION, "key2", "value2");
    expect(session.entries).toHaveLength(2);
  });

  it("saveSession updates existing key", () => {
    saveSession(TEST_SESSION, "status", "draft");
    const session = saveSession(TEST_SESSION, "status", "done");
    // Should have 1 entry (updated in place), not 2
    const statusEntries = session.entries.filter((e) => e.key === "status");
    expect(statusEntries).toHaveLength(1);
    expect(statusEntries[0].value).toBe("done");
  });

  it("loadSession returns null for non-existent session", () => {
    const result = loadSession("nonexistent-session-xyz-12345");
    expect(result).toBeNull();
  });

  it("loadSession returns saved session data", () => {
    saveSession(TEST_SESSION, "branch", "main");
    const loaded = loadSession(TEST_SESSION);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe(TEST_SESSION);
    expect(loaded!.entries[0].key).toBe("branch");
    expect(loaded!.entries[0].value).toBe("main");
  });

  it("listSessions returns array", () => {
    const sessions = listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it("listSessions includes test session after save", () => {
    saveSession(TEST_SESSION, "test", "data");
    const sessions = listSessions();
    const found = sessions.find((s) => s.name === TEST_SESSION);
    expect(found).toBeDefined();
    expect(found!.entries).toBe(1);
  });

  it("deleteSession removes session file", () => {
    saveSession(TEST_SESSION, "key", "val");
    expect(loadSession(TEST_SESSION)).not.toBeNull();
    const deleted = deleteSession(TEST_SESSION);
    expect(deleted).toBe(true);
    expect(loadSession(TEST_SESSION)).toBeNull();
  });

  it("deleteSession returns false for non-existent session", () => {
    const deleted = deleteSession("nonexistent-xyz-999");
    expect(deleted).toBe(false);
  });

  it("formatSession produces readable output", () => {
    const session = saveSession(TEST_SESSION, "branch", "main");
    const text = formatSession(session);
    expect(text).toContain(TEST_SESSION);
    expect(text).toContain("branch");
    expect(text).toContain("main");
  });

  it("formatSessionList produces readable output", () => {
    saveSession(TEST_SESSION, "key", "val");
    const sessions = listSessions();
    const text = formatSessionList(sessions);
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });

  it("session name is sanitized for filesystem", () => {
    // Names with special chars should not throw
    const session = saveSession("test/with:special<chars>", "k", "v");
    expect(session.name).toBeDefined();
    // Clean up
    deleteSession("test/with:special<chars>");
  });
});

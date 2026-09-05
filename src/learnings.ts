// LOCKED — verified March 3 2026 — learning store: quality gates, auto-categorize, dedup, project-scoped filtering
// DO NOT RE-AUDIT — min 15 chars, inferCategory(), autoImportFromSources() all verified v1.19.1

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, rmSync, statSync, readdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { Chunk } from "./ingest.js";
import { safeAppend } from "./audit.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Learning Store — permanent operational rules that persist forever.
 *
 * Unlike sessions (ephemeral per-conversation context), learnings are
 * **permanent rules** discovered during coding sessions. They get
 * auto-indexed and surfaced via search_context so AI agents don't
 * repeat the same mistakes.
 *
 * Storage: ~/.contextengine/learnings.json
 *
 * Examples:
 * - "Always restart Flask backend after model changes — stale to_dict()"
 * - "Expo --port flag only controls Metro, NOT webpack dev server"
 * - "macOS sandbox blocks ~/Downloads access from VS Code terminal"
 * - "Unicode NFC vs NFD causes false mismatches on Google Drive vs APFS"
 */

const LEARNINGS_PATH = join(process.env.CONTEXTENGINE_HOME || join(homedir(), ".contextengine"), "learnings.json");

export interface Learning {
  id: string;
  category: string;
  rule: string;
  context: string;
  project?: string;
  tags: string[];
  created: string;
  updated: string;
}

export interface LearningsStore {
  version: number;
  count: number;
  learnings: Learning[];
}

/** Valid categories for learnings */
export const LEARNING_CATEGORIES = [
  "deployment",
  "api",
  "database",
  "frontend",
  "backend",
  "devops",
  "security",
  "performance",
  "testing",
  "debugging",
  "tooling",
  "git",
  "dependencies",
  "architecture",
  "data",
  "infrastructure",
  "mobile",
  "other",
] as const;

export type LearningCategory = (typeof LEARNING_CATEGORIES)[number];

function ensureDir(): void {
  const dir = join(homedir(), ".contextengine");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load bundled starter learnings from the npm package's defaults/ directory.
 * These are curated, universal best practices shipped with every install.
 */
function loadBundledDefaults(): Array<{ category: string; rule: string; context: string; tags: string[] }> {
  // defaults/ sits next to dist/ in the package root
  const defaultsPath = join(__dirname, "..", "defaults", "learnings.json");
  if (existsSync(defaultsPath)) {
    try {
      return JSON.parse(readFileSync(defaultsPath, "utf-8"));
    } catch {
      // Malformed defaults — skip silently
    }
  }
  return [];
}

/**
 * Merge bundled defaults into user store if they don't already exist.
 * Uses rule text (lowercased) for dedup — user learnings always win.
 */
function mergeDefaults(store: LearningsStore): boolean {
  const bundled = loadBundledDefaults();
  if (bundled.length === 0) return false;

  const existingRules = new Set(
    store.learnings
      .filter((l) => typeof l.rule === "string")
      .map((l) => l.rule.toLowerCase().trim())
  );

  let added = 0;
  const now = new Date().toISOString();

  for (const def of bundled) {
    if (existingRules.has(def.rule.toLowerCase().trim())) continue;

    store.learnings.push({
      id: generateId(),
      category: def.category as LearningCategory,
      rule: def.rule,
      context: def.context,
      tags: def.tags || [],
      created: now,
      updated: now,
    });
    existingRules.add(def.rule.toLowerCase().trim());
    added++;
  }

  return added > 0;
}

// [LOCKED] [STORE-NEVER-STARTS-FRESH-OVER-DATA] 2026-09-05
// [NEVER] turn an unreadable learnings.json into an empty store, write the store with a
//         bare writeFileSync, or let two processes write it without the lock below.
// WHY: on 2026-09-05 (16:34Z) the whole store was rebuilt from scratch: every id
//      replaced, every `created` reset, the save_learning-only records gone. Cause, read
//      from the code and the audit log: every MCP server (launchd, VS Code, Claude Code)
//      watches ~880 doc files and re-imports all of them on any change, one full-file
//      rewrite PER RULE; with two or three servers doing that at once, one read a
//      half-written file, `catch { start fresh }` turned it into an empty store, and the
//      next save overwrote 2,808 records with the rebuilt set. The audit log shows 54
//      such bursts since 2026-06-23 and 143,352 ids created for a store of ~2,800: the
//      same race, repeatedly, and the likeliest source of the 66 audit-chain forks.
// FIX: (1) atomic writes, temp file + rename, so a reader never sees a torn file;
//      (2) an unreadable existing file is copied to learnings.json.corrupt-<ts> and the
//          load THROWS, it never becomes an empty store; (3) a saved store that is less
//          than half the on-disk one (and the disk one has >= 100 records) is refused
//          unless CONTEXTENGINE_ALLOW_SHRINK=1; (4) a cross-process lock directory
//          around every load-modify-save; (5) imports run as ONE batch: one load, one
//          save, instead of one rewrite per rule; (6) a daily learnings.json.bak-YYYYMMDD
//          before the first write of the day, last 7 kept.
const STORE_LOCK_DIR = LEARNINGS_PATH + ".lock";
const LOCK_STALE_MS = 30_000;
let lockDepth = 0;
let batchStore: LearningsStore | null = null;
let batchDirty = false;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Cross-process, re-entrant (within this process) lock around the store file. */
export function withStoreLock<T>(fn: () => T): T {
  if (lockDepth > 0) { lockDepth++; try { return fn(); } finally { lockDepth--; } }
  ensureDir();
  const timeoutMs = parseInt(process.env.CONTEXTENGINE_LOCK_TIMEOUT_MS || "10000", 10);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(STORE_LOCK_DIR);
      try { writeFileSync(join(STORE_LOCK_DIR, "pid"), String(process.pid)); } catch { /* diagnostics only */ }
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      let age = 0;
      try { age = Date.now() - statSync(STORE_LOCK_DIR).mtimeMs; } catch { age = 0; }
      if (age > LOCK_STALE_MS) {
        // Holder died (or hung) without releasing: take it over.
        try { rmSync(STORE_LOCK_DIR, { recursive: true, force: true }); } catch { /* retry below */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`learnings store is locked by another process (${STORE_LOCK_DIR}, ${Math.round(age / 1000)}s old); refusing to write over it`);
      }
      sleepMs(25);
    }
  }
  lockDepth = 1;
  try {
    return fn();
  } finally {
    lockDepth = 0;
    try { rmSync(STORE_LOCK_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Run `fn` with ONE load and at most ONE save of the store, under the lock. Inside, every
 * loadStore() returns the same in-memory store and every saveStore() only marks it dirty.
 */
export function withStoreBatch<T>(fn: () => T): T {
  if (batchStore) return fn(); // already batching (re-entrant)
  return withStoreLock(() => {
    batchStore = readStoreFromDisk();
    batchDirty = false;
    try {
      const out = fn();
      if (batchDirty) writeStoreToDisk(batchStore);
      return out;
    } finally {
      batchStore = null;
      batchDirty = false;
    }
  });
}

function readStoreFromDisk(): LearningsStore {
  let store: LearningsStore;
  if (existsSync(LEARNINGS_PATH)) {
    const raw = readFileSync(LEARNINGS_PATH, "utf-8");
    try {
      store = JSON.parse(raw);
      if (!store || !Array.isArray(store.learnings)) throw new Error("no learnings array");
    } catch (e: any) {
      const keep = `${LEARNINGS_PATH}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try { copyFileSync(LEARNINGS_PATH, keep); } catch { /* the original stays in place regardless */ }
      safeAppend("learning.store_unreadable", { path: LEARNINGS_PATH, bytes: raw.length, kept: keep, error: String(e?.message || e) });
      throw new Error(`${LEARNINGS_PATH} exists but is unreadable (${e?.message || e}); refusing to start fresh over it. Copy kept at ${keep}. Another process may be mid-write: retry in a moment.`);
    }
    // Filter out corrupted entries missing required 'rule' field; a missing or unknown
    // category becomes "other" (two June-era records crashed list_learnings on 2026-09-05).
    store.learnings = store.learnings.filter((l) => typeof l.rule === "string" && l.rule.length > 0);
    for (const l of store.learnings) {
      if (typeof l.category !== "string" || !(LEARNING_CATEGORIES as readonly string[]).includes(l.category)) l.category = "other";
    }
  } else {
    store = { version: 1, count: 0, learnings: [] };
  }

  // Auto-merge bundled defaults on first load or when new defaults are added
  if (mergeDefaults(store)) {
    if (batchStore) batchDirty = true; else writeStoreToDisk(store);
  }
  return store;
}

function loadStore(): LearningsStore {
  if (batchStore) return batchStore;
  return readStoreFromDisk();
}

function dailyBackup(): void {
  if (!existsSync(LEARNINGS_PATH)) return;
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const bak = `${LEARNINGS_PATH}.bak-${day}`;
  if (existsSync(bak)) return;
  try {
    copyFileSync(LEARNINGS_PATH, bak);
    const dir = dirname(LEARNINGS_PATH);
    const daily = readdirSync(dir).filter((f) => /^learnings\.json\.bak-\d{8}$/.test(f)).sort();
    for (const f of daily.slice(0, Math.max(0, daily.length - 7))) unlinkSync(join(dir, f));
  } catch { /* a missing backup must never block a save */ }
}

function writeStoreToDisk(store: LearningsStore): void {
  ensureDir();
  store.count = store.learnings.length;
  // Shrink tripwire: the exact shape of the 2026-09-05 loss was a near-empty store
  // written over a full one.
  if (existsSync(LEARNINGS_PATH) && process.env.CONTEXTENGINE_ALLOW_SHRINK !== "1") {
    let onDisk = -1;
    try { onDisk = (JSON.parse(readFileSync(LEARNINGS_PATH, "utf-8")).learnings || []).length; } catch { onDisk = -1; }
    if (onDisk >= 100 && store.learnings.length < onDisk / 2) {
      safeAppend("learning.store_shrink_refused", { on_disk: onDisk, attempted: store.learnings.length });
      throw new Error(`refusing to write ${store.learnings.length} learnings over a store of ${onDisk}: that is the shape of a wipe, not an edit. Set CONTEXTENGINE_ALLOW_SHRINK=1 if this is deliberate.`);
    }
  }
  dailyBackup();
  const tmp = `${LEARNINGS_PATH}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, LEARNINGS_PATH);
}

function saveStore(store: LearningsStore): void {
  if (batchStore) { batchStore = store; batchDirty = true; return; }
  writeStoreToDisk(store);
}

/** Test seam for the writer's tripwire; not part of the API. */
export function __writeStoreForTests(store: LearningsStore): void {
  withStoreLock(() => writeStoreToDisk(store));
}

/** Generate a short unique ID */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

/** Extract tags from rule + context text */
function extractTags(rule: string, context: string, category: string): string[] {
  const text = `${rule} ${context}`.toLowerCase();
  const tags = new Set<string>([category]);

  // Common tech keywords
  const techWords = [
    "flask", "laravel", "react", "expo", "docker", "nginx", "pm2",
    "mysql", "postgres", "redis", "node", "python", "php", "typescript",
    "git", "npm", "composer", "pip", "api", "cors", "jwt", "oauth",
    "ssl", "https", "ssh", "dns", "gps", "macos", "linux", "windows",
    "webpack", "vite", "cra", "nextjs", "flutter", "swift", "kotlin",
    "supervisor", "cron", "smtp", "queue", "cache", "migration",
    "unicode", "encoding", "permissions", "sandbox", "firewall",
  ];

  for (const word of techWords) {
    if (text.includes(word)) {
      tags.add(word);
    }
  }

  return Array.from(tags);
}

/** Minimum rule length — anything shorter is noise, not knowledge */
const MIN_RULE_LENGTH = 15;

/**
 * Save a new learning. Returns the created learning with ID.
 * Rejects rules shorter than MIN_RULE_LENGTH and auto-corrects "other" category.
 */
export function saveLearning(...args: Parameters<typeof saveLearningUnlocked>): Learning {
  return withStoreLock(() => saveLearningUnlocked(...args));
}

function saveLearningUnlocked(
  category: string,
  rule: string,
  context: string,
  project?: string
): Learning {
  const trimmedRule = rule.trim();

  // Quality gate: reject junk rules
  if (trimmedRule.length < MIN_RULE_LENGTH) {
    throw new Error(
      `Rule too short (${trimmedRule.length} chars, min ${MIN_RULE_LENGTH}). ` +
      `Learnings must be actionable sentences, not single words. Example: ` +
      `"Always restart Flask after model changes — stale to_dict() cache"`
    );
  }

  // Quality gate: auto-correct "other" category by inferring from rule + context
  if (category === "other") {
    const inferred = inferCategory(trimmedRule, context);
    if (inferred !== "other") {
      category = inferred;
    }
  }

  const store = loadStore();
  const now = new Date().toISOString();

  // Check for duplicate rules (fuzzy: same category + similar rule text)
  const ruleLower = rule.toLowerCase().trim();
  const existing = store.learnings.find(
    (l) =>
      l.category === category &&
      typeof l.rule === "string" && l.rule.toLowerCase().trim() === ruleLower
  );

  if (existing) {
    // A re-import that changes nothing must leave no trace: no write, no `updated` bump,
    // no audit event. Before 2026-09-05 every startup re-import emitted one learning.save
    // per rule (2,000 to 5,000 events per server start) for records that did not change.
    const newTags = extractTags(existing.rule, context, category);
    const sameTags = JSON.stringify(newTags) === JSON.stringify(existing.tags || []);
    if (existing.context === context && (!project || existing.project === project) && sameTags) {
      return existing;
    }
    // Update existing learning with new context
    existing.context = context;
    existing.updated = now;
    if (project) existing.project = project;
    existing.tags = newTags;
    saveStore(store);
    safeAppend("learning.save", {
      id: existing.id,
      category: existing.category,
      project: existing.project,
      rule_length: existing.rule.length,
      mode: "update",
    });
    return existing;
  }

  const learning: Learning = {
    id: generateId(),
    category: category as LearningCategory,
    rule,
    context,
    project,
    tags: extractTags(rule, context, category),
    created: now,
    updated: now,
  };

  store.learnings.push(learning);
  saveStore(store);
  safeAppend("learning.save", {
    id: learning.id,
    category: learning.category,
    project: learning.project,
    rule_length: learning.rule.length,
    mode: "create",
  });
  return learning;
}

/**
 * Search learnings by keyword. Returns matches sorted by relevance.
 */
export function searchLearnings(query: string): Learning[] {
  const store = loadStore();
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  if (tokens.length === 0) return store.learnings;

  const scored: Array<{ learning: Learning; score: number }> = [];

  for (const learning of store.learnings) {
    const text = `${learning.category} ${learning.rule} ${learning.context} ${learning.project || ""} ${learning.tags.join(" ")}`.toLowerCase();
    let score = 0;

    for (const token of tokens) {
      if (text.includes(token)) {
        score += 1;
        // Bonus for matching rule text directly (the important part)
        if (typeof learning.rule === "string" && learning.rule.toLowerCase().includes(token)) score += 2;
        // Bonus for matching category
        if (learning.category.toLowerCase().includes(token)) score += 1;
      }
    }

    // Multi-term bonus
    const distinctMatches = tokens.filter((t) => text.includes(t)).length;
    if (distinctMatches > 1) score += distinctMatches * 2;

    if (score > 0) {
      scored.push({ learning, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.learning);
}

/**
 * Get learnings, optionally filtered by category and/or project.
 *
 * When `projects` is provided, only returns learnings that:
 * - match one of the given project names (case-insensitive), OR
 * - have no project set (universal learnings)
 *
 * This prevents cross-project IP leakage — e.g. CROWLR learnings
 * won't appear when working on VOILA.
 */
export function listLearnings(category?: string, projects?: string[]): Learning[] {
  const store = loadStore();
  let result = store.learnings;

  if (projects && projects.length > 0) {
    const lowerProjects = projects.map((p) => p.toLowerCase());
    result = result.filter(
      (l) => !l.project || lowerProjects.includes(l.project.toLowerCase())
    );
  }

  if (category) {
    result = result.filter(
      (l) => String(l.category || "other").toLowerCase() === category.toLowerCase()
    );
  }

  return result;
}

/**
 * Delete a learning by ID.
 */
export function deleteLearning(id: string): boolean {
  return withStoreLock(() => deleteLearningUnlocked(id));
}

function deleteLearningUnlocked(id: string): boolean {
  const store = loadStore();
  const index = store.learnings.findIndex((l) => l.id === id);
  if (index === -1) return false;
  const removed = store.learnings[index];
  store.learnings.splice(index, 1);
  saveStore(store);
  safeAppend("learning.delete", {
    id: removed.id,
    category: removed.category,
    project: removed.project,
    rule_length: typeof removed.rule === "string" ? removed.rule.length : 0,
  });
  return true;
}

/**
 * Import learnings from a Markdown file.
 * Parses headings and bullet points to extract rules.
 *
 * Supported formats:
 * 1. **Structured Markdown** — H2 = category, H3 = rule, bullet = context
 *    ```md
 *    ## deployment
 *    ### Never docker build | tee
 *    - Pipeline signals kill builds. Use nohup > /tmp/log 2>&1 &
 *    ```
 *
 * 2. **Bullet-list Markdown** — Each bullet with "→" or "—" separator
 *    ```md
 *    - [deployment] Never docker build | tee → Pipeline signals kill builds
 *    ```
 *
 * 3. **JSON array** — Direct Learning[] import
 */
export interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export function importLearningsFromFile(
  filePath: string,
  defaultCategory: string = "other",
  defaultProject?: string,
): ImportResult {
  if (!existsSync(filePath)) {
    return { imported: 0, updated: 0, skipped: 0, errors: [`File not found: ${filePath}`] };
  }

  const content = readFileSync(filePath, "utf-8");
  const ext = filePath.split(".").pop()?.toLowerCase();

  // One load, one save for the whole file. [LOCK] [STORE-NEVER-STARTS-FRESH-OVER-DATA]
  const result = withStoreBatch(() => ext === "json"
    ? importFromJson(content, defaultProject)
    : importFromMarkdown(content, defaultCategory, defaultProject));

  // Aggregate event correlating the individual learning.save records emitted
  // inside the loop. Useful for compliance attribution: "this batch came from
  // file X".
  safeAppend("learning.import", {
    source: filePath,
    format: ext === "json" ? "json" : "markdown",
    project: defaultProject,
    imported: result.imported,
    updated: result.updated,
    skipped: result.skipped,
    errors: result.errors.length,
  });

  return result;
}

function importFromJson(content: string, defaultProject?: string): ImportResult {
  const result: ImportResult = { imported: 0, updated: 0, skipped: 0, errors: [] };

  try {
    const data = JSON.parse(content);
    const items: any[] = Array.isArray(data)
      ? data
      : data.learnings
        ? data.learnings
        : [];

    for (const item of items) {
      if (!item.rule || !item.category) {
        result.skipped++;
        result.errors.push(`Skipped entry missing rule or category: ${JSON.stringify(item).substring(0, 80)}`);
        continue;
      }
      if (item.rule.trim().length < MIN_RULE_LENGTH) {
        result.skipped++;
        continue;
      }
      const cat = LEARNING_CATEGORIES.includes(item.category) ? item.category : "other";
      const store = loadStore();
      const existing = store.learnings.find(
        (l) => l.category === cat && typeof l.rule === "string" && l.rule.toLowerCase().trim() === item.rule.toLowerCase().trim()
      );
      try {
        saveLearning(cat, item.rule, item.context || "", item.project || defaultProject);
        if (existing) {
          result.updated++;
        } else {
          result.imported++;
        }
      } catch {
        result.skipped++;
      }
    }
  } catch (e: any) {
    result.errors.push(`JSON parse error: ${e.message}`);
  }

  return result;
}

function importFromMarkdown(
  content: string,
  defaultCategory: string,
  defaultProject?: string,
): ImportResult {
  const result: ImportResult = { imported: 0, updated: 0, skipped: 0, errors: [] };
  const lines = content.split("\n");

  let currentCategory = defaultCategory;
  let currentRule = "";
  let currentContext: string[] = [];

  function flushRule(): void {
    if (!currentRule) return;
    // Quality gate: skip rules that are too short (catches junk from headings/bullets)
    if (currentRule.trim().length < MIN_RULE_LENGTH) {
      result.skipped++;
      currentRule = "";
      currentContext = [];
      return;
    }
    const cat = normalizeCategory(currentCategory);
    const ctx = currentContext.join(" ").trim() || `Imported from file`;
    const store = loadStore();
    const existing = store.learnings.find(
      (l) => l.category === cat && typeof l.rule === "string" && l.rule.toLowerCase().trim() === currentRule.toLowerCase().trim()
    );
    try {
      saveLearning(cat, currentRule, ctx, defaultProject);
      if (existing) {
        result.updated++;
      } else {
        result.imported++;
      }
    } catch {
      result.skipped++;
    }
    currentRule = "";
    currentContext = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // H1 — file title, skip
    if (trimmed.startsWith("# ") && !trimmed.startsWith("## ")) continue;

    // H2 — category (e.g., "## deployment" or "## Security & Server Administration")
    if (trimmed.startsWith("## ")) {
      flushRule();
      const heading = trimmed.replace(/^##\s+/, "").toLowerCase().trim();
      currentCategory = heading;
      continue;
    }

    // H3 — rule (e.g., "### Never docker build | tee")
    if (trimmed.startsWith("### ")) {
      flushRule();
      const candidate = trimmed.replace(/^###\s+/, "").trim();
      // Quality filter: skip short headings ("Fix", "UI", "DB")
      if (candidate.length >= MIN_RULE_LENGTH) {
        currentRule = candidate;
      }
      continue;
    }

    // H4+ — sub-rule, treat as context for current rule
    if (trimmed.startsWith("#### ")) {
      if (currentRule) {
        currentContext.push(trimmed.replace(/^####\s+/, "").trim());
      }
      continue;
    }

    // Bullet with inline category: "- [deployment] Rule text → Context"
    const inlineCatMatch = trimmed.match(/^[-*]\s+\[(\w+)\]\s+(.+)/);
    if (inlineCatMatch) {
      flushRule();
      const [, cat, rest] = inlineCatMatch;
      currentCategory = cat;
      // Split on → or — for rule/context separation
      const sepMatch = rest.match(/^(.+?)(?:\s*[→—]\s*|\s+[-–]\s+)(.+)$/);
      if (sepMatch) {
        const candidate = sepMatch[1].trim();
        if (candidate.length >= MIN_RULE_LENGTH) {
          currentRule = candidate;
          currentContext = [sepMatch[2].trim()];
          flushRule();
        }
      } else {
        const candidate = rest.trim();
        if (candidate.length >= MIN_RULE_LENGTH) {
          currentRule = candidate;
          flushRule();
        }
      }
      continue;
    }

    // Table rows: | Pattern | Example | Description |
    const tableMatch = trimmed.match(/^\|\s*\*\*(.+?)\*\*\s*\|(.+)\|(.+)\|/);
    if (tableMatch) {
      flushRule();
      const candidate = tableMatch[1].trim();
      if (candidate.length >= MIN_RULE_LENGTH) {
        currentRule = candidate;
        currentContext = [tableMatch[2].trim() + " — " + tableMatch[3].trim()];
        flushRule();
      }
      continue;
    }

    // Regular bullet — either starts a new rule or adds context to current
    if (trimmed.match(/^[-*]\s+\*\*(.+?)\*\*/)) {
      // Bold-start bullet = likely a rule
      flushRule();
      const boldMatch = trimmed.match(/^[-*]\s+\*\*(.+?)\*\*\s*(.*)$/);
      if (boldMatch) {
        const candidate = boldMatch[1].trim();
        // Quality filter: skip short/single-word headings
        if (candidate.length < MIN_RULE_LENGTH) {
          continue;
        }
        currentRule = candidate;
        if (boldMatch[2]) {
          // Strip leading separators
          currentContext = [boldMatch[2].replace(/^[\s—→:]+/, "").trim()];
        }
      }
      continue;
    }

    // Regular bullet or numbered item — context for current rule
    if ((trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.match(/^\d+\.\s/)) && currentRule) {
      const text = trimmed.replace(/^[-*\d.]+\s+/, "").trim();
      if (text) currentContext.push(text);
      continue;
    }

    // Plain text after a rule heading = context
    if (currentRule && trimmed.length > 10 && !trimmed.startsWith("|") && !trimmed.startsWith("```")) {
      currentContext.push(trimmed);
    }
  }

  flushRule(); // Flush last rule
  return result;
}

/** Infer a category from rule text + context when "other" is provided */
function inferCategory(rule: string, context: string): LearningCategory {
  const text = `${rule} ${context}`.toLowerCase();
  const keywords: Record<string, LearningCategory> = {
    "deploy": "deployment", "rsync": "deployment", "publish": "deployment", "release": "deployment",
    "ci/cd": "devops", "ci cd": "devops", "pipeline": "devops", "github actions": "devops", "docker": "devops",
    "nginx": "infrastructure", "ssl": "infrastructure", "server": "infrastructure", "pm2": "infrastructure", "vps": "infrastructure",
    "api": "api", "endpoint": "api", "rest": "api", "graphql": "api", "webhook": "api",
    "sql": "database", "sqlite": "database", "mysql": "database", "postgres": "database", "query": "database", "migration": "database",
    "react": "frontend", "vue": "frontend", "css": "frontend", "html": "frontend", "dom": "frontend", "component": "frontend", "ui": "frontend",
    "express": "backend", "node": "backend", "flask": "backend", "middleware": "backend",
    "auth": "security", "cors": "security", "xss": "security", "csrf": "security", "helmet": "security", "encrypt": "security", "password": "security",
    "test": "testing", "vitest": "testing", "jest": "testing", "spec": "testing", "assert": "testing",
    "debug": "debugging", "error": "debugging", "stack trace": "debugging", "breakpoint": "debugging", "log": "debugging",
    "npm": "dependencies", "package": "dependencies", "yarn": "dependencies", "pnpm": "dependencies", "version": "dependencies",
    "git": "git", "commit": "git", "branch": "git", "merge": "git", "rebase": "git",
    "perf": "performance", "latency": "performance", "cache": "performance", "optimize": "performance",
    "eslint": "tooling", "lint": "tooling", "prettier": "tooling", "vscode": "tooling", "editor": "tooling",
    "pattern": "architecture", "refactor": "architecture", "module": "architecture", "design": "architecture",
    "ios": "mobile", "android": "mobile", "expo": "mobile", "react native": "mobile",
  };

  for (const [keyword, cat] of Object.entries(keywords)) {
    if (text.includes(keyword)) return cat;
  }
  return "other";
}

/** Map free-form heading text to closest LEARNING_CATEGORIES value */
function normalizeCategory(heading: string): LearningCategory {
  const h = heading.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();

  // Direct match
  for (const cat of LEARNING_CATEGORIES) {
    if (h === cat || h.startsWith(cat)) return cat;
  }

  // Keyword mapping
  const map: Record<string, LearningCategory> = {
    "deploy": "deployment",
    "ci/cd": "devops",
    "ci cd": "devops",
    "pipeline": "devops",
    "docker": "devops",
    "nginx": "infrastructure",
    "server": "infrastructure",
    "hosting": "infrastructure",
    "ssl": "security",
    "cors": "security",
    "auth": "security",
    "malware": "security",
    "hack": "security",
    "hardening": "security",
    "terminal": "tooling",
    "command": "tooling",
    "monitoring": "tooling",
    "vs code": "tooling",
    "test": "testing",
    "jest": "testing",
    "spec": "testing",
    "debug": "debugging",
    "bug": "debugging",
    "fix": "debugging",
    "react": "frontend",
    "vue": "frontend",
    "css": "frontend",
    "ui": "frontend",
    "laravel": "backend",
    "django": "backend",
    "flask": "backend",
    "express": "backend",
    "mysql": "database",
    "postgres": "database",
    "sql": "database",
    "migration": "database",
    "npm": "dependencies",
    "composer": "dependencies",
    "pip": "dependencies",
    "package": "dependencies",
    "git": "git",
    "commit": "git",
    "branch": "git",
    "hook": "git",
    "perf": "performance",
    "speed": "performance",
    "cache": "performance",
    "mobile": "mobile",
    "expo": "mobile",
    "flutter": "mobile",
    "react native": "mobile",
    "swift": "mobile",
    "pattern": "architecture",
    "design": "architecture",
    "struct": "architecture",
    "data type": "data",
    "csv": "data",
    "import": "data",
    "export": "data",
    "api": "api",
    "endpoint": "api",
    "rest": "api",
    "smtp": "infrastructure",
    "email": "infrastructure",
    "queue": "infrastructure",
    "audit": "security",
    "version": "dependencies",
    "upgrade": "dependencies",
  };

  for (const [keyword, cat] of Object.entries(map)) {
    if (h.includes(keyword)) return cat;
  }

  return "other";
}

/**
 * Convert learnings to Chunks so they can be included in search_context.
 * This is the key integration — learnings auto-surface in hybrid search.
 *
 * When `projects` is provided, only includes learnings for those projects
 * (+ universal learnings with no project). This prevents cross-project
 * IP leakage — CROWLR secrets won't appear when searching in VOILA.
 */
export function learningsToChunks(projects?: string[]): Chunk[] {
  const store = loadStore();
  let learnings = store.learnings;

  if (projects && projects.length > 0) {
    const lowerProjects = projects.map((p) => p.toLowerCase());
    learnings = learnings.filter(
      (l) => !l.project || lowerProjects.includes(l.project.toLowerCase())
    );
  }

  return learnings.map((l) => ({
    source: "💡 Learnings Store",
    section: `[${l.category}] ${l.rule}`,
    content: [
      `**Rule:** ${l.rule}`,
      `**Category:** ${l.category}`,
      l.project ? `**Project:** ${l.project}` : "",
      l.context ? `**Context:** ${l.context}` : "",
      l.tags?.length ? `**Tags:** ${l.tags.join(", ")}` : "",
      l.created ? `_Learned: ${l.created.split("T")[0]}_` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    lineStart: 0,
    lineEnd: 0,
  }));
}

/**
 * Auto-import learnings from discovered knowledge source files.
 *
 * Called during reindex — scans all source markdown files and extracts
 * rules into the permanent learning store. Deduplication is built-in,
 * so calling repeatedly on the same files is safe (no duplicates).
 *
 * This ensures documentation rules become searchable learnings without
 * requiring the user or agent to manually trigger `import_learnings`.
 */
export function autoImportFromSources(
  sources: Array<{ path: string; name: string }>,
): { total: number; imported: number; updated: number } {
  let totalImported = 0;
  let totalUpdated = 0;
  let processed = 0;

  // One load and one save for the whole sweep (~880 files), instead of one full-file
  // rewrite per rule per file. [LOCK] [STORE-NEVER-STARTS-FRESH-OVER-DATA]
  withStoreBatch(() => {
  for (const source of sources) {
    // Only process markdown files
    if (!source.path.endsWith(".md")) continue;
    if (!existsSync(source.path)) continue;

    // Extract project name from source name (e.g., "ContextEngine — copilot-instructions.md")
    const project = source.name.split(" — ")[0]?.trim() || undefined;

    const result = importLearningsFromFile(source.path, "other", project);
    totalImported += result.imported;
    totalUpdated += result.updated;
    if (result.imported > 0 || result.updated > 0) processed++;
  }
  });

  return { total: processed, imported: totalImported, updated: totalUpdated };
}

/**
 * Get the store stats.
 */
export function learningsStats(): { total: number; categories: Record<string, number> } {  const store = loadStore();
  const categories: Record<string, number> = {};
  for (const l of store.learnings) {
    categories[l.category] = (categories[l.category] || 0) + 1;
  }
  return { total: store.learnings.length, categories };
}

/**
 * Format learnings for display.
 */
// [LOCKED] [LEARNINGS-LIST-SHOWS-CREATED] 2026-09-05
// [NEVER] print a learning without its `created` instant, and [NEVER] answer "what was
//         saved since X" by probing learnings.json with a hand-written key.
// WHY: on 2026-09-05 an agent read a date field the records do not have (`createdAt`),
//      got an empty string for every record, and answered "0 saved today" with full
//      confidence; a second agent made the same mistake the same morning. A probe on a
//      missing key returns a confident zero, never an error. The store had 22 records
//      from that day, under `created`. Until then the listing showed the date only,
//      so "today" was also ambiguous around midnight between UTC and Yan's clock.
// FIX: one renderer shows `created` as the UTC instant plus the Europe/Zurich wall
//      time, and `--since today|yesterday|ISO` is a first-class filter whose empty
//      result names the boundary it applied. An unparseable spec is an error, not zero.
export const LEARNINGS_LOCAL_TZ = "Europe/Zurich";

/** `2026-09-05 10:30Z (12:30 CEST)`; `undated` when the record carries no usable instant. */
export function formatLearnedAt(iso: string | undefined, tz: string = LEARNINGS_LOCAL_TZ): string {
  if (!iso) return "undated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "undated";
  const utc = d.toISOString().slice(0, 16).replace("T", " ") + "Z";
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short",
  }).format(d);
  return `${utc} (${local})`;
}

/** Midnight of the given calendar day in `tz`, as a UTC instant. Offset read from Intl, never guessed. */
function localMidnightUtc(y: number, m: number, d: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const off = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(guess).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const mm = /GMT([+-])(\d{2}):(\d{2})/.exec(off);
  const minutes = mm ? (mm[1] === "-" ? -1 : 1) * (parseInt(mm[2], 10) * 60 + parseInt(mm[3], 10)) : 0;
  return new Date(guess.getTime() - minutes * 60_000);
}

/** `today` | `yesterday` (calendar days in `tz`) | any ISO date or instant. `null` when unparseable. */
export function parseSince(spec: string, now: Date = new Date(), tz: string = LEARNINGS_LOCAL_TZ): Date | null {
  const s = spec.trim().toLowerCase();
  if (s === "today" || s === "yesterday") {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now);
    const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
    const midnight = localMidnightUtc(get("year"), get("month"), get("day"), tz);
    return s === "today" ? midnight : new Date(midnight.getTime() - 86_400_000);
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(spec.trim())) return null;
  const d = new Date(spec.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Records created at or after `since`, oldest first. Undated records are excluded and counted by the caller. */
export function filterSince(learnings: Learning[], since: Date): Learning[] {
  return learnings
    .filter((l) => l.created && !Number.isNaN(new Date(l.created).getTime()) && new Date(l.created).getTime() >= since.getTime())
    .sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());
}

export interface FormatLearningsOptions {
  /** Already-parsed boundary; the caller resolves the spec so an invalid one errors before rendering. */
  since?: Date;
  /** The spec as typed, echoed in the header so the reader sees which boundary applied. */
  sinceSpec?: string;
}

export function formatLearnings(learnings: Learning[], opts: FormatLearningsOptions = {}): string {
  let sinceNote = "";
  if (opts.since) {
    learnings = filterSince(learnings, opts.since);
    sinceNote = ` since ${opts.sinceSpec ?? opts.since.toISOString()} = ${formatLearnedAt(opts.since.toISOString())}`;
  }
  if (learnings.length === 0) {
    if (opts.since) {
      return `0 learnings${sinceNote}. The boundary above is the one that was applied; if that looks wrong, the store is at ~/.contextengine/learnings.json and its date field is \`created\`.`;
    }
    return "No learnings stored yet. Use `save_learning` to add operational rules.";
  }

  const lines: string[] = [];
  lines.push(`# 💡 Learnings Store (${learnings.length} rules${sinceNote})\n`);

  // Group by category
  const byCategory = new Map<string, Learning[]>();
  for (const l of learnings) {
    const list = byCategory.get(l.category) || [];
    list.push(l);
    byCategory.set(l.category, list);
  }

  for (const [category, items] of byCategory) {
    lines.push(`## ${category} (${items.length})\n`);
    for (const l of items) {
      lines.push(`### ${l.rule}`);
      lines.push(`- **ID:** \`${l.id}\``);
      if (l.project) lines.push(`- **Project:** ${l.project}`);
      if (l.context) lines.push(`- **Context:** ${l.context}`);
      if (l.tags?.length) lines.push(`- **Tags:** ${l.tags.join(", ")}`);
      lines.push(`- **Learned:** ${formatLearnedAt(l.created)}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

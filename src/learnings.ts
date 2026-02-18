import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { Chunk } from "./ingest.js";

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

const LEARNINGS_PATH = join(homedir(), ".contextengine", "learnings.json");

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
    store.learnings.map((l) => l.rule.toLowerCase().trim())
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

function loadStore(): LearningsStore {
  let store: LearningsStore;
  if (existsSync(LEARNINGS_PATH)) {
    try {
      store = JSON.parse(readFileSync(LEARNINGS_PATH, "utf-8"));
    } catch {
      // Corrupted file — start fresh
      store = { version: 1, count: 0, learnings: [] };
    }
  } else {
    store = { version: 1, count: 0, learnings: [] };
  }

  // Auto-merge bundled defaults on first load or when new defaults are added
  if (mergeDefaults(store)) {
    saveStore(store);
  }

  return store;
}

function saveStore(store: LearningsStore): void {
  ensureDir();
  store.count = store.learnings.length;
  writeFileSync(LEARNINGS_PATH, JSON.stringify(store, null, 2));
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

/**
 * Save a new learning. Returns the created learning with ID.
 */
export function saveLearning(
  category: string,
  rule: string,
  context: string,
  project?: string
): Learning {
  const store = loadStore();
  const now = new Date().toISOString();

  // Check for duplicate rules (fuzzy: same category + similar rule text)
  const ruleLower = rule.toLowerCase().trim();
  const existing = store.learnings.find(
    (l) =>
      l.category === category &&
      l.rule.toLowerCase().trim() === ruleLower
  );

  if (existing) {
    // Update existing learning with new context
    existing.context = context;
    existing.updated = now;
    if (project) existing.project = project;
    existing.tags = extractTags(existing.rule, context, category);
    saveStore(store);
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
        if (learning.rule.toLowerCase().includes(token)) score += 2;
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
 * Get all learnings, optionally filtered by category.
 */
export function listLearnings(category?: string): Learning[] {
  const store = loadStore();
  if (category) {
    return store.learnings.filter(
      (l) => l.category.toLowerCase() === category.toLowerCase()
    );
  }
  return store.learnings;
}

/**
 * Delete a learning by ID.
 */
export function deleteLearning(id: string): boolean {
  const store = loadStore();
  const index = store.learnings.findIndex((l) => l.id === id);
  if (index === -1) return false;
  store.learnings.splice(index, 1);
  saveStore(store);
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

  if (ext === "json") {
    return importFromJson(content, defaultProject);
  }
  return importFromMarkdown(content, defaultCategory, defaultProject);
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
      const cat = LEARNING_CATEGORIES.includes(item.category) ? item.category : "other";
      const store = loadStore();
      const existing = store.learnings.find(
        (l) => l.category === cat && l.rule.toLowerCase().trim() === item.rule.toLowerCase().trim()
      );
      saveLearning(cat, item.rule, item.context || "", item.project || defaultProject);
      if (existing) {
        result.updated++;
      } else {
        result.imported++;
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
    const cat = normalizeCategory(currentCategory);
    const ctx = currentContext.join(" ").trim() || `Imported from file`;
    const store = loadStore();
    const existing = store.learnings.find(
      (l) => l.category === cat && l.rule.toLowerCase().trim() === currentRule.toLowerCase().trim()
    );
    saveLearning(cat, currentRule, ctx, defaultProject);
    if (existing) {
      result.updated++;
    } else {
      result.imported++;
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
      currentRule = trimmed.replace(/^###\s+/, "").trim();
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
        currentRule = sepMatch[1].trim();
        currentContext = [sepMatch[2].trim()];
        flushRule();
      } else {
        currentRule = rest.trim();
        flushRule();
      }
      continue;
    }

    // Table rows: | Pattern | Example | Description |
    const tableMatch = trimmed.match(/^\|\s*\*\*(.+?)\*\*\s*\|(.+)\|(.+)\|/);
    if (tableMatch) {
      flushRule();
      currentRule = tableMatch[1].trim();
      currentContext = [tableMatch[2].trim() + " — " + tableMatch[3].trim()];
      flushRule();
      continue;
    }

    // Regular bullet — either starts a new rule or adds context to current
    if (trimmed.match(/^[-*]\s+\*\*(.+?)\*\*/)) {
      // Bold-start bullet = likely a rule
      flushRule();
      const boldMatch = trimmed.match(/^[-*]\s+\*\*(.+?)\*\*\s*(.*)$/);
      if (boldMatch) {
        currentRule = boldMatch[1].trim();
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
 */
export function learningsToChunks(): Chunk[] {
  const store = loadStore();
  return store.learnings.map((l) => ({
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
 * Get the store stats.
 */
export function learningsStats(): { total: number; categories: Record<string, number> } {
  const store = loadStore();
  const categories: Record<string, number> = {};
  for (const l of store.learnings) {
    categories[l.category] = (categories[l.category] || 0) + 1;
  }
  return { total: store.learnings.length, categories };
}

/**
 * Format learnings for display.
 */
export function formatLearnings(learnings: Learning[]): string {
  if (learnings.length === 0) {
    return "No learnings stored yet. Use `save_learning` to add operational rules.";
  }

  const lines: string[] = [];
  lines.push(`# 💡 Learnings Store (${learnings.length} rules)\n`);

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
      if (l.created) lines.push(`- **Learned:** ${l.created.split("T")[0]}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

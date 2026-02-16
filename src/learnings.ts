import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Chunk } from "./ingest.js";

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

function loadStore(): LearningsStore {
  if (existsSync(LEARNINGS_PATH)) {
    try {
      return JSON.parse(readFileSync(LEARNINGS_PATH, "utf-8"));
    } catch {
      // Corrupted file — start fresh
    }
  }
  return { version: 1, count: 0, learnings: [] };
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
      `**Context:** ${l.context}`,
      `**Tags:** ${l.tags.join(", ")}`,
      `_Learned: ${l.created.split("T")[0]}_`,
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
      lines.push(`- **Context:** ${l.context}`);
      lines.push(`- **Tags:** ${l.tags.join(", ")}`);
      lines.push(`- **Learned:** ${l.created.split("T")[0]}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

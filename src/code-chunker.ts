import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, extname, basename, relative } from "path";
import type { Chunk } from "./ingest.js";

/**
 * Code Chunker — parse TS/JS/Python files into function/class/method chunks.
 *
 * Uses regex-based parsing (no AST dependency) to extract:
 * - Functions (regular, arrow, async)
 * - Classes and their methods
 * - Interfaces and type aliases (TS)
 * - Python def/class/async def
 *
 * Each chunk includes the full function body with enough context
 * for semantic search to work well.
 */

const CODE_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".py"]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage",
  "__pycache__", ".venv", "venv", ".next", ".cache",
]);

// ---------------------------------------------------------------------------
// TypeScript / JavaScript parser (regex-based)
// ---------------------------------------------------------------------------

interface CodeBlock {
  kind: string; // "function" | "class" | "interface" | "type" | "method"
  name: string;
  lineStart: number;
  lineEnd: number;
  content: string;
}

/**
 * Find the matching closing brace for an opening brace at position `start`.
 */
function findClosingBrace(text: string, start: number): number {
  let depth = 0;
  let inString: string | null = null;
  let inTemplate = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : "";

    // Skip escaped characters
    if (prev === "\\") continue;

    // String tracking
    if (!inString && !inTemplate) {
      if (ch === '"' || ch === "'" || ch === "`") {
        if (ch === "`") inTemplate = true;
        else inString = ch;
        continue;
      }
    } else if (inString && ch === inString && prev !== "\\") {
      inString = null;
      continue;
    } else if (inTemplate && ch === "`" && prev !== "\\") {
      inTemplate = false;
      continue;
    } else {
      continue; // inside string, skip
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1; // unmatched
}

/**
 * Parse a TypeScript/JavaScript file into code blocks.
 */
function parseTSJS(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = text.split("\n");

  // Build line-offset map for position → line number conversion
  const lineOffsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(lineOffsets[i] + lines[i].length + 1);
  }

  function posToLine(pos: number): number {
    for (let i = 0; i < lineOffsets.length - 1; i++) {
      if (pos < lineOffsets[i + 1]) return i + 1;
    }
    return lines.length;
  }

  // Patterns for top-level declarations
  const patterns: Array<{ regex: RegExp; kind: string }> = [
    // export function / async function / function
    { regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g, kind: "function" },
    // export const name = (...) => (arrow functions)
    { regex: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/g, kind: "function" },
    // export class / class
    { regex: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g, kind: "class" },
    // export interface
    { regex: /(?:export\s+)?interface\s+(\w+)/g, kind: "interface" },
    // export type (block types only, not simple aliases)
    { regex: /(?:export\s+)?type\s+(\w+)\s*=\s*\{/g, kind: "type" },
  ];

  for (const { regex, kind } of patterns) {
    let match;
    regex.lastIndex = 0;

    while ((match = regex.exec(text)) !== null) {
      const name = match[1];
      const matchStart = match.index;
      const lineStart = posToLine(matchStart);

      // Find the opening brace after the match
      const braceStart = text.indexOf("{", match.index + match[0].length);
      if (braceStart === -1) continue;

      // Check it's not too far (within 200 chars — accounts for type annotations)
      if (braceStart - (match.index + match[0].length) > 200) continue;

      const braceEnd = findClosingBrace(text, braceStart);
      if (braceEnd === -1) continue;

      const lineEnd = posToLine(braceEnd);
      const content = text.slice(matchStart, braceEnd + 1);

      // Skip tiny blocks (less than 2 lines of real content)
      if (lineEnd - lineStart < 2) continue;

      blocks.push({ kind, name, lineStart, lineEnd, content });
    }
  }

  // Deduplicate overlapping blocks (keep the outer one)
  blocks.sort((a, b) => a.lineStart - b.lineStart);
  const result: CodeBlock[] = [];
  for (const block of blocks) {
    const last = result[result.length - 1];
    if (last && block.lineStart >= last.lineStart && block.lineEnd <= last.lineEnd) {
      // This block is inside the last one — skip (it's a method inside a class)
      continue;
    }
    result.push(block);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Python parser (regex-based)
// ---------------------------------------------------------------------------

/**
 * Parse a Python file into function/class blocks using indentation.
 */
function parsePython(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match def/async def/class at module level (no leading whitespace)
    const funcMatch = line.match(/^(async\s+)?def\s+(\w+)\s*\(/);
    const classMatch = line.match(/^class\s+(\w+)/);

    if (funcMatch || classMatch) {
      const kind = classMatch ? "class" : "function";
      const name = classMatch ? classMatch[1] : funcMatch![2];
      const lineStart = i + 1; // 1-based

      // Find end of block by indentation
      let lineEnd = i + 1;
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        // Empty lines don't end blocks
        if (nextLine.trim() === "") {
          lineEnd = j + 1;
          continue;
        }
        // Non-indented non-empty line = end of block
        if (!nextLine.match(/^\s/)) break;
        lineEnd = j + 1;
      }

      const content = lines.slice(i, lineEnd).join("\n");

      // Skip tiny blocks
      if (lineEnd - lineStart < 2) continue;

      blocks.push({ kind, name, lineStart, lineEnd, content });
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a single code file into Chunks.
 */
export function parseCodeFile(
  filePath: string,
  sourceName: string
): Chunk[] {
  const ext = extname(filePath).toLowerCase();
  const text = readFileSync(filePath, "utf-8");

  let blocks: CodeBlock[];
  if (ext === ".py") {
    blocks = parsePython(text);
  } else {
    blocks = parseTSJS(text);
  }

  // If no blocks found, create a single chunk for the whole file
  // (but only if it's not too large)
  if (blocks.length === 0) {
    const lines = text.split("\n");
    if (lines.length <= 200 && text.trim().length > 0) {
      return [{
        source: sourceName,
        section: `${basename(filePath)} (entire file)`,
        content: text,
        lineStart: 1,
        lineEnd: lines.length,
      }];
    }
    return [];
  }

  return blocks.map((b) => ({
    source: sourceName,
    section: `${basename(filePath)} > ${b.kind} ${b.name}`,
    content: b.content,
    lineStart: b.lineStart,
    lineEnd: b.lineEnd,
  }));
}

/**
 * Scan a directory for code files and parse them all.
 * Scans recursively but respects SKIP_DIRS.
 * Returns chunks with source set to `projectName/relative/path.ts`.
 */
export function scanCodeDir(
  dirPath: string,
  projectName: string,
  maxDepth: number = 3
): Chunk[] {
  const allChunks: Chunk[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (SKIP_DIRS.has(entry)) continue;

      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full, depth + 1);
        } else if (stat.isFile() && CODE_EXTENSIONS.has(extname(entry).toLowerCase())) {
          // Skip test files, config files, and very large files
          if (entry.includes(".test.") || entry.includes(".spec.")) continue;
          if (entry === "jest.config.js" || entry === "webpack.config.js") continue;
          if (stat.size > 100_000) continue; // skip files > 100KB

          const relPath = relative(dirPath, full);
          const sourceName = `${projectName}/${relPath}`;
          const chunks = parseCodeFile(full, sourceName);
          allChunks.push(...chunks);
        }
      } catch {
        continue;
      }
    }
  }

  walk(dirPath, 0);
  return allChunks;
}

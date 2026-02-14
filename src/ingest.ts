import { readFileSync, existsSync } from "fs";
import { basename } from "path";
import { KnowledgeSource } from "./config.js";

/**
 * A chunk of text extracted from a knowledge source,
 * suitable for embedding or keyword search.
 */
export interface Chunk {
  /** Which source file this came from */
  source: string;
  /** Section heading path (e.g. "## Architecture > ### Docker") */
  section: string;
  /** The actual text content */
  content: string;
  /** Starting line number in the original file (1-based) */
  lineStart: number;
  /** Ending line number in the original file (1-based) */
  lineEnd: number;
}

/**
 * Parse a markdown file into chunks, splitting on headings.
 * Each chunk captures the heading hierarchy for context.
 */
function parseMarkdown(filePath: string, sourceName: string): Chunk[] {
  const text = readFileSync(filePath, "utf-8");
  const lines = text.split("\n");
  const chunks: Chunk[] = [];

  // Track heading hierarchy
  const headingStack: string[] = [];
  let currentContent: string[] = [];
  let chunkStartLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

    if (headingMatch) {
      // Flush previous chunk
      if (currentContent.length > 0) {
        const content = currentContent.join("\n").trim();
        if (content.length > 0) {
          chunks.push({
            source: sourceName,
            section: headingStack.join(" > ") || basename(filePath),
            content,
            lineStart: chunkStartLine,
            lineEnd: i, // line before this heading
          });
        }
      }

      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      // Pop headings at same or deeper level
      while (headingStack.length >= level) {
        headingStack.pop();
      }
      headingStack.push(`${"#".repeat(level)} ${title}`);

      currentContent = [];
      chunkStartLine = i + 1; // 1-based
    } else {
      currentContent.push(line);
    }
  }

  // Flush last chunk
  if (currentContent.length > 0) {
    const content = currentContent.join("\n").trim();
    if (content.length > 0) {
      chunks.push({
        source: sourceName,
        section: headingStack.join(" > ") || basename(filePath),
        content,
        lineStart: chunkStartLine,
        lineEnd: lines.length,
      });
    }
  }

  return chunks;
}

/**
 * Ingest all configured knowledge sources into chunks.
 * Skips files that don't exist (with a warning to stderr).
 */
export function ingestSources(sources: KnowledgeSource[]): Chunk[] {
  const allChunks: Chunk[] = [];

  for (const source of sources) {
    if (!existsSync(source.path)) {
      console.error(`[ContextEngine] ⚠ Skipping missing: ${source.path}`);
      continue;
    }

    const chunks = parseMarkdown(source.path, source.name);
    allChunks.push(...chunks);
    console.error(
      `[ContextEngine] ✅ Indexed: ${source.name} (${chunks.length} chunks)`
    );
  }

  console.error(
    `[ContextEngine] 📦 Total: ${allChunks.length} chunks from ${sources.length} sources`
  );
  return allChunks;
}

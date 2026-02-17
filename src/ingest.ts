import { readFileSync, existsSync, statSync } from "fs";
import { basename } from "path";
import { createHash } from "crypto";
import { KnowledgeSource } from "./config.js";

/**
 * Number of overlap lines to carry over from the end of the previous chunk
 * to the beginning of the next chunk. Provides context continuity at
 * section boundaries (inspired by OpenClaw's 80-token overlap strategy).
 */
const OVERLAP_LINES = 4;

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
  /** SHA-256 hash of content for deduplication */
  contentHash?: string;
  /** Timestamp when chunk was indexed (ISO string) */
  indexedAt?: string;
}

/**
 * Compute SHA-256 hash of a string for content deduplication.
 */
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Parse a markdown file into chunks, splitting on headings.
 * Each chunk captures the heading hierarchy for context.
 *
 * v1.10: Adds overlap lines from the end of each chunk to the start
 * of the next chunk, providing context continuity at heading boundaries.
 * Also computes SHA-256 content hashes for deduplication.
 */
function parseMarkdown(filePath: string, sourceName: string): Chunk[] {
  let mtime: string | undefined;
  try {
    mtime = statSync(filePath).mtime.toISOString();
  } catch {
    mtime = new Date().toISOString();
  }

  const text = readFileSync(filePath, "utf-8");
  const lines = text.split("\n");
  const rawChunks: Array<{
    section: string;
    contentLines: string[];
    startLine: number;
    endLine: number;
  }> = [];

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
          rawChunks.push({
            section: headingStack.join(" > ") || basename(filePath),
            contentLines: [...currentContent],
            startLine: chunkStartLine,
            endLine: i,
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
      rawChunks.push({
        section: headingStack.join(" > ") || basename(filePath),
        contentLines: [...currentContent],
        startLine: chunkStartLine,
        endLine: lines.length,
      });
    }
  }

  // Build final chunks with overlap
  const chunks: Chunk[] = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const raw = rawChunks[i];
    let finalLines = raw.contentLines;

    // Add overlap from previous chunk's tail (if not the first chunk)
    if (i > 0 && OVERLAP_LINES > 0) {
      const prevLines = rawChunks[i - 1].contentLines;
      const overlapCount = Math.min(OVERLAP_LINES, prevLines.length);
      const overlap = prevLines.slice(-overlapCount);
      finalLines = [...overlap, "---", ...raw.contentLines];
    }

    const content = finalLines.join("\n").trim();
    if (content.length > 0) {
      chunks.push({
        source: sourceName,
        section: raw.section,
        content,
        lineStart: raw.startLine,
        lineEnd: raw.endLine,
        contentHash: hashContent(content),
        indexedAt: mtime,
      });
    }
  }

  return chunks;
}

/**
 * Ingest all configured knowledge sources into chunks.
 * Skips files that don't exist (with a warning to stderr).
 * Deduplicates chunks by content hash.
 */
export function ingestSources(sources: KnowledgeSource[]): Chunk[] {
  const allChunks: Chunk[] = [];
  const seenHashes = new Set<string>();
  let dupCount = 0;

  for (const source of sources) {
    if (!existsSync(source.path)) {
      console.error(`[ContextEngine] ⚠ Skipping missing: ${source.path}`);
      continue;
    }

    const chunks = parseMarkdown(source.path, source.name);
    for (const chunk of chunks) {
      if (chunk.contentHash && seenHashes.has(chunk.contentHash)) {
        dupCount++;
        continue;
      }
      if (chunk.contentHash) seenHashes.add(chunk.contentHash);
      allChunks.push(chunk);
    }
    const accepted = chunks.length - (dupCount > 0 ? dupCount : 0);
    console.error(
      `[ContextEngine] ✅ Indexed: ${source.name} (${chunks.length} chunks)`
    );
  }

  if (dupCount > 0) {
    console.error(
      `[ContextEngine] 🔁 Deduplicated: ${dupCount} duplicate chunks removed`
    );
  }

  console.error(
    `[ContextEngine] 📦 Total: ${allChunks.length} chunks from ${sources.length} sources`
  );
  return allChunks;
}

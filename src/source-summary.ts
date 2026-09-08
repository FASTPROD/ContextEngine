/**
 * One-line summary per knowledge source, for list_sources (MCP) and
 * `contextengine list-sources` (CLI).
 *
 * Why: with 800+ sources, an agent reading a bare name plus a path opens two
 * or three files to find the right one. Each open puts a whole document into
 * its context (see CLAUDE.md, multi-agent cost). A summary line derived from
 * the first few KB of the file lets it pick once.
 *
 * Reads only the head of the file (HEAD_BYTES), never the whole document, so
 * the cost is bounded no matter how many sources are configured.
 */
import { openSync, readSync, closeSync } from "fs";
import type { KnowledgeSource } from "./config.js";

export const HEAD_BYTES = 4096;
export const SUMMARY_MAX = 110;

/** Read at most `bytes` from the start of a file. Empty string on any error. */
export function readHead(path: string, bytes: number = HEAD_BYTES): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Summary for a configured source; "" when the file is unreadable or says nothing. */
export function summarizeSource(source: KnowledgeSource): string {
  return summarizeText(readHead(source.path), source.type);
}

export function summarizeText(text: string, type: "markdown" | "code"): string {
  if (!text) return "";
  return clip(type === "code" ? summarizeCode(text) : summarizeMarkdown(text));
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= SUMMARY_MAX) return one;
  return one.slice(0, SUMMARY_MAX - 3).trimEnd() + "...";
}

/** Strip markdown decoration so the line reads as plain text. */
function plain(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")          // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")        // links -> text
    .replace(/`([^`]*)`/g, "$1")                    // inline code
    .replace(/\*\*|__/g, "")                        // bold
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")        // list bullet
    .replace(/^\s*>\s?/, "")                        // blockquote
    .trim();
}

/** Header metadata lines that say nothing about the content. */
const META_LINE = /^(updated|last updated|created|date|status|author|owner|version|scope|audience)\b\s*[:\-]/i;

function summarizeMarkdown(text: string): string {
  let body = text;
  // YAML frontmatter: prefer its description, it IS a one-line summary.
  if (body.startsWith("---\n") || body.startsWith("---\r\n")) {
    const end = body.indexOf("\n---", 4);
    if (end !== -1) {
      const fm = body.slice(4, end);
      const desc = fm.match(/^description:\s*(.+)$/m);
      if (desc) return desc[1].trim().replace(/^["']|["']$/g, "");
      body = body.slice(end + 4);
    }
  }
  let title = "";
  let prose = "";
  let inFence = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) { inFence = !inFence; continue; }
    if (inFence || !line) continue;
    if (line.startsWith("<!--") || line.startsWith("|") || line.startsWith("![") || line.startsWith("[!")) continue;
    if (/^[-=*_]{3,}$/.test(line)) continue;
    if (line.startsWith("#")) {
      if (!title) title = plain(line.replace(/^#+\s*/, ""));
      continue;
    }
    const p = plain(line);
    if (p.length < 12) continue;                       // lone dates, "v2.1", etc.
    if (META_LINE.test(p)) continue;                   // "Updated: 2026-03-13", "Status: draft"
    prose = p;
    break;
  }
  if (title && prose) return `${title}: ${prose}`;
  return title || prose;
}

const CODE_SKIP = /^(#!|\/\/\s*eslint|\/\*\s*eslint|@ts-|#\s*-\*-|#\s*coding[:=]|SPDX|Copyright|\[LOCK|\[LOCKED\]|\[NEVER\]|WHY:|FIX:|import |from |export |const |let |var |use strict|"use strict")/i;

function summarizeCode(text: string): string {
  const lines = text.split("\n");
  let inBlock = false;
  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    if (!inBlock) {
      const opensBlock = line.startsWith("/*") || line.startsWith('"""') || line.startsWith("'''");
      const closesOnSameLine =
        (line.startsWith("/*") && /\*\/$/.test(line)) ||
        (/^("""|''')/.test(line) && line.length > 3 && /("""|''')$/.test(line));
      if (CODE_SKIP.test(line)) {
        // Pragma, shebang or marker on the raw line: skip it. A one-line
        // block comment ("/* eslint-disable */") must not leave us in a block.
        if (opensBlock && !closesOnSameLine) inBlock = true;
        continue;
      }
      if (opensBlock) {
        inBlock = !closesOnSameLine;
        line = line.replace(/^(\/\*+|"""|''')\s*/, "").replace(/(\*\/|"""|''')\s*$/, "").trim();
      } else if (line.startsWith("//") || line.startsWith("#")) {
        line = line.replace(/^(\/\/|#)+\s*/, "").trim();
      } else {
        // Code before any comment: nothing worth saying about this file.
        return "";
      }
    } else {
      if (/(\*\/|"""|''')$/.test(line)) inBlock = false;
      line = line.replace(/^\*+\s*/, "").replace(/(\*\/|"""|''')\s*$/, "").trim();
    }
    if (!line || /^[-=*_#]{3,}$/.test(line) || CODE_SKIP.test(line)) continue;
    if (line.length < 12) continue;
    return line;
  }
  return "";
}

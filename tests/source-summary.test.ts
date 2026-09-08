import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { summarizeText, summarizeSource, readHead, SUMMARY_MAX, HEAD_BYTES } from "../src/source-summary.js";

describe("summarizeText markdown", () => {
  it("uses the frontmatter description when present", () => {
    const md = `---\nname: x\ndescription: "crowlr2 IPv6 is XBL-listed; SMTP forced to IPv4"\ntype: project\n---\n\n# Ignored title\n\nIgnored body.`;
    expect(summarizeText(md, "markdown")).toBe("crowlr2 IPv6 is XBL-listed; SMTP forced to IPv4");
  });

  it("joins the H1 title and the first prose line, stripping decoration", () => {
    const md = `<!-- generated -->\n# CLAUDE.md — ContextEngine\n\n![badge](x.png)\n[![ci](y)](z)\n\n| a | b |\n|---|---|\n\n\`\`\`bash\nnpm run build\n\`\`\`\n\n**MCP** server that indexes [docs](d) into a \`searchable\` base.\n\nSecond paragraph.`;
    expect(summarizeText(md, "markdown")).toBe(
      "CLAUDE.md — ContextEngine: MCP server that indexes docs into a searchable base."
    );
  });

  it("skips short lines such as lone dates and keeps the first real sentence", () => {
    const md = `# Session 26\n\n2026-09-05\n\n- Closed the single indexer work and shipped 2.8.0 to npm.`;
    expect(summarizeText(md, "markdown")).toBe(
      "Session 26: Closed the single indexer work and shipped 2.8.0 to npm."
    );
  });

  it("skips header metadata lines such as Updated: and Status:", () => {
    const md = `# FASTPROD Skills\n\nUpdated: March 13, 2026\nStatus: living document\n\nInventory of the stack and the skills each part needs.`;
    expect(summarizeText(md, "markdown")).toBe(
      "FASTPROD Skills: Inventory of the stack and the skills each part needs."
    );
  });

  it("falls back to the title alone, and to empty for an empty file", () => {
    expect(summarizeText("# Only a title\n", "markdown")).toBe("Only a title");
    expect(summarizeText("", "markdown")).toBe("");
    expect(summarizeText("\n\n   \n", "markdown")).toBe("");
  });

  it("clips at SUMMARY_MAX with an ASCII ellipsis and collapses whitespace", () => {
    const long = "# T\n\n" + "word ".repeat(60);
    const out = summarizeText(long, "markdown");
    expect(out.length).toBe(SUMMARY_MAX);
    expect(out.endsWith("...")).toBe(true);
    expect(out).not.toMatch(/\s{2,}/);
  });
});

describe("summarizeText code", () => {
  it("reads a python module docstring", () => {
    const py = `#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n"""\nGenerate P10/P50/P90 uncertainty bands for forecasts using residual bootstrap.\n\nMore detail.\n"""\nimport numpy as np\n`;
    expect(summarizeText(py, "code")).toBe(
      "Generate P10/P50/P90 uncertainty bands for forecasts using residual bootstrap."
    );
  });

  it("reads a JSDoc header and skips separators, LOCK markers and eslint pragmas", () => {
    const ts = `/* eslint-disable no-console */\n/**\n * ---------------------------------\n * [LOCKED] [X] — 2026-01-01\n * [NEVER] do the thing\n * Hash-chained audit log writer for OpsContext.\n */\nexport function x() {}\n`;
    expect(summarizeText(ts, "code")).toBe("Hash-chained audit log writer for OpsContext.");
  });

  it("returns empty when the file starts with code and has no header comment", () => {
    const ts = `import { a } from "./a.js";\nexport const b = 1;\nfunction c() {}\n`;
    expect(summarizeText(ts, "code")).toBe("");
  });

  it("accepts line comments", () => {
    expect(summarizeText(`// Shared core analytic + MC + tuning algorithms\nconst a = 1;`, "code"))
      .toBe("Shared core analytic + MC + tuning algorithms");
  });
});

describe("readHead and summarizeSource", () => {
  it("reads only HEAD_BYTES of a large file and summarises it", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-summary-"));
    const p = join(dir, "big.md");
    writeFileSync(p, "# Big doc\n\nFirst line of the body that is long enough.\n" + "x".repeat(HEAD_BYTES * 5));
    expect(readHead(p).length).toBe(HEAD_BYTES);
    expect(summarizeSource({ name: "big", path: p, type: "markdown" }))
      .toBe("Big doc: First line of the body that is long enough.");
  });

  it("returns empty for a missing file instead of throwing", () => {
    expect(readHead("/nonexistent/for/sure.md")).toBe("");
    expect(summarizeSource({ name: "gone", path: "/nonexistent/for/sure.md", type: "markdown" })).toBe("");
  });
});

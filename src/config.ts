import { resolve } from "path";
import { homedir } from "os";

/**
 * Paths to knowledge sources that ContextEngine indexes.
 * Each path is resolved to absolute at startup.
 */
export interface KnowledgeSource {
  /** Human-readable label */
  name: string;
  /** Absolute path to the file */
  path: string;
  /** File type for parser selection */
  type: "markdown";
}

/**
 * Returns the default knowledge sources across all FASTPROD projects.
 */
export function getDefaultSources(): KnowledgeSource[] {
  const home = homedir();
  const projects = resolve(home, "Projects");
  const gdrive = resolve(
    home,
    "Library/CloudStorage/GoogleDrive-yannick@compr.ch/My Drive/CTRL/EXO"
  );

  return [
    {
      name: "admin.CROWLR — copilot-instructions",
      path: resolve(projects, "admin.CROWLR/.github/copilot-instructions.md"),
      type: "markdown",
    },
    {
      name: "COMPR-app — copilot-instructions",
      path: resolve(projects, "COMPR-app/.github/copilot-instructions.md"),
      type: "markdown",
    },
    {
      name: "VOILA.tips — copilot-instructions",
      path: resolve(projects, "VOILA.tips/.github/copilot-instructions.md"),
      type: "markdown",
    },
    {
      name: "app.CROWLR — copilot-instructions",
      path: resolve(projects, "app.CROWLR/.github/copilot-instructions.md"),
      type: "markdown",
    },
    {
      name: "SKILLS",
      path: resolve(gdrive, "SKILLS.md"),
      type: "markdown",
    },
    {
      name: "Session Doc",
      path: resolve(home, "FASTPROD/docs/CROWLR_COMPR_APPS_SESSION.md"),
      type: "markdown",
    },
    {
      name: "Server Audit",
      path: resolve(gdrive, "SERVER_AUDIT_2026-02-11.md"),
      type: "markdown",
    },
    {
      name: "Pipeline Diagnostic Map",
      path: resolve(home, "FASTPROD/docs/PIPELINE_DIAGNOSTIC_MAP.md"),
      type: "markdown",
    },
  ];
}

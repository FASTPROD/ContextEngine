/**
 * Chat Participant — `@contextengine` in VS Code Copilot Chat.
 *
 * This is the **killer feature** of the extension. It allows AI agents
 * (and humans) to interact with ContextEngine directly from the chat panel.
 *
 * Commands:
 *  - `/status`  — session health, uncommitted changes, enforcement score
 *  - `/commit`  — stage and commit all changes with a descriptive message
 *  - `/search`  — search the ContextEngine knowledge base
 *  - `/remind`  — full enforcement checklist
 *
 * Freeform queries without a command are treated as knowledge searches.
 *
 * @module chatParticipant
 */

import * as vscode from "vscode";
import { GitMonitor, type GitSnapshot } from "./gitMonitor";
import * as client from "./contextEngineClient";
import type { CEDocStatus } from "./contextEngineClient";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PARTICIPANT_ID = "contextengine.agent";

// ---------------------------------------------------------------------------
// Chat Participant Factory
// ---------------------------------------------------------------------------

/**
 * Register the `@contextengine` chat participant.
 *
 * @param gitMonitor — the active git monitor instance (for /status)
 * @returns disposable for cleanup
 */
export function registerChatParticipant(
  gitMonitor: GitMonitor
): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<vscode.ChatResult> => {
    // Route to command handler
    switch (request.command) {
      case "status":
        return await handleStatus(stream, gitMonitor, token);
      case "commit":
        return await handleCommit(stream, request, gitMonitor, token);
      case "search":
        return await handleSearch(stream, request, token);
      case "remind":
        return await handleRemind(stream, gitMonitor, token);
      case "sync":
        return await handleSync(stream, gitMonitor, token);
      default:
        // No command — treat as a free-form search query
        if (request.prompt.trim()) {
          return await handleSearch(stream, request, token);
        }
        return showHelp(stream);
    }
  };

  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    handler
  );
  participant.iconPath = new vscode.ThemeIcon("shield");

  return participant;
}

// ---------------------------------------------------------------------------
// /status — Session Health Dashboard
// ---------------------------------------------------------------------------

async function handleStatus(
  stream: vscode.ChatResponseStream,
  gitMonitor: GitMonitor,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  stream.progress("Scanning workspace git status…");

  // Force a fresh scan
  const snapshot = await gitMonitor.forceScan();

  if (token.isCancellationRequested) return {};

  stream.markdown("## $(shield) ContextEngine — Session Status\n\n");

  // Overall health
  if (snapshot.totalDirty === 0) {
    stream.markdown("### ✅ All Clean\n\n");
    stream.markdown(
      "No uncommitted changes across all workspace projects. Good discipline!\n\n"
    );
  } else {
    const severity =
      snapshot.totalDirty < 5
        ? "⚠️ Minor"
        : snapshot.totalDirty < 10
          ? "⚠️ Warning"
          : "🔴 Critical";

    stream.markdown(`### ${severity} — ${snapshot.totalDirty} Uncommitted Files\n\n`);
  }

  // Project table
  if (snapshot.projects.length > 0) {
    stream.markdown("| Project | Branch | Uncommitted | Status |\n");
    stream.markdown("|---------|--------|-------------|--------|\n");

    for (const p of snapshot.projects) {
      const status =
        p.dirty === 0 ? "✅ Clean" : p.dirty < 5 ? "⚠️" : "🔴";
      stream.markdown(
        `| ${p.name} | \`${p.branch}\` | ${p.dirty} | ${status} |\n`
      );
    }
    stream.markdown("\n");
  }

  // Dirty file details
  for (const p of snapshot.dirtyProjects) {
    if (p.uncommittedFiles.length > 0) {
      stream.markdown(`**${p.name}** — uncommitted files:\n`);
      const filesToShow = p.uncommittedFiles.slice(0, 15);
      for (const f of filesToShow) {
        stream.markdown(`- \`${f}\`\n`);
      }
      if (p.uncommittedFiles.length > 15) {
        stream.markdown(
          `- _…and ${p.uncommittedFiles.length - 15} more_\n`
        );
      }
      stream.markdown("\n");
    }
  }

  // Action buttons
  if (snapshot.totalDirty > 0) {
    stream.markdown("---\n\n");
    stream.button({
      command: "contextengine.commitAll",
      title: "$(git-commit) Commit All Changes",
    });
  }

  return {};
}

// ---------------------------------------------------------------------------
// /commit — Stage and Commit
// ---------------------------------------------------------------------------

async function handleCommit(
  stream: vscode.ChatResponseStream,
  request: vscode.ChatRequest,
  gitMonitor: GitMonitor,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  stream.progress("Checking for uncommitted changes…");

  const snapshot = await gitMonitor.forceScan();

  if (token.isCancellationRequested) return {};

  if (snapshot.totalDirty === 0) {
    stream.markdown("### ✅ Nothing to Commit\n\n");
    stream.markdown("All workspace projects are clean.\n");
    return {};
  }

  // Use user's message as commit message, or generate a default
  const userMessage = request.prompt.trim();
  const commitMessage =
    userMessage || `chore: session checkpoint — ${snapshot.totalDirty} files`;

  stream.markdown(`## $(git-commit) Committing Changes\n\n`);
  stream.markdown(`**Message:** \`${commitMessage}\`\n\n`);

  let successCount = 0;
  let failCount = 0;

  for (const p of snapshot.dirtyProjects) {
    if (token.isCancellationRequested) return {};

    stream.progress(`Committing ${p.name}…`);
    const result = await client.gitCommitAll(p.path, commitMessage);

    if (result.success) {
      stream.markdown(`- ✅ **${p.name}** — ${p.dirty} files committed\n`);
      successCount++;
    } else {
      stream.markdown(
        `- ❌ **${p.name}** — ${result.error || "failed"}\n`
      );
      failCount++;
    }
  }

  stream.markdown("\n---\n\n");

  if (failCount === 0) {
    stream.markdown(
      `### ✅ All ${successCount} project${successCount > 1 ? "s" : ""} committed successfully!\n\n`
    );

    // Offer to push
    stream.markdown("**Next:** Push to remotes?\n\n");
    // Follow-up suggestion
  } else {
    stream.markdown(
      `### ⚠️ ${successCount} succeeded, ${failCount} failed\n\n`
    );
    stream.markdown(
      "Check the failed projects — they may have merge conflicts or other issues.\n"
    );
  }

  // Refresh the monitor
  await gitMonitor.forceScan();

  return {};
}

// ---------------------------------------------------------------------------
// /search — Knowledge Base Search
// ---------------------------------------------------------------------------

async function handleSearch(
  stream: vscode.ChatResponseStream,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  const query = request.prompt.trim();

  if (!query) {
    stream.markdown("### $(search) Search Knowledge Base\n\n");
    stream.markdown(
      "Please provide a search query. Example:\n\n"
    );
    stream.markdown(
      "```\n@contextengine /search deployment process\n```\n"
    );
    return {};
  }

  stream.progress(`Searching for "${query}"…`);

  try {
    const results = await client.search(query, 5);

    if (token.isCancellationRequested) return {};

    if (results.length === 0) {
      stream.markdown(`### $(search) No Results\n\n`);
      stream.markdown(`No matches found for: **${query}**\n\n`);
      stream.markdown(
        "Try broadening your query or checking `@contextengine /status` for indexed sources.\n"
      );
      return {};
    }

    stream.markdown(
      `### $(search) Search Results — "${query}" (${results.length} matches)\n\n`
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      stream.markdown(
        `#### ${i + 1}. ${r.source} — ${r.section} (${r.score.toFixed(2)})\n\n`
      );

      // Show content in a foldable block
      if (r.content.length > 500) {
        stream.markdown(
          `${r.content.substring(0, 500)}…\n\n`
        );
      } else {
        stream.markdown(`${r.content}\n\n`);
      }

      if (r.lines) {
        stream.markdown(`_Lines ${r.lines}_\n\n`);
      }

      stream.markdown("---\n\n");
    }
  } catch (error: unknown) {
    const err = error as { message?: string };
    stream.markdown(`### ❌ Search Error\n\n`);
    stream.markdown(
      `Could not execute search: ${err.message || "unknown error"}\n\n`
    );
    stream.markdown(
      "Is `@compr/contextengine-mcp` installed? Try: `npm i -g @compr/contextengine-mcp`\n"
    );
  }

  return {};
}

// ---------------------------------------------------------------------------
// /remind — Full Enforcement Checklist
// ---------------------------------------------------------------------------

async function handleRemind(
  stream: vscode.ChatResponseStream,
  gitMonitor: GitMonitor,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  stream.progress("Running enforcement checklist…");

  // 1. Git status
  const snapshot = await gitMonitor.forceScan();
  if (token.isCancellationRequested) return {};

  stream.markdown("## $(checklist) ContextEngine — Enforcement Checklist\n\n");

  // Uncommitted changes
  if (snapshot.totalDirty === 0) {
    stream.markdown("- ✅ **Git status** — all projects clean\n");
  } else {
    stream.markdown(
      `- ❌ **Git status** — ${snapshot.totalDirty} uncommitted files in ${snapshot.dirtyProjects.length} project(s)\n`
    );
    for (const p of snapshot.dirtyProjects) {
      stream.markdown(`  - ${p.name}: ${p.dirty} files on \`${p.branch}\`\n`);
    }
  }

  // 2. Try running end-session checks via CLI
  stream.progress("Running end-session checks…");

  try {
    const checks = await client.endSession();

    if (token.isCancellationRequested) return {};

    if (checks.length > 0) {
      stream.markdown("\n**End-of-Session Checks:**\n\n");
      for (const check of checks) {
        const icon = check.status === "PASS" ? "✅" : "❌";
        stream.markdown(`- ${icon} **${check.check}** — ${check.detail}\n`);
      }

      const passCount = checks.filter((c) => c.status === "PASS").length;
      const failCount = checks.filter((c) => c.status === "FAIL").length;

      stream.markdown(`\n**Score:** ${passCount}/${checks.length} passed`);
      if (failCount > 0) {
        stream.markdown(` — **${failCount} action${failCount > 1 ? "s" : ""} required**`);
      }
      stream.markdown("\n\n");
    }
  } catch {
    stream.markdown(
      "\n- ⚠️ **End-session checks** — CLI not available (install `@compr/contextengine-mcp`)\n"
    );
  }

  // 3. Protocol reminder
  stream.markdown("\n---\n\n");
  stream.markdown("### Before Ending Your Session\n\n");
  stream.markdown("1. 🔄 **Commit** all changes with descriptive messages\n");
  stream.markdown("2. 📝 **Update** `copilot-instructions.md` with new facts\n");
  stream.markdown("3. 💾 **Save** learnings via `save_learning` tool\n");
  stream.markdown("4. 📊 **Update** `SKILLS.md` and `SCORE.md`\n");
  stream.markdown("5. 🚀 **Push** to all remotes (origin + gdrive)\n");
  stream.markdown("\n");

  // Action buttons
  if (snapshot.totalDirty > 0) {
    stream.button({
      command: "contextengine.commitAll",
      title: "$(git-commit) Commit All Changes",
    });
  }

  stream.button({
    command: "contextengine.endSession",
    title: "$(checklist) Run End Session",
  });

  return {};
}

// ---------------------------------------------------------------------------
// /sync — CE Doc Compliance Sync
// ---------------------------------------------------------------------------

async function handleSync(
  stream: vscode.ChatResponseStream,
  gitMonitor: GitMonitor,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  stream.progress("Checking CE documentation freshness…");

  const snapshot = await gitMonitor.forceScan();
  if (token.isCancellationRequested) return {};

  stream.markdown("## $(sync) ContextEngine — Documentation Sync\n\n");

  const ceStatuses = snapshot.ceDocStatus;
  if (ceStatuses.length === 0) {
    stream.markdown("No workspace projects found.\n");
    return {};
  }

  let totalIssues = 0;

  for (const status of ceStatuses) {
    const issues: string[] = [];

    if (!status.copilotInstructions.exists) {
      issues.push("❌ **copilot-instructions.md** — MISSING");
    } else if (status.copilotInstructions.stale) {
      issues.push(`⚠️ **copilot-instructions.md** — last updated ${status.copilotInstructions.ageHours}h ago`);
    } else {
      issues.push(`✅ **copilot-instructions.md** — updated ${status.copilotInstructions.ageHours}h ago`);
    }

    if (!status.skillsMd.exists) {
      issues.push("❌ **SKILLS.md** — MISSING (create with: ## When to use, ## Key rules, ## Examples)");
    } else if (status.skillsMd.stale) {
      issues.push(`⚠️ **SKILLS.md** — last updated ${status.skillsMd.ageHours}h ago`);
    } else {
      issues.push(`✅ **SKILLS.md** — updated ${status.skillsMd.ageHours}h ago`);
    }

    if (!status.scoreMd.exists) {
      issues.push("❌ **SCORE.md** — MISSING (run `score_project` to generate)");
    } else if (status.scoreMd.stale) {
      issues.push(`⚠️ **SCORE.md** — last updated ${status.scoreMd.ageHours}h ago`);
    } else {
      issues.push(`✅ **SCORE.md** — updated ${status.scoreMd.ageHours}h ago`);
    }

    if (status.codeAheadOfDocs) {
      issues.push("🔴 **Code committed AFTER last CE doc update** — docs are stale!");
    }

    const hasProblems = issues.some(i => i.startsWith("❌") || i.startsWith("⚠️") || i.startsWith("🔴"));
    if (hasProblems) totalIssues++;

    const icon = hasProblems ? "⚠️" : "✅";
    stream.markdown(`### ${icon} ${status.project}\n\n`);
    for (const issue of issues) {
      stream.markdown(`- ${issue}\n`);
    }
    stream.markdown("\n");
  }

  // Action items
  if (totalIssues > 0) {
    stream.markdown("---\n\n");
    stream.markdown("### 🔧 Required Actions\n\n");
    stream.markdown("The following CE compliance items need attention:\n\n");
    stream.markdown("1. **Update `copilot-instructions.md`** with any new facts from this session\n");
    stream.markdown("2. **Create/update `SKILLS.md`** with current development patterns\n");
    stream.markdown("3. **Update `SCORE.md`** by running `score_project`\n");
    stream.markdown("4. **Save learnings** via `save_learning` for every reusable pattern\n");
    stream.markdown("5. **Save session** via `save_session` for continuity\n");
    stream.markdown("\n");

    stream.button({
      command: "contextengine.endSession",
      title: "$(checklist) Run Full End-Session Check",
    });
  } else {
    stream.markdown("---\n\n");
    stream.markdown("### ✅ All CE documentation is up to date!\n\n");
    stream.markdown("Don't forget to also:\n");
    stream.markdown("- Save learnings (`save_learning`) for reusable patterns\n");
    stream.markdown("- Save session (`save_session`) for continuity\n");
  }

  return {};
}

// ---------------------------------------------------------------------------
// Help — no command specified
// ---------------------------------------------------------------------------

function showHelp(stream: vscode.ChatResponseStream): vscode.ChatResult {
  stream.markdown("## $(shield) ContextEngine\n\n");
  stream.markdown(
    "AI agent compliance — session management, enforcement, and knowledge search.\n\n"
  );
  stream.markdown("### Commands\n\n");
  stream.markdown(
    "| Command | Description |\n|---------|-------------|\n"
  );
  stream.markdown(
    "| `/status` | Session health: uncommitted changes, enforcement score |\n"
  );
  stream.markdown(
    "| `/commit` | Stage and commit all changes (add message after command) |\n"
  );
  stream.markdown(
    "| `/search` | Search the ContextEngine knowledge base |\n"
  );
  stream.markdown(
    "| `/remind` | Full enforcement checklist — what's missing |\n"
  );
  stream.markdown(
    "| `/sync` | Check CE doc freshness — find stale docs |\n"
  );
  stream.markdown("\n### Examples\n\n");
  stream.markdown("```\n@contextengine /status\n");
  stream.markdown("@contextengine /commit feat: add user authentication\n");
  stream.markdown("@contextengine /search deployment process\n");
  stream.markdown("@contextengine /remind\n");
  stream.markdown("@contextengine /sync\n");
  stream.markdown("@contextengine how does the scoring system work?\n");
  stream.markdown("```\n");

  return {};
}

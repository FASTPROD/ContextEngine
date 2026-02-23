// src/firewall.ts — Protocol Compliance Firewall
//
// Breakthrough: AI agents only respond to tool response content.
// Not VS Code notifications, not status bars, not toasts.
// This firewall injects protocol status into EVERY tool response
// and TRUNCATES output when the agent ignores obligations.
//
// Escalation: silent → footer → header → degraded (truncation)
//
// This is the first MCP server that enforces agent behavior
// through progressive response degradation.

import { execSync } from "child_process";
import { existsSync, statSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Obligation {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

type Level = "silent" | "footer" | "header" | "degraded";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tools that ARE compliance actions — exempt from enforcement */
const EXEMPT_TOOLS = new Set([
  "save_learning",
  "save_session",
  "end_session",
  "list_learnings",
  "list_sessions",
  "load_session",
  "delete_learning",
  "import_learnings",
  "activate",
  "activation_status",
]);

/** Minimum tool calls expected per learning saved */
const CALLS_PER_LEARNING = 15;

/** Cache durations */
const GIT_CACHE_MS = 60_000; // 1 minute
const DOC_CACHE_MS = 120_000; // 2 minutes

/** Maximum response length in degraded mode */
const DEGRADED_MAX_CHARS = 500;

// ---------------------------------------------------------------------------
// ProtocolFirewall
// ---------------------------------------------------------------------------

export class ProtocolFirewall {
  // --- Counters ---
  private toolCalls = 0;
  private learningsSaved = 0;
  private sessionSaved = false;
  private readonly startTime = Date.now();

  // --- Cached checks (avoid hammering git on every call) ---
  private gitCache: CacheEntry<string[]> = { data: [], timestamp: 0 };
  private docCache: CacheEntry<number> = { data: 0, timestamp: 0 };

  // --- Project dirs (set during reindex) ---
  private projectDirs: Array<{ path: string; name: string }> = [];

  /**
   * Update project directories (call during reindex).
   */
  setProjectDirs(dirs: Array<{ path: string; name: string }>): void {
    this.projectDirs = dirs;
  }

  /**
   * Wrap a tool response with protocol status.
   * This is the ONLY public API. Call on every tool response.
   *
   * - Exempt tools (save_learning, etc.) pass through unmodified
   * - Silent phase (first 10 calls or 0 obligations): no change
   * - Footer/Header: status block appended/prepended
   * - Degraded: response TRUNCATED + status block
   */
  wrap(toolName: string, responseText: string): string {
    this.toolCalls++;

    // Compliance tools get a free pass — don't firewall the remedy
    if (EXEMPT_TOOLS.has(toolName)) {
      this.recordCompliance(toolName);
      return responseText;
    }

    // Evaluate obligations
    const obligations = this.evaluate();
    const fails = obligations.filter((o) => o.status === "fail").length;
    const warns = obligations.filter((o) => o.status === "warn").length;
    const score = Math.min(100, fails * 30 + warns * 10);
    const level = this.computeLevel(score);

    if (level === "silent") return responseText;

    const block = this.formatBlock(obligations, score, level);

    switch (level) {
      case "degraded": {
        const truncated =
          responseText.length > DEGRADED_MAX_CHARS
            ? responseText.slice(0, DEGRADED_MAX_CHARS) +
              `\n\n⛔ [${responseText.length - DEGRADED_MAX_CHARS} chars hidden — ` +
              `call save_learning or save_session to restore full output]`
            : responseText;
        return block + "\n\n" + truncated;
      }
      case "header":
        return block + "\n\n" + responseText;
      case "footer":
      default:
        return responseText + "\n\n" + block;
    }
  }

  /**
   * Get current state for diagnostics / testing.
   */
  getState() {
    return {
      toolCalls: this.toolCalls,
      learningsSaved: this.learningsSaved,
      sessionSaved: this.sessionSaved,
      uptimeMinutes: Math.round((Date.now() - this.startTime) / 60_000),
    };
  }

  // -----------------------------------------------------------------------
  // Internal: compliance tracking
  // -----------------------------------------------------------------------

  private recordCompliance(toolName: string): void {
    if (toolName === "save_learning") this.learningsSaved++;
    if (toolName === "save_session") this.sessionSaved = true;
  }

  // -----------------------------------------------------------------------
  // Internal: obligation evaluation
  // -----------------------------------------------------------------------

  private evaluate(): Obligation[] {
    const obs: Obligation[] = [];
    const minutes = (Date.now() - this.startTime) / 60_000;
    const calls = this.toolCalls;

    // 1. Learnings — expect 1 per CALLS_PER_LEARNING calls
    const expected = Math.max(1, Math.floor(calls / CALLS_PER_LEARNING));
    if (calls < 10) {
      obs.push({
        id: "learn",
        label: "Learnings",
        status: "ok",
        detail: "warmup",
      });
    } else if (this.learningsSaved >= expected) {
      obs.push({
        id: "learn",
        label: "Learnings",
        status: "ok",
        detail: `${this.learningsSaved} saved`,
      });
    } else if (this.learningsSaved > 0) {
      obs.push({
        id: "learn",
        label: "Learnings",
        status: "warn",
        detail: `${this.learningsSaved}/${expected} expected`,
      });
    } else {
      obs.push({
        id: "learn",
        label: "Learnings",
        status: "fail",
        detail: `0 saved (${calls} calls)`,
      });
    }

    // 2. Session — expect save_session after warmup
    if (this.sessionSaved) {
      obs.push({
        id: "session",
        label: "Session",
        status: "ok",
        detail: "saved",
      });
    } else if (minutes > 30 || calls > 30) {
      obs.push({
        id: "session",
        label: "Session",
        status: "fail",
        detail: `${Math.round(minutes)}min without save`,
      });
    } else if (minutes > 15 || calls > 15) {
      obs.push({
        id: "session",
        label: "Session",
        status: "warn",
        detail: "not saved yet",
      });
    } else {
      obs.push({
        id: "session",
        label: "Session",
        status: "ok",
        detail: "warmup",
      });
    }

    // 3. Git — uncommitted changes
    obs.push(this.checkGit());

    // 4. Docs — copilot-instructions freshness vs commit count
    obs.push(this.checkDocs());

    return obs;
  }

  // -----------------------------------------------------------------------
  // Internal: git & doc freshness checks (cached)
  // -----------------------------------------------------------------------

  private checkGit(): Obligation {
    const now = Date.now();
    if (now - this.gitCache.timestamp > GIT_CACHE_MS) {
      this.gitCache.timestamp = now;
      this.gitCache.data = [];
      for (const dir of this.projectDirs.slice(0, 5)) {
        try {
          const out = execSync(
            "git status --porcelain 2>/dev/null | wc -l",
            {
              cwd: dir.path,
              encoding: "utf-8",
              timeout: 3000,
              stdio: ["pipe", "pipe", "pipe"],
            }
          ).trim();
          const n = parseInt(out);
          if (n > 0) this.gitCache.data.push(`${dir.name}(${n})`);
        } catch {
          /* skip */
        }
      }
    }

    const dirty = this.gitCache.data;
    if (dirty.length === 0) {
      return { id: "git", label: "Git", status: "ok", detail: "clean" };
    }

    const total = dirty.reduce((sum, d) => {
      const m = d.match(/\((\d+)\)/);
      return sum + (m ? parseInt(m[1]) : 0);
    }, 0);

    return {
      id: "git",
      label: "Git",
      status: total > 5 ? "fail" : "warn",
      detail: dirty.join(", "),
    };
  }

  private checkDocs(): Obligation {
    const now = Date.now();
    if (now - this.docCache.timestamp > DOC_CACHE_MS) {
      this.docCache.timestamp = now;
      this.docCache.data = 0;
      for (const dir of this.projectDirs.slice(0, 3)) {
        try {
          const docPath = join(dir.path, ".github", "copilot-instructions.md");
          if (!existsSync(docPath)) continue;
          const stat = statSync(docPath);
          const since = new Date(stat.mtimeMs).toISOString();
          const out = execSync(
            `git --no-pager log --oneline --since="${since}" -- . ':!.github/copilot-instructions.md' 2>/dev/null | wc -l`,
            {
              cwd: dir.path,
              encoding: "utf-8",
              timeout: 3000,
              stdio: ["pipe", "pipe", "pipe"],
            }
          ).trim();
          this.docCache.data = Math.max(this.docCache.data, parseInt(out) || 0);
        } catch {
          /* skip */
        }
      }
    }

    const c = this.docCache.data;
    if (c > 3) {
      return {
        id: "docs",
        label: "Docs",
        status: "fail",
        detail: `${c} commits since last copilot-instructions update`,
      };
    }
    if (c > 1) {
      return {
        id: "docs",
        label: "Docs",
        status: "warn",
        detail: `${c} commits since update`,
      };
    }
    return { id: "docs", label: "Docs", status: "ok", detail: "fresh" };
  }

  // -----------------------------------------------------------------------
  // Internal: escalation level
  // -----------------------------------------------------------------------

  private computeLevel(score: number): Level {
    const calls = this.toolCalls;
    if (calls < 10) return "silent"; // warmup — don't nag early
    if (score === 0) return "silent"; // all obligations met
    if (calls < 20) return "footer"; // gentle reminder at bottom
    if (score < 50 || calls < 40) return "header"; // prominent, top of response
    return "degraded"; // nuclear: truncate output
  }

  // -----------------------------------------------------------------------
  // Internal: format status block
  // -----------------------------------------------------------------------

  private formatBlock(
    obs: Obligation[],
    score: number,
    level: Level
  ): string {
    const min = Math.round((Date.now() - this.startTime) / 60_000);
    const compliance = 100 - score;
    const icon =
      level === "degraded" ? "🔴" : level === "header" ? "🟡" : "📋";

    const lines: string[] = [
      `━━━ CE PROTOCOL ${icon} ━━━`,
      `⏱ ${min}min | 🔧 ${this.toolCalls} calls | Compliance: ${compliance}%`,
    ];

    for (const o of obs) {
      const i =
        o.status === "ok" ? "✅" : o.status === "warn" ? "⚠️" : "❌";
      lines.push(`${i} ${o.label}: ${o.detail}`);
    }

    if (level === "degraded") {
      lines.push("");
      lines.push(
        "⛔ Output TRUNCATED. Call save_learning or save_session to restore."
      );
    } else if (level === "header") {
      lines.push("");
      lines.push(
        "→ Address obligations before responses degrade further."
      );
    }

    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━");
    return lines.join("\n");
  }
}

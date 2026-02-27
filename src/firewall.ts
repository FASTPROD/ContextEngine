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
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

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
const CALLS_PER_LEARNING = 5;

/** Cache durations */
const GIT_CACHE_MS = 60_000; // 1 minute
const DOC_CACHE_MS = 120_000; // 2 minutes

/** Maximum response length in degraded mode */
const DEGRADED_MAX_CHARS = 500;

/** Interaction round gap — calls within this window are one round */
const ROUND_GAP_MS = 30_000; // 30 seconds

/** Max age for prior session state to be resumed (crash recovery) */
const STALE_SESSION_MS = 5 * 60_000; // 5 minutes

/** Max learnings to auto-inject per tool response */
const INJECT_MAX = 3;

/** Minimum score for a learning to be injected (from searchLearnings scoring) */
const INJECT_MIN_SCORE_TOKENS = 2; // at least 2 keyword token matches

/**
 * Callback type for searching learnings — avoids circular import.
 * Returns top matches with rule text + optional project scope.
 */
export type LearningSearchFn = (
  query: string,
  projects?: string[]
) => Array<{ rule: string; project?: string; category: string }>;

// ---------------------------------------------------------------------------
// ProtocolFirewall
// ---------------------------------------------------------------------------

export class ProtocolFirewall {
  // --- Counters ---
  private toolCalls = 0;
  private learningsSaved = 0;
  private sessionSaved = false;
  private readonly startTime = Date.now();
  private nudgesIssued = 0;
  private searchRecalls = 0; // learnings surfaced via search
  private truncations = 0;   // degraded responses issued

  // --- Interaction round tracking ---
  private lastNonExemptCall = 0; // timestamp of last non-exempt tool call
  private round = 0;            // current interaction round (1-based)
  private roundAtLastSave = 0;  // round when session was last saved
  private roundsSinceSessionSave = 0; // consecutive rounds without save_session

  // --- Stats flush (debounce disk writes) ---
  private statsFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STATS_FLUSH_MS = 10_000; // every 10s max
  private static readonly STATS_FILE = join(
    homedir(),
    ".contextengine",
    "session-stats.json"
  );

  // --- Learning auto-injection ---
  private learningSearchFn: LearningSearchFn | null = null;
  private activeProjects: string[] = [];
  private injectionCache = new Map<string, string>(); // hint → formatted block
  private injectionCacheRound = 0; // round when cache was built
  private learningsInjected = 0; // total learnings injected this session

  // --- Cached checks (avoid hammering git on every call) ---
  private gitCache: CacheEntry<string[]> = { data: [], timestamp: 0 };
  private docCache: CacheEntry<number> = { data: 0, timestamp: 0 };

  // --- Project dirs (set during reindex) ---
  private projectDirs: Array<{ path: string; name: string }> = [];

  constructor(opts?: { skipRestore?: boolean }) {
    if (!opts?.skipRestore) {
      this.loadPriorState();
    }
  }

  /**
   * Resume enforcement from a prior session if it crashed recently.
   * Reads session-stats.json and restores round counters so a crashed
   * window doesn't reset enforcement back to silent.
   */
  private loadPriorState(): void {
    try {
      if (!existsSync(ProtocolFirewall.STATS_FILE)) return;
      const raw = readFileSync(ProtocolFirewall.STATS_FILE, "utf-8");
      const prior = JSON.parse(raw) as Record<string, unknown>;

      // Only resume if the prior session was active recently
      const updatedAt = prior.updatedAt as string | undefined;
      if (!updatedAt) return;
      const age = Date.now() - new Date(updatedAt).getTime();
      if (age > STALE_SESSION_MS) return;

      // Don't resume from the same process (already running)
      if (prior.pid === process.pid) return;

      // Restore enforcement state
      if (typeof prior.round === "number" && prior.round > 0) {
        this.round = prior.round;
      }
      if (typeof prior.roundsSinceSessionSave === "number") {
        this.roundsSinceSessionSave = prior.roundsSinceSessionSave;
        this.roundAtLastSave = this.round - this.roundsSinceSessionSave;
      }
      if (prior.sessionSaved === true) {
        this.sessionSaved = true;
      }
      if (typeof prior.searchRecalls === "number") {
        this.searchRecalls = prior.searchRecalls;
      }

      console.error(
        `[ContextEngine] 🔄 Resumed firewall state from prior session ` +
        `(round ${this.round}, ${this.roundsSinceSessionSave} rounds since save)`
      );
    } catch {
      // Non-critical — start fresh
    }
  }

  /**
   * Update project directories (call during reindex).
   */
  setProjectDirs(dirs: Array<{ path: string; name: string }>): void {
    this.projectDirs = dirs;
    this.activeProjects = dirs.map((d) => d.name);
  }

  /**
   * Register the learning search function.
   * Call once at startup to enable auto-injection without circular imports.
   */
  setLearningSearchFn(fn: LearningSearchFn): void {
    this.learningSearchFn = fn;
  }

  /**
   * Wrap a tool response with protocol status + learning injection.
   * This is the ONLY public API. Call on every tool response.
   *
   * - Exempt tools (save_learning, etc.) pass through unmodified
   * - Silent phase (first 10 calls or 0 obligations): no change
   * - Footer/Header: status block appended/prepended
   * - Degraded: response TRUNCATED + status block
   *
   * @param toolName  MCP tool name
   * @param responseText  Original tool response text
   * @param contextHint  Optional query/args string for learning injection
   */
  wrap(toolName: string, responseText: string, contextHint?: string): string {
    this.toolCalls++;

    // Compliance tools get a free pass — don't firewall the remedy
    if (EXEMPT_TOOLS.has(toolName)) {
      this.recordCompliance(toolName);
      return responseText;
    }

    // Track interaction rounds — calls >30s apart = new round
    const now = Date.now();
    if (now - this.lastNonExemptCall > ROUND_GAP_MS) {
      this.round++;
      this.roundsSinceSessionSave = this.round - this.roundAtLastSave;
    }
    this.lastNonExemptCall = now;

    // --- Auto-inject relevant learnings ---
    const injection = this.buildLearningInjection(contextHint);

    // Evaluate obligations
    const obligations = this.evaluate();
    const fails = obligations.filter((o) => o.status === "fail").length;
    const warns = obligations.filter((o) => o.status === "warn").length;
    const score = Math.min(100, fails * 30 + warns * 10);
    const level = this.computeLevel(score);

    // Prepend learning injection to response (always, if available)
    let text = injection ? injection + "\n\n" + responseText : responseText;

    if (level === "silent") return text;

    const block = this.formatBlock(obligations, score, level);
    this.nudgesIssued++;

    switch (level) {
      case "degraded": {
        this.truncations++;
        const truncated =
          text.length > DEGRADED_MAX_CHARS
            ? text.slice(0, DEGRADED_MAX_CHARS) +
              `\n\n⛔ [${text.length - DEGRADED_MAX_CHARS} chars hidden — ` +
              `call save_learning or save_session to restore full output]`
            : text;
        this.scheduleStatsFlush();
        return block + "\n\n" + truncated;
      }
      case "header":
        this.scheduleStatsFlush();
        return block + "\n\n" + text;
      case "footer":
      default:
        this.scheduleStatsFlush();
        return text + "\n\n" + block;
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
      nudgesIssued: this.nudgesIssued,
      searchRecalls: this.searchRecalls,
      truncations: this.truncations,
      timeSavedMinutes: this.estimateTimeSaved(),
      round: this.round,
      roundsSinceSessionSave: this.roundsSinceSessionSave,
      learningsInjected: this.learningsInjected,
    };
  }

  /**
   * Record that N learnings were surfaced in a search result.
   * Call from search_context handler after counting learning-sourced results.
   */
  recordSearchRecalls(count: number): void {
    this.searchRecalls += count;
    this.scheduleStatsFlush();
  }

  // -----------------------------------------------------------------------
  // Internal: learning auto-injection
  // -----------------------------------------------------------------------

  /**
   * Search and format relevant learnings for injection into tool response.
   * Returns null if no relevant learnings or no search function registered.
   * Results are cached per round to avoid repeated searches for same hint.
   */
  private buildLearningInjection(hint?: string): string | null {
    if (!hint || !this.learningSearchFn) return null;

    // Normalize hint to first 200 chars to keep cache keys sane
    const key = hint.slice(0, 200).toLowerCase().trim();
    if (!key) return null;

    // Invalidate cache on new round
    if (this.round !== this.injectionCacheRound) {
      this.injectionCache.clear();
      this.injectionCacheRound = this.round;
    }

    // Return cached result if available
    if (this.injectionCache.has(key)) {
      return this.injectionCache.get(key) || null;
    }

    // Search learnings (project-scoped + universal)
    const matches = this.learningSearchFn(key, this.activeProjects);
    if (matches.length === 0) {
      this.injectionCache.set(key, "");
      return null;
    }

    const top = matches.slice(0, INJECT_MAX);

    // Separate project-specific vs universal
    const projectSpecific = top.filter((m) => m.project);
    const universal = top.filter((m) => !m.project);

    const lines: string[] = ["💡 **Relevant learnings from your knowledge base:**"];

    if (projectSpecific.length > 0) {
      for (const m of projectSpecific) {
        lines.push(`  • [${m.project}/${m.category}] ${m.rule}`);
      }
    }

    if (universal.length > 0) {
      for (const m of universal) {
        lines.push(`  • [${m.category}] ${m.rule}`);
      }
    }

    const block = lines.join("\n");
    this.injectionCache.set(key, block);
    this.learningsInjected += top.length;
    this.searchRecalls += top.length; // counts toward value meter
    return block;
  }

  // -----------------------------------------------------------------------
  // Internal: time-saved heuristic
  // -----------------------------------------------------------------------

  /**
   * Estimate minutes saved by ContextEngine this session.
   * - Each learning recall ≈ 2 min (avoids re-discovery / googling)
   * - Each nudge ≈ 1 min (prevented forgetting / cleanup later)
   * - Each learning saved ≈ 1 min (future sessions benefit)
   * - Session save ≈ 3 min (avoids cold-start next session)
   * Note: learningsInjected already counted via searchRecalls bump
   */
  private estimateTimeSaved(): number {
    return (
      this.searchRecalls * 2 +
      this.nudgesIssued * 1 +
      this.learningsSaved * 1 +
      (this.sessionSaved ? 3 : 0)
    );
  }

  // -----------------------------------------------------------------------
  // Internal: stats persistence (debounced disk write)
  // -----------------------------------------------------------------------

  private scheduleStatsFlush(): void {
    if (this.statsFlushTimer) return; // already scheduled
    this.statsFlushTimer = setTimeout(() => {
      this.statsFlushTimer = null;
      this.flushStats();
    }, ProtocolFirewall.STATS_FLUSH_MS);
  }

  private flushStats(): void {
    try {
      const dir = join(homedir(), ".contextengine");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const state = this.getState();
      const stats = {
        pid: process.pid,
        startedAt: new Date(this.startTime).toISOString(),
        updatedAt: new Date().toISOString(),
        ...state,
      };

      writeFileSync(
        ProtocolFirewall.STATS_FILE,
        JSON.stringify(stats, null, 2) + "\n",
        "utf-8"
      );
    } catch {
      // Non-critical — silently ignore write failures
    }
  }

  // -----------------------------------------------------------------------
  // Internal: compliance tracking
  // -----------------------------------------------------------------------

  private recordCompliance(toolName: string): void {
    if (toolName === "save_learning") this.learningsSaved++;
    if (toolName === "save_session") {
      this.sessionSaved = true;
      this.roundAtLastSave = this.round;
      this.roundsSinceSessionSave = 0;
    }
    this.scheduleStatsFlush();
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
    if (calls < 5) {
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

    // 2. Session — 3-strike per interaction round
    //    Round 1: grace period (ok)
    //    Round 2 without save: warn
    //    Round 3+ without save: fail
    const rss = this.roundsSinceSessionSave;
    if (this.sessionSaved && rss <= 1) {
      obs.push({
        id: "session",
        label: "Session",
        status: "ok",
        detail: "saved",
      });
    } else if (rss >= 3) {
      obs.push({
        id: "session",
        label: "Session",
        status: "fail",
        detail: `${rss} rounds without save — SAVE NOW`,
      });
    } else if (rss >= 2) {
      obs.push({
        id: "session",
        label: "Session",
        status: "warn",
        detail: `${rss} rounds without save`,
      });
    } else if (this.round <= 1) {
      obs.push({
        id: "session",
        label: "Session",
        status: "ok",
        detail: "warmup",
      });
    } else {
      obs.push({
        id: "session",
        label: "Session",
        status: "ok",
        detail: this.sessionSaved ? "saved" : "first round",
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
    if (score === 0) return "silent"; // all obligations met
    const rss = this.roundsSinceSessionSave;
    // Round-based escalation: 2 rounds without save → footer,
    // 3 rounds → header, 4+ → degraded. Also escalate on high score.
    if (rss >= 4 || score >= 80) return "degraded";
    if (rss >= 3 || score >= 50) return "header";
    if (rss >= 2 || this.toolCalls >= 5) return "footer";
    return "silent"; // first round grace
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

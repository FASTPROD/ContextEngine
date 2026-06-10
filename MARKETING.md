# OpsContext for AI Agents — Marketing Materials

> Created: 2026-02-27 (as ContextEngine) | Repositioned 2026-06-10 as OpsContext for AI Agents
>
> Positioning: **"Claude Code sees the code. OpsContext sees the infra that runs it."** Read-only fleet visibility (PM2/nginx/Docker/git/cron) + tamper-evident audit log (SOC2 CC7.2 / ISO 27001 A.12.4.1) + policy-as-code git hooks. The ops + compliance layer Claude Code can't grow natively.
>
> Old npm package `@compr/contextengine-mcp` is the 1.x line; new identity `@compr/opscontext-mcp` ships at 2.0.0. The historical "ContextEngine" name is retained in this doc where it captures the v1 framing — not because it's authoritative, but because the migration story is itself part of the positioning.

---

## 📸 Screenshots to Take (7 total)

### Screenshot 1: MCP Search in Action
**Where**: VS Code Copilot Chat
**How**: Open any project with `.vscode/mcp.json` configured. In Copilot Chat, ask: `@contextengine search "deployment nginx docker"`. Screenshot the full response showing search results with relevance scores.
**File**: `marketing/screenshots/01-search-results.png`

### Screenshot 2: Value Meter Status Bar
**Where**: VS Code bottom status bar
**How**: With MCP session active, wait for stats to populate. You should see something like `CE ~12min saved` or `CE 8🔍 3💾` in the status bar. Screenshot the bottom bar section.
**File**: `marketing/screenshots/02-value-meter.png`

### Screenshot 3: Live Stats Dashboard
**Where**: VS Code info panel (click ℹ️ icon in status bar)
**How**: Click the ℹ️ next to the CE status bar item. Screenshot the WebView dashboard showing tool calls, recalls, nudges, time saved.
**File**: `marketing/screenshots/03-stats-dashboard.png`

### Screenshot 4: Protocol Firewall Nudge
**Where**: VS Code Copilot Chat
**How**: Make 15+ tool calls without saving a session. The next `search` or `list_sources` response will include a compliance footer. Screenshot that.
**File**: `marketing/screenshots/04-firewall-nudge.png`

### Screenshot 5: Score Report (HTML)
**Where**: Browser
**How**: Run `npx @compr/opscontext-mcp score --html` from a project, open the generated `score-report.html`. Screenshot the visual report showing 95% A+.
**File**: `marketing/screenshots/05-score-report.png`

### Screenshot 6: Terminal Watcher Notification
**Where**: VS Code notification popup
**How**: Run a git commit in the terminal. The terminal watcher should fire a notification classifying the command. Screenshot the notification.
**File**: `marketing/screenshots/06-terminal-watcher.png`

### Screenshot 7: CLI Help / Tool List
**Where**: Terminal (iTerm or VS Code terminal)
**How**: Run `npx @compr/opscontext-mcp help` — screenshot showing all 16 subcommands.
**File**: `marketing/screenshots/07-cli-help.png`

### How to take screenshots on macOS:
```bash
mkdir -p ~/Projects/ContextEngine/marketing/screenshots
# Cmd+Shift+4 → drag to select area → saves to Desktop
# Move to: marketing/screenshots/0X-name.png
```

---

## 📝 Reddit Posts (5 subreddits)

### Post 1: r/ChatGPTCoding (largest, post first — Wed 14:00 UTC)

**Title**: I built an MCP server that gives AI coding agents persistent memory and compliance enforcement — open source

**Body**:

After months of AI-assisted coding, I kept hitting the same problems:

- Agents forget everything between sessions
- They skip git commits and leave files uncommitted
- They create dummy files to satisfy checklists
- They ignore their own documentation

So I built **ContextEngine** — an MCP server that turns your project docs into a queryable knowledge base.

**What it does:**
- 🔍 Hybrid search (BM25 keyword + semantic embeddings) across all your docs
- 🧠 Persistent learnings that survive across sessions (1,000+ rules in my knowledge base)
- 🛡️ Protocol Firewall — built-in enforcement that ensures agents save learnings, commit code, and update docs
- 💾 Session save/load so agents can resume where they left off
- ⚡ Zero config — auto-discovers copilot-instructions.md, CLAUDE.md, SKILLS.md
- 🔒 100% local — embeddings run on CPU, nothing leaves your machine

**The Protocol Firewall is the real differentiator.** It ensures agents actually follow the rules — saving learnings, committing code, and updating documentation. Unlike notification-based approaches (which agents ignore) or pre-commit hooks (which agents bypass with --no-verify), the Protocol Firewall is the only mechanism I've found that truly makes AI agents comply. How it works is proprietary, but the result is sessions that end clean instead of chaotic.

Works with VS Code Copilot, Claude Desktop, Cursor, Windsurf, and OpenClaw.

```bash
# Try it in 30 seconds:
npx @compr/opscontext-mcp init
npx @compr/opscontext-mcp search "your query"
```

- npm: https://www.npmjs.com/package/@compr/contextengine-mcp
- VS Code Extension: https://marketplace.visualstudio.com/items?itemName=css-llc.contextengine
- GitHub: https://github.com/FASTPROD/ContextEngine

Free and open-core (BSL-1.1). PRO adds multi-project scoring and auditing.

Would love feedback — especially on the Protocol Firewall concept. Has anyone else found a reliable way to make agents actually follow rules?

---

### Post 2: r/ClaudeAI

**Title**: MCP server that gives Claude persistent memory + compliance enforcement across sessions

**Body**:

If you use Claude Desktop or Claude Code, you know the pain: every new conversation starts from scratch. Context files help, but agents still drift.

I built **ContextEngine** — an MCP server purpose-built for this problem:

1. **Persistent learnings** — save operational rules that auto-surface in search results. I have 1,000+ rules accumulated across 10+ projects.
2. **Session continuity** — save/load session state. Claude picks up exactly where it left off.
3. **Protocol Firewall** — this is new. It ensures Claude actually saves learnings, commits code, and updates docs. Unlike rules in context files (which agents drift from) or notifications (which agents dismiss), the Protocol Firewall makes compliance automatic. The mechanism is proprietary, but the result speaks for itself.

Setup for Claude Desktop:
```json
{
  "mcpServers": {
    "ContextEngine": {
      "command": "npx",
      "args": ["-y", "@compr/contextengine-mcp"]
    }
  }
}
```

Everything runs locally. No API keys. The semantic search uses all-MiniLM-L6-v2 on CPU.

GitHub: https://github.com/FASTPROD/ContextEngine
npm: https://www.npmjs.com/package/@compr/contextengine-mcp

---

### Post 3: r/vscode

**Title**: VS Code extension that monitors AI agent compliance — Protocol Firewall for Copilot Chat

**Body**:

I built a VS Code extension that works alongside an MCP server to keep AI agents honest.

**The problem**: Copilot and other AI agents in VS Code will happily write code all day without committing, documenting, or saving learnings. By the time you notice, you have 50 modified files and zero documentation.

**ContextEngine** fixes this with:

- **Value Meter** in the status bar — shows recalls, saves, and estimated time saved
- **Live stats dashboard** — real-time session metrics
- **@contextengine chat participant** — `/status`, `/commit`, `/search`, `/sync` commands
- **Terminal watcher** — classifies commands (git, deploy, test, etc.), redacts credentials, detects stuck patterns
- **Escalating notifications** when files pile up without commits
- **One-click commit** across all repos

The MCP server underneath provides hybrid search across all your project docs, persistent learnings, and a Protocol Firewall that ensures agents follow compliance steps.

Install from marketplace: https://marketplace.visualstudio.com/items?itemName=css-llc.contextengine

The extension is free. The MCP server is open-core (search + memory free, scoring + audit PRO).

---

### Post 4: r/LocalLLaMA

**Title**: Local-first MCP knowledge base — BM25 + MiniLM-L6 semantic search, zero API calls

**Body**:

For the privacy-conscious: I built an MCP server where **nothing leaves your machine**.

- Semantic embeddings: `all-MiniLM-L6-v2` via @huggingface/transformers, runs on CPU
- Keyword search: BM25 with IDF scoring (instant)
- Hybrid ranking: combines both with temporal decay
- Embedding cache: ~200ms from disk after first run
- No API keys, no cloud, no telemetry

It indexes your project docs (copilot-instructions.md, CLAUDE.md, SKILLS.md, etc.) + operational data (git log, dependencies, Docker/PM2 status) into a searchable knowledge base.

The learning store (`~/.contextengine/learnings.json`) is a local append-only JSON file. The activation server (PRO only) receives just your machine fingerprint and license key — never code, never learnings, never project names.

Works with any MCP client. ~8,200 lines of TypeScript, 57 tests, 5 runtime deps.

npm: https://www.npmjs.com/package/@compr/contextengine-mcp
GitHub: https://github.com/FASTPROD/ContextEngine

---

### Post 5: r/MCP

**Title**: ContextEngine — MCP server with Protocol Firewall, 20 tools, hybrid search, hash-chained audit log

**Body**:

Sharing my MCP server that's focused on agent compliance and knowledge persistence.

**20 tools exposed:**
- `search_context` — hybrid BM25 + optional semantic search with mode selector
- `list_sources` / `read_source` / `reindex` — knowledge-base inspection
- `save_session` / `load_session` / `list_sessions` / `delete_session` / `end_session` — session continuity + pre-flight checklist
- `save_learning` / `list_learnings` / `delete_learning` / `import_learnings` — persistent operational rules
- `audit_verify` — tamper-evident hash-chained audit log (SOC2 CC7.2, ISO 27001 A.12.4.1)
- `list_projects` — cross-project tech-stack discovery (PRO)
- `check_ports` — port conflict detection across projects (PRO)
- `run_audit` — compliance audit (security, perf, DX, architecture) (PRO)
- `score_project` — AI-readiness score, 12 checks, A+ to F + HTML report (PRO)
- `activate` / `activation_status` — PRO license management

**Key architectural decisions:**
- stdio transport (works everywhere)
- Auto-discovery (zero config needed)
- Chunking with 4-line overlap for context continuity
- Temporal decay in search ranking (recent docs score higher)
- Protocol Firewall wraps every tool response — tracks compliance obligations and escalates

npm: `@compr/contextengine-mcp`
GitHub: https://github.com/FASTPROD/ContextEngine

---

## 🎬 HeyGen Video Script (45 seconds)

**For use with**: https://app.heygen.com — AI avatar + screenshot overlays

### Scene 1 (0-15s) — Problem + Solution
**Avatar says**: "AI coding agents forget everything between sessions — they skip commits, ignore docs, and drift from best practices. ContextEngine fixes this. It's an MCP server that gives your agents persistent memory and compliance enforcement."

**Screen**: Show Screenshot 1 (search results in Copilot Chat)

### Scene 2 (15-30s) — Key Features
**Avatar says**: "Hybrid search combines keyword and semantic matching. A persistent learning store accumulates rules across sessions — I have over a thousand. And the Protocol Firewall ensures agents actually follow the rules — no more forgotten commits or missing documentation."

**Screen**: Show Screenshot 4 (firewall nudge) → Screenshot 5 (score report) → Screenshot 2 (status bar)

### Scene 3 (30-45s) — CTA
**Avatar says**: "Set up in thirty seconds with npx. Free VS Code extension included. ContextEngine — guardrails for your AI agents. Link in the description."

**Screen**: Show `npx @compr/opscontext-mcp init` → npm page + VS Code marketplace + GitHub repo

---

## 🐾 ClawHub / OpenClaw Listing — BACKLOG

**Status**: Deferred. The OpenClaw/ClawHub marketplace does not currently resolve to a publicly accessible platform.
Revisit when/if that marketplace materializes. The Open WebUI community (125K stars, 340K members) is an alternative,
but requires a Python wrapper or mcpo bridge since ContextEngine is a Node.js MCP server.

---

## 🐳 Docker — CANCELLED

**Decision**: No Docker for ContextEngine. Users install via `npx @compr/opscontext-mcp`. The activation server runs PM2 on VPS. The 5 score points are not worth the maintenance overhead. Score stays at 95% A+.

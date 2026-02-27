# ContextEngine — Marketing Materials

> Created: 2026-02-27 | For Reddit launch + ClawHub + HeyGen video

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
**How**: Run `npx @compr/contextengine-mcp score --html` from a project, open the generated `score-report.html`. Screenshot the visual report showing 95% A+.
**File**: `marketing/screenshots/05-score-report.png`

### Screenshot 6: Terminal Watcher Notification
**Where**: VS Code notification popup
**How**: Run a git commit in the terminal. The terminal watcher should fire a notification classifying the command. Screenshot the notification.
**File**: `marketing/screenshots/06-terminal-watcher.png`

### Screenshot 7: CLI Help / Tool List
**Where**: Terminal (iTerm or VS Code terminal)
**How**: Run `npx @compr/contextengine-mcp help` — screenshot showing all 16 subcommands.
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
- 🛡️ Protocol Firewall — escalating compliance enforcement (nudge → header → degraded responses)
- 💾 Session save/load so agents can resume where they left off
- ⚡ Zero config — auto-discovers copilot-instructions.md, CLAUDE.md, SKILLS.md
- 🔒 100% local — embeddings run on CPU, nothing leaves your machine

**The Protocol Firewall is the real differentiator.** It progressively degrades tool responses when agents skip learnings, commits, or documentation. Warnings don't work (agents ignore them). Blocking exit codes don't work (agents use --no-verify). Response degradation is the only thing I've found that actually makes agents comply.

Works with VS Code Copilot, Claude Desktop, Cursor, Windsurf, and OpenClaw.

```bash
# Try it in 30 seconds:
npx @compr/contextengine-mcp init
npx @compr/contextengine-mcp search "your query"
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
3. **Protocol Firewall** — this is new. It tracks whether Claude has saved learnings, committed code, and updated docs. If not, it progressively degrades responses until Claude complies. It's the only mechanism I've found that actually works.

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

The MCP server underneath provides hybrid search across all your project docs, persistent learnings, and a Protocol Firewall that degrades responses when agents skip compliance steps.

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

**Title**: ContextEngine — MCP server with Protocol Firewall, 17 tools, hybrid search, persistent memory

**Body**:

Sharing my MCP server that's focused on agent compliance and knowledge persistence.

**17 tools exposed:**
- `search` — hybrid BM25 + semantic search
- `save_learning` / `list_learnings` / `delete_learning` — persistent operational rules
- `save_session` / `load_session` / `list_sessions` / `end_session` — session continuity
- `score_project` — AI-readiness score (12 checks, A+ to F)
- `run_audit` — compliance audit (security, perf, DX, architecture)
- `check_ports` — port conflict detection across projects
- `list_sources` / `list_projects` / `get_project_context` / `register_project`
- `configure_adapter` — auto-configure Claude Desktop / VS Code / Cursor
- `get_skill` / `list_skills` — bundled skill files
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
**Avatar says**: "Hybrid search across all your project docs. A learning store with over a thousand rules that auto-surface. And a Protocol Firewall that degrades responses when agents skip required steps. Everything runs locally — no API keys, no cloud."

**Screen**: Show Screenshot 4 (firewall nudge) → Screenshot 5 (score report) → Screenshot 2 (status bar)

### Scene 3 (30-45s) — CTA
**Avatar says**: "Set up in thirty seconds with npx. Free VS Code extension included. ContextEngine — guardrails for your AI agents. Link in the description."

**Screen**: Show `npx @compr/contextengine-mcp init` → npm page + VS Code marketplace + GitHub repo

---

## 🐾 ClawHub / OpenClaw Listing — BACKLOG

**Status**: Deferred. The OpenClaw/ClawHub marketplace does not currently resolve to a publicly accessible platform.
Revisit when/if that marketplace materializes. The Open WebUI community (125K stars, 340K members) is an alternative,
but requires a Python wrapper or mcpo bridge since ContextEngine is a Node.js MCP server.

---

## 🐳 Docker — CANCELLED

**Decision**: No Docker for ContextEngine. Users install via `npx @compr/contextengine-mcp`. The activation server runs PM2 on VPS. The 5 score points are not worth the maintenance overhead. Score stays at 95% A+.

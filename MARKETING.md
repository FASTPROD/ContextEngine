# OpsContext for AI Agents — Marketing Materials

> Created: 2026-02-27 (as ContextEngine) | Repositioned 2026-06-10 as OpsContext for AI Agents
>
> Positioning: **"Claude Code sees the code. OpsContext sees the infra that runs it."** Read-only fleet visibility (PM2/nginx/Docker/git/cron) + tamper-evident audit log designed to produce evidence aligned with [SOC 2 CC7.2](docs/compliance/cc7.2.md) and [ISO 27001 A.12.4.1](docs/compliance/a.12.4.1.md) (evidence artifacts — OpsContext is not itself certified) + policy-as-code git hooks. The ops + compliance layer Claude Code can't grow natively.
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

**Title**: OpsContext for AI Agents — the ops + compliance layer Claude Code can't grow natively (MCP, open source)

**Body**:

Claude Code is great at reading your code. It cannot — and structurally won't — see what's actually running on your servers. After months of AI-assisted coding across 20+ projects, the same gaps kept biting me:

- Agent suggests a fix while the production PM2 process is in a different state than the code on disk
- Agent commits without realizing nginx config drifted yesterday
- Secrets leak into session notes (`docs/sessions/SESSION_*.md`) and the pre-commit hook doesn't know to look there
- I have no audit trail when something I told the agent yesterday gets quietly overwritten today

So I built **OpsContext for AI Agents** — an MCP server that runs locally and gives your AI agents the things Claude Code (and friends) genuinely can't grow natively:

**The three pillars:**
- 🔭 **Operational visibility** — read-only collectors for PM2 / nginx / Docker / git / cron / `.env` (redacted). Cross-project + port-conflict detection + fleet HTML scoring. Your agent finally answers "what's running on prod?" with reality, not guesses.
- 🧾 **Tamper-evident audit log** — hash-chained JSONL at `~/.contextengine/audit.log`. Produces evidence aligned with [SOC 2 CC7.2](docs/compliance/cc7.2.md) and [ISO 27001 A.12.4.1](docs/compliance/a.12.4.1.md) — **evidence artifacts, not a certification**; OpsContext is not itself SOC 2– or ISO 27001–certified. `audit_verify` walks the chain; mutating any record breaks verification at the mutated index.
- 🛡️ **Policy-as-code git hooks** — declarative `.contextengine/policy.json` with secret_patterns (with `paths` scoping — e.g. JWT pattern only in `docs/sessions/**`), diff-aware doc_coverage (replaces wall-clock staleness gates), deploy_verify_hosts, and bypass_tokens. Layered with gitleaks (~150 patterns) when installed.

Plus the persistent-memory + search layer carried over from the v1 line:
- 🔍 Hybrid BM25 + optional semantic search (Xenova MiniLM-L6 on CPU, no API keys; HF transformers is now `optionalDependencies` so cold install is 120 MB not 547 MB)
- 🧠 1,000+ persistent learnings that auto-surface in search
- 💾 Session save/load + Ed25519-signed PRO licenses
- 🪝 **Native Claude Code integration** — `opscontext install-skill` adds a discoverable skill to `~/.claude/skills/`; `opscontext sync-claude-md` maintains a managed block in your CLAUDE.md so the latest snapshot reaches the agent at every session start with zero MCP calls

Works with Claude Code, Cursor, Windsurf, VS Code Copilot, OpenClaw — anything that speaks MCP.

```bash
# Try it in 30 seconds:
npx @compr/opscontext-mcp init
npx @compr/opscontext-mcp install-skill --global
npx @compr/opscontext-mcp search "your query"
```

- npm: https://www.npmjs.com/package/@compr/opscontext-mcp (2.0.0 just shipped)
- VS Code Extension: https://marketplace.visualstudio.com/items?itemName=css-llc.contextengine
- GitHub: https://github.com/FASTPROD/ContextEngine

Free and open-core (BSL-1.1). PRO adds the 4 tools that consume the collected operational data (multi-project scoring, audit, port conflict scan, project list).

Previously published as `@compr/contextengine-mcp` — that one is now deprecated with a pointer at the new package. Same code, sharper positioning.

Would love feedback. Especially curious: how is everyone else handling the gap between "agent sees code" and "agent sees infra"?

---

### Post 2: r/ClaudeAI

**Title**: OpsContext — the ops + compliance backend Claude Code can't grow natively (MCP, native skills/CLAUDE.md/memory integration)

**Body**:

If you use Claude Code, you already get native skills, hooks, auto-memory, and CLAUDE.md loading. Those are great for your code. What Claude Code can't see — and won't, structurally — is your **live infra state**: which PM2 process is up, what nginx is routing, what's in your Docker containers right now.

I built **OpsContext for AI Agents** to fill that gap, designed specifically to layer on top of Claude Code's native systems rather than compete with them:

**OpsContext as Claude Code's ops + compliance backend:**

1. **Operational collectors** — PM2 / nginx / Docker / git / cron / `.env` (redacted) — read-only, all local. Your agent answers infra questions with reality.
2. **Tamper-evident audit log** — hash-chained JSONL covering every state change. `audit_verify` walks the chain. Produces evidence aligned with [SOC 2 CC7.2](docs/compliance/cc7.2.md) and [ISO 27001 A.12.4.1](docs/compliance/a.12.4.1.md) — not a certification of OpsContext itself.
3. **Policy-as-code hooks** — `.contextengine/policy.json` with diff-aware doc coverage (replaces 4-hour staleness gates), scoped secret patterns, deploy-verify hosts.
4. **Native Claude Code integration** (new in 2.0):
   - `opscontext install-skill --global` → adds an `opscontext` skill to `~/.claude/skills/`; Claude Code surfaces it via native skills loading.
   - `opscontext sync-claude-md` → maintains a managed block inside your CLAUDE.md with top learnings + active policy gates + recent hook blocks. Since Claude Code loads CLAUDE.md at every session start, the snapshot reaches the agent with **zero MCP calls**.
   - Auto-discovery of `~/.claude/projects/*/memory/*.md` — anything you told Claude to remember becomes searchable through `search_context`.

Plus persistent learnings (1000+ accumulated rules), session save/load, Ed25519-signed PRO licenses, gitleaks wrapper in the pre-commit hook, BM25 + optional semantic search (HF transformers moved to `optionalDependencies` — cold install dropped from 547 MB to 120 MB).

Setup for Claude Desktop:
```json
{
  "mcpServers": {
    "OpsContext": {
      "command": "npx",
      "args": ["-y", "@compr/opscontext-mcp"]
    }
  }
}
```

For Claude Code (project-level):
```bash
npx @compr/opscontext-mcp install-skill --global
# Then drop .vscode/mcp.json (or your client's MCP config) pointing at the same package
```

Everything runs locally. No API keys. Semantic search uses Xenova/all-MiniLM-L6-v2 on CPU.

GitHub: https://github.com/FASTPROD/ContextEngine
npm: https://www.npmjs.com/package/@compr/opscontext-mcp (2.0.0 just shipped; previous `@compr/contextengine-mcp` is deprecated and points here)

---

### Post 3: r/vscode

**Title**: VS Code extension + MCP backend that keeps AI agents honest about your live infra — OpsContext

**Body**:

I built a VS Code extension that pairs with an MCP server to give Copilot Chat (and any other MCP-aware agent) the things it can't see on its own: **your live infra state, a tamper-evident audit log, and policy-as-code git hooks**.

**The problem**: Copilot and friends will happily write code all day, suggesting nginx config changes without knowing what's actually deployed, generating Docker commands without seeing your real container state, and missing the `--no-verify`-shaped escape hatches your team relies on. By the time you notice, you have 50 modified files, a stale staging environment, and zero audit trail.

**OpsContext (the VS Code extension)** adds:

- **Value Meter** in the status bar — recalls, saves, estimated time saved
- **Live stats dashboard** — real-time session metrics
- **@opscontext chat participant** — `/status`, `/commit`, `/search`, `/sync` commands
- **Terminal watcher** — classifies commands (git, deploy, test, etc.), redacts credentials, detects stuck patterns
- **Escalating notifications** when files pile up without commits
- **One-click commit** across all repos

**The MCP server underneath** (`@compr/opscontext-mcp`, just hit 2.0) provides:

- Read-only operational collectors (PM2/nginx/Docker/git/cron) so the agent sees what's actually running
- Hash-chained tamper-evident audit log producing evidence aligned with SOC 2 CC7.2 and ISO 27001 A.12.4.1 (evidence, not a certification — see `docs/compliance/`)
- Declarative `.contextengine/policy.json` consumed by a CLI-driven pre-commit hook (gitleaks + scoped patterns + diff-aware doc coverage)
- 1,000+ persistent learnings that auto-surface in search
- Ed25519-signed PRO licenses

Install from marketplace: https://marketplace.visualstudio.com/items?itemName=css-llc.contextengine

The extension is free. The MCP server is open-core (search + memory + audit log + policy hooks free; multi-project scoring + cross-project audit + port conflict scan PRO).

npm: https://www.npmjs.com/package/@compr/opscontext-mcp

---

### Post 4: r/LocalLLaMA

**Title**: Local-first MCP server — BM25 + optional CPU semantic search + tamper-evident audit log, zero API calls

**Body**:

For the privacy-conscious: I built an MCP server where **nothing leaves your machine** by construction.

**Search stack:**
- Keyword: BM25 with IDF scoring (instant, ships always)
- Semantic: optional `@huggingface/transformers` + Xenova/all-MiniLM-L6-v2 on CPU. Now in `optionalDependencies` — cold install is 120 MB if you skip semantic, ~250 MB extra if you opt in
- Hybrid ranking with temporal decay
- Embedding cache: ~200ms from disk after first run
- No API keys, no cloud, no telemetry

**What it indexes:**
- Your project docs (`copilot-instructions.md`, `CLAUDE.md`, `SKILLS.md`, `.cursorrules`, `AGENTS.md`, `CONTEXT_MAP.md`)
- Live operational state via local collectors (git log, package.json, .env redacted, Docker, docker-compose, PM2, nginx, crontab, shell history, composer, systemd)
- **Claude Code auto-memory** (`~/.claude/projects/*/memory/*.md`) — new in 2.0, so anything you told Claude to remember is also searchable

**Storage at rest:**
- Learnings: `~/.contextengine/learnings.json` (local append-only)
- Sessions: `~/.contextengine/sessions/*.json`
- **Tamper-evident audit log: `~/.contextengine/audit.log`** — hash-chained JSONL, SHA-256 over canonical-serialized records. `audit_verify` walks the chain and reports the mutated index on tamper. Each entry carries metadata only (IDs + categories + lengths), never rule text or session content.
- Activation server (PRO) receives only machine fingerprint + license key. License responses are **Ed25519-signed** so the client can detect tampering of the local `license.json`. Public key embedded in client; `CE_LICENSE_PUBLIC_KEY` env var override for self-hosters running their own activation server.

**Stats:**
~7K lines of TypeScript, 182 tests, 3 runtime deps (`@modelcontextprotocol/sdk`, `zod`, optional `@huggingface/transformers`). BSL-1.1.

Works with any MCP client.

npm: https://www.npmjs.com/package/@compr/opscontext-mcp (2.0.0 just shipped)
GitHub: https://github.com/FASTPROD/ContextEngine

---

### Post 5: r/MCP

**Title**: OpsContext for AI Agents — MCP server with 20 tools + native Claude Code integration + hash-chained audit log

**Body**:

Sharing my MCP server, just hit 2.0 with a strategic pivot to "the ops + compliance layer Claude Code can't grow natively". Read-only fleet visibility, tamper-evident audit log, policy-as-code git hooks, persistent memory.

**20 MCP tools exposed:**
- `search_context` — hybrid BM25 + optional semantic search with mode selector. Indexes project docs, operational collectors, persistent learnings, **and** Claude Code's `~/.claude/projects/*/memory/` (new in 2.0)
- `list_sources` / `read_source` / `reindex` — knowledge-base inspection
- `save_session` / `load_session` / `list_sessions` / `delete_session` / `end_session` — session continuity + pre-flight checklist
- `save_learning` / `list_learnings` / `delete_learning` / `import_learnings` — persistent operational rules
- `audit_verify` — hash-chained audit log; produces evidence aligned with SOC 2 CC7.2 and ISO 27001 A.12.4.1 (not a certification of OpsContext itself — see `docs/compliance/`). Tamper / splice / forgery detected at the mutated index.
- `list_projects` / `check_ports` / `run_audit` / `score_project` — cross-project tooling (PRO)
- `activate` / `activation_status` — Ed25519-signed PRO license management

**CLI subcommands (21):** init, search, list-sources, list-projects, save/list/delete-learning, import-learnings, **export-learnings --project NAME** (cross-client confidentiality), save/load/list/delete-session, end-session, score, audit, activate, deactivate, stats, status, **policy validate/show**, **hook secret-scan/doc-coverage**, **audit-export/audit-verify**, **install-skill** (drops the skill into ~/.claude/skills/), **sync-claude-md** (maintains a managed block in CLAUDE.md).

**Key architectural decisions:**
- stdio transport (works everywhere — Claude Code, Cursor, Windsurf, Copilot Chat, OpenClaw)
- Auto-discovery (zero config needed)
- Three-layer secret scanner (gitleaks ~150 patterns + scoped `policy.json` patterns + 17 inline CE patterns)
- Declarative `.contextengine/policy.json` consumed by the pre-commit hook + a `hook secret-scan` / `hook doc-coverage` CLI for CI use
- Hash-chained audit log with per-event canonical SHA-256 serialization. `CONTEXTENGINE_HOME` env var lets tests run in tmpdir without polluting `~/.contextengine`.
- HF transformers is `optionalDependencies` — opt-in to semantic search

npm: https://www.npmjs.com/package/@compr/opscontext-mcp
GitHub: https://github.com/FASTPROD/ContextEngine
CHANGELOG: https://github.com/FASTPROD/ContextEngine/blob/main/CHANGELOG.md

Previously published as `@compr/contextengine-mcp` — that name is now deprecated with a pointer at the new package. Same code, sharper positioning.

---

## 🎬 HeyGen Video Script (45 seconds)

**For use with**: https://app.heygen.com — AI avatar + screenshot overlays

### Scene 1 (0-15s) — Problem + Solution
**Avatar says**: "Claude Code reads your code. It cannot see what's actually running on your servers. OpsContext for AI Agents fills the gap — read-only visibility into PM2, nginx, Docker, plus a tamper-evident audit log and policy-as-code git hooks."

**Screen**: Show Screenshot 1 (search results in Copilot Chat showing operational data)

### Scene 2 (15-30s) — Key Features
**Avatar says**: "Operational collectors snapshot your live infra. A hash-chained audit log produces evidence aligned with SOC 2 CC7.2 and ISO 27001 A.12.4.1 — that's evidence for your auditor, not a certification of OpsContext itself. Policy-as-code git hooks block secrets and stale docs before they hit your branches. And native Claude Code integration drops a skill into your skills directory and a managed block into your CLAUDE.md — so the snapshot reaches the agent at every session start."

**Screen**: Show Screenshot 4 (firewall nudge) → Screenshot 5 (score report) → Screenshot 2 (status bar)

### Scene 3 (30-45s) — CTA
**Avatar says**: "Set up in thirty seconds with npx. Free VS Code extension included. OpsContext for AI Agents — the ops layer your agent doesn't have yet. Link in the description."

**Screen**: Show `npx @compr/opscontext-mcp init && npx @compr/opscontext-mcp install-skill --global` → npm page + VS Code marketplace + GitHub repo

---

## 🐾 ClawHub / OpenClaw Listing — BACKLOG

**Status**: Deferred. The OpenClaw/ClawHub marketplace does not currently resolve to a publicly accessible platform.
Revisit when/if that marketplace materializes. The Open WebUI community (125K stars, 340K members) is an alternative,
but requires a Python wrapper or mcpo bridge since ContextEngine is a Node.js MCP server.

---

## 🐳 Docker — CANCELLED

**Decision**: No Docker for ContextEngine. Users install via `npx @compr/opscontext-mcp`. The activation server runs PM2 on VPS. The 5 score points are not worth the maintenance overhead. Score stays at 95% A+.

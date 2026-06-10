# OpsContext for AI Agents

**The ops + compliance layer Claude Code can't grow natively.** Read-only visibility into PM2 / nginx / Docker / git / cron — plus a tamper-evident audit log and policy-as-code git hooks.

> Previously published as `@compr/contextengine-mcp`. The 2.0 rename reflects what the project actually does: Claude Code sees the **code**, OpsContext sees the **infra that runs it**.

[![npm](https://img.shields.io/npm/v/@compr/opscontext-mcp)](https://www.npmjs.com/package/@compr/opscontext-mcp)
[![License: BSL-1.1](https://img.shields.io/badge/License-BSL--1.1-blue.svg)](https://www.npmjs.com/package/@compr/opscontext-mcp)
[![VS Code](https://img.shields.io/badge/VS%20Code-Extension-007ACC?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=css-llc.contextengine)

OpsContext is an [MCP](https://modelcontextprotocol.io) server. It runs locally, snapshots your live infra (PM2 processes, nginx config, Docker containers, git status, cron jobs, redacted env), and exposes it via tools your AI coding agents (Claude Code, Cursor, Copilot, Windsurf, OpenClaw) can call in real time. Everything stays on your machine — no telemetry, no code uploads.

## Why

Claude Code already reads your `CLAUDE.md`, `copilot-instructions.md`, and source files. It has hooks, skills, and native memory. It does not — and structurally cannot — see what's running on your servers. Live process state, nginx routes, port conflicts across fleets, git working-tree drift across 30+ repos — that's the operational context AI agents lack.

OpsContext fills that gap, plus two compliance layers regulated industries demand from any agent stack:

1. **Operational visibility (the moat)** — collectors for PM2 / nginx / Docker / git / cron / .env (redacted) / composer / systemd. Cross-project + check_ports + fleet HTML scoring. Claude Code can't see this; we feed it cleanly.
2. **Tamper-evident audit log (compliance)** — hash-chained JSONL at `~/.contextengine/audit.log`. Every state change recorded with `prev_hash`/`hash`. SOC2 CC7.2 and ISO 27001 A.12.4.1 evidence out of the box.
3. **Policy-as-code hooks (enforcement)** — declarative `.contextengine/policy.json` for secret patterns (with `paths` scoping), diff-aware doc coverage (replaces the workaround-y 4-hour staleness gate), deploy-verify hosts, and signed bypass tokens. Runs as a pre-commit hook layer alongside gitleaks.

Plus the persistent-memory + search features carried forward from the contextengine era:

- 🔍 **Hybrid Search** — keyword (BM25) ships always; semantic re-ranking is opt-in
- 🧠 **Semantic Search (optional)** — `all-MiniLM-L6-v2` runs locally on CPU, no API keys. Install with `npm install @huggingface/transformers` (~250MB, native onnxruntime). BM25 alone is plenty for most workspaces; turn semantic on when you have many similar projects and want fuzzy matches.
- 📁 **Auto-discover** — finds `copilot-instructions.md`, `CLAUDE.md`, `.cursorrules`, `AGENTS.md` across all projects
- 💻 **Code Parsing** — extracts functions, classes, interfaces from TS/JS/Python source files
- ⚙️ **Operational Intelligence** — collects git, Docker, PM2, nginx, cron, package.json data
- 🔒 **Local-only** — nothing leaves your machine
- ⚡ **Instant startup** — keyword search ready immediately, embeddings load in background
- 💾 **Session Persistence** — AI agents can save/restore context across conversations
- 💡 **Learning Store** — permanent operational rules that auto-surface in search results
- �️ **Protocol Firewall** — progressive enforcement that ensures agents commit, document, and save learnings
- �🔌 **Plugin Adapters** — extend with custom data sources (Notion, Jira, RSS, etc.)
- 🧩 **MCP native** — works with any MCP-compatible client (VS Code, Claude, Cursor, OpenClaw)

### What OpsContext is NOT

- **Not a replacement for Claude Code, Cursor, or your IDE assistant.** It runs *alongside* them as their ops/compliance backend. Code context = their job. Infra context + audit + policy = ours.
- **Not a code quality tool** — it checks project structure (CI, tests, Docker, docs) and validates content depth, but won't tell you if your code is good. An A+ score means "well-organized for AI agents," not "production-ready."
- **Not required for tiny / solo projects** — agents read `copilot-instructions.md` natively, and the audit log + policy gates earn their keep when there's more than one developer to coordinate or a compliance officer to answer to.
- **Not worth chasing 100% score** — invest in your PIPELINES.md and SKILLS docs instead of score-chasing. Those prevent costly mistakes; the score keeps you honest.

## Quick Start

### 1. Scaffold config (optional)

```bash
npx @compr/opscontext-mcp init
```

Detects your project type, creates `contextengine.json` + `.github/copilot-instructions.md` template.

### 2. Add to your MCP client

**VS Code (recommended — per-project setup)**

Create `.vscode/mcp.json` in your project root:

```json
{
  "servers": {
    "contextengine": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@compr/opscontext-mcp"]
    }
  }
}
```

This activates ContextEngine when the workspace is open. Add this file to each project that needs it.

> **Note:** VS Code deprecated MCP configuration in user `settings.json`. Use `.vscode/mcp.json` per workspace instead.

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ContextEngine": {
      "command": "npx",
      "args": ["-y", "@compr/opscontext-mcp"]
    }
  }
}
```

**Cursor** — add to MCP settings:

```json
{
  "mcpServers": {
    "ContextEngine": {
      "command": "npx",
      "args": ["-y", "@compr/opscontext-mcp"]
    }
  }
}
```

**OpenClaw** — add ContextEngine as an MCP server in your OpenClaw config, or use the bundled skill:

```bash
# Option 1: Copy the skill to your OpenClaw workspace
cp -r node_modules/@compr/opscontext-mcp/skills/contextengine ~/.openclaw/workspace/skills/

# Option 2: Add as MCP server in openclaw.json
```

```json
{
  "mcpServers": {
    "contextengine": {
      "command": "npx",
      "args": ["-y", "@compr/opscontext-mcp"],
      "env": { "CONTEXTENGINE_WORKSPACES": "~/Projects" }
    }
  }
}
```

### 3. Pin your config (recommended)

If you have a `contextengine.json` with custom sources, add this to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export CONTEXTENGINE_CONFIG="$HOME/path/to/contextengine.json"
```

Without this, ContextEngine falls back to auto-discovery (finds `copilot-instructions.md` etc.) but won't load your explicit sources, code dirs, or custom patterns.

That's it. ContextEngine auto-discovers your docs in `~/Projects`.

## 📦 VS Code Extension

ContextEngine has a **free VS Code extension** that provides proactive enforcement — no MCP setup required:

[![Install Extension](https://img.shields.io/badge/Install-VS%20Code%20Marketplace-007ACC?logo=visualstudiocode&style=for-the-badge)](https://marketplace.visualstudio.com/items?itemName=css-llc.contextengine)

- **📊 Value meter** — shows what ContextEngine saved you this session: learnings recalled, learnings saved, estimated time saved. Falls back to git status when no MCP session is active
- **📈 Live stats dashboard** — click ℹ️ to see real-time session metrics (tool calls, recalls, nudges, truncations, time saved)
- **@contextengine chat** — `/status`, `/commit`, `/search`, `/remind`, `/sync` in Copilot Chat
- **Escalating notifications** — warns when files accumulate without commits
- **Terminal watcher** — monitors commands with smart classification (git, deploy, database, python, build, test), credential redaction in logs, and stuck-pattern detection (alerts after 3+ consecutive failures)
- **One-click commit** — commit all changes across all repos

The extension reads live metrics from the MCP server (via `~/.contextengine/session-stats.json`). For search, learnings, sessions, and scoring — it uses the MCP server (`npx @compr/opscontext-mcp`).

## ⭐ PRO Features

ContextEngine is **free and open-core**. The free tier covers everything agents need — search, memory, sessions, and compliance enforcement. PRO adds **team and ops intelligence** across multiple projects:

| Feature | Free | PRO |
|---------|------|-----|
| Hybrid search (keyword + semantic) | ✅ | ✅ |
| Persistent learnings | ✅ | ✅ |
| Session save/load | ✅ | ✅ |
| End-of-session enforcement | ✅ | ✅ |
| Protocol Firewall (agent compliance) | ✅ | ✅ |
| VS Code extension (git monitor, chat) | ✅ | ✅ |
| Plugin adapters | ✅ | ✅ |
| **Project health score (A+ to F)** | — | ✅ |
| **Compliance audit** | — | ✅ |
| **Port conflict detection** | — | ✅ |
| **Multi-project discovery** | — | ✅ |
| **HTML score reports** | — | ✅ |

### Pricing

| Plan | Price | Machines |
|------|-------|----------|
| **Pro** | CHF 2/mo | 2 |
| **Team** | CHF 12/mo | 5 |
| **Enterprise** | CHF 36/mo | 10 |

→ **[Get PRO](https://api.compr.ch/contextengine/pricing)** · Annual plans save 17%

```bash
# Activate after purchase
npx @compr/opscontext-mcp activate
```

## CLI Usage (no MCP required)

ContextEngine also works as a **standalone CLI tool** — no MCP client setup needed:

```bash
# Search across all your project knowledge
npx @compr/opscontext-mcp search "docker nginx"
npx @compr/opscontext-mcp search "rate limiting" -n 10

# List all indexed sources
npx @compr/opscontext-mcp list-sources

# Discover and analyze all projects
npx @compr/opscontext-mcp list-projects

# AI-readiness score (one or all projects)
npx @compr/opscontext-mcp score
npx @compr/opscontext-mcp score ContextEngine

# Visual HTML report (opens in browser)
npx @compr/opscontext-mcp score --html
npx @compr/opscontext-mcp score ContextEngine --html

# List permanent learnings (optionally by category)
npx @compr/opscontext-mcp list-learnings
npx @compr/opscontext-mcp list-learnings security

# Show live MCP session stats (value meter)
npx @compr/opscontext-mcp stats

# Run compliance audit across all projects
npx @compr/opscontext-mcp audit

# Scaffold config for a new project
npx @compr/opscontext-mcp init

# Show all commands
npx @compr/opscontext-mcp help
```

CLI mode uses keyword search (BM25) which is instant — no model loading required.

## Tools (20)

| Tool | Description | Tier |
|------|-------------|------|
| `search_context` | Hybrid keyword+semantic search with mode selector | Free |
| `list_sources` | Show all indexed sources with chunk counts | Free |
| `read_source` | Read full content of a knowledge source by name | Free |
| `reindex` | Force full re-index of all sources | Free |
| `save_session` | Save key-value entry to a named session | Free |
| `load_session` | Load all entries from a named session | Free |
| `list_sessions` | List all saved sessions | Free |
| `delete_session` | Delete a saved session | Free |
| `end_session` | Pre-flight checklist — uncommitted changes + doc freshness | Free |
| `save_learning` | Save a permanent operational rule — auto-surfaces in search | Free |
| `list_learnings` | List all permanent learnings, optionally by category | Free |
| `delete_learning` | Remove a learning by ID | Free |
| `import_learnings` | Bulk-import learnings from Markdown or JSON files | Free |
| `audit_verify` | Verify tamper-evident audit log chain (SOC2 CC7.2, ISO 27001 A.12.4.1) | Free |
| `activate` | Activate a PRO license on this machine | Free |
| `activation_status` | Check current license status | Free |
| `list_projects` | Discover and analyze all projects (tech stack, git, docker) | PRO |
| `check_ports` | Scan all projects for port conflicts | PRO |
| `run_audit` | Compliance agent — git, hooks, .env, Docker, PM2, versions | PRO |
| `score_project` | AI-readiness scoring 0-100% with letter grades (A+ to F) | PRO |

All tools are wrapped by the **Protocol Firewall** — a built-in enforcement layer that ensures agents save learnings, persist sessions, and commit code. No action needed from users; it's automatic.

## Configuration

ContextEngine works **zero-config** — it auto-discovers documentation files in `~/Projects`.

For full control, create a `contextengine.json`:

```json
{
  "sources": [
    { "name": "Team Runbook", "path": "./docs/RUNBOOK.md" },
    { "name": "Architecture", "path": "./docs/ARCHITECTURE.md" }
  ],
  "workspaces": ["~/Projects"],
  "patterns": [
    ".github/copilot-instructions.md",
    "CLAUDE.md",
    ".cursorrules",
    "AGENTS.md"
  ],
  "codeDirs": ["src"],
  "adapters": [
    { "name": "feeds", "module": "./adapters/rss-adapter.js", "config": { "feeds": ["https://blog.example.com/rss.xml"] } }
  ]
}
```

### Auto-discovered patterns

| Pattern | Description |
|---------|-------------|
| `.github/copilot-instructions.md` | GitHub Copilot project instructions |
| `.github/instructions/copilot-instructions.md` | VS Code instructions folder format |
| `.github/SKILLS.md` | Team skills inventory |
| `CLAUDE.md` | Claude Code project instructions |
| `.cursorrules` | Cursor AI rules |
| `.cursor/rules` | Cursor AI rules (folder format) |
| `AGENTS.md` | Multi-agent instructions |
| `CONTEXT_MAP.md` | File-to-concern mapping for agents |

### Config resolution order

| Priority | Source |
|----------|--------|
| 1 | `CONTEXTENGINE_CONFIG` env var |
| 2 | `./contextengine.json` |
| 3 | `~/.contextengine.json` |
| 4 | `CONTEXTENGINE_WORKSPACES` env var |
| 5 | `~/Projects` auto-discover |

## Plugin Adapters

Extend ContextEngine with custom data sources via the adapter interface. Adapters are ES modules that collect data and return searchable chunks.

```json
{
  "adapters": [
    {
      "name": "notion",
      "module": "./adapters/notion-adapter.js",
      "config": { "token": "$NOTION_API_TOKEN" }
    },
    {
      "name": "feeds",
      "module": "./adapters/rss-adapter.js",
      "config": { "feeds": ["https://blog.example.com/rss.xml"], "maxItems": 20 }
    }
  ]
}
```

### Creating an Adapter

An adapter is a JS/TS module that exports an object with a `collect()` method:

```javascript
// my-adapter.js
export default {
  name: "my-source",
  description: "Fetches data from My Source",

  validate(config) {
    if (!config?.apiKey) return "Missing apiKey";
    return null;
  },

  async collect(config) {
    // Fetch data and return Chunk[]
    return [{
      source: "my-source",
      section: "## Title",
      content: "Content to index...",
      lineStart: 1,
      lineEnd: 1,
    }];
  },
};
```

See [examples/adapters/](examples/adapters/) for complete Notion and RSS adapter examples.

### Adapter Features

- **Environment variable resolution** — use `"$ENV_VAR"` syntax in config
- **Factory pattern** — export `createAdapter(config)` for per-instance configuration
- **Validation** — optional `validate()` method checks config before collection
- **Lifecycle hooks** — optional `init()` and `destroy()` for setup/cleanup
- **Safe execution** — adapter failures never crash the server

## How It Works

```
Your Project Files           ContextEngine              AI Agent
+-----------------+    +-------------------+    +---------------+
| copilot-        |    | 1. Parse & chunk  |    | GitHub        |
|  instructions   |--->| 2. Embed vectors  |<-->|  Copilot      |
| CLAUDE.md       |    | 3. Hybrid search  |    | Claude        |
| source code     |    | 4. Return top-k   |    | Cursor        |
| git/docker/pm2  |    | 5. Persist state  |    | Windsurf      |
+-----------------+    +-------------------+    +---------------+
                            stdio (MCP)
```

1. **Parse** — chunks markdown + extracts functions from source code
2. **Embed** — sentence embeddings run locally on CPU (no API keys)
3. **Search** — hybrid keyword + semantic scoring
4. **Collect** — operational data from git, package.json, Docker, PM2, nginx
5. **Audit** — compliance checks, port conflicts, AI-readiness scoring

## Scoring

The `score` command evaluates project AI-readiness across **documentation, infrastructure, code quality, and security** — producing a letter grade from A+ to F.

**Grade scale:** A+ (90%+) · A (80%+) · B (70%+) · C (60%+) · D (50%+) · F (<50%)

### Project Naming & Structure Tips

The scorer discovers projects from your configured `workspaces` directories (default: `~/Projects`).
Each subdirectory is treated as a separate project. For best results:

- **Use descriptive folder names** — the folder name becomes the project name in reports
- **Keep one project per directory** — monorepos should have a root `copilot-instructions.md`
- **Real files over symlinks** — each project should have its own configs with project-specific content
- **Install your tools** — a linting config without the linter installed doesn't count as linting

## Architecture

TypeScript monorepo — MCP server + CLI + search engine + operational collectors.

See the [npm package](https://www.npmjs.com/package/@compr/opscontext-mcp) for installation and usage.

## Development

```bash
npm install @compr/opscontext-mcp
npx @compr/opscontext-mcp help
```

## Requirements

- Node.js 18+
- No API keys needed — embeddings run locally

## Contributing

Feedback, feature requests, and bug reports welcome — email [yannick@compr.ch](mailto:yannick@compr.ch).

If you're using ContextEngine, we'd love to hear about it.

## Privacy & Data Security

**ContextEngine runs 100% on your machine. Your code, your data, your rules.**

Everything happens locally — search, scoring, learnings, sessions, embeddings. No project data is ever sent to an external server.

### What stays on your machine (always)

| Data | Storage | Leaves your machine? |
|---|---|---|
| Project files & source code | Read locally, never stored externally | ❌ Never |
| Learnings (operational rules) | `~/.contextengine/learnings.json` | ❌ Never |
| Sessions (decisions, progress) | `~/.contextengine/sessions/` | ❌ Never |
| Session stats (value meter) | `~/.contextengine/session-stats.json` | ❌ Never |
| Search index & embeddings | In-memory + `~/.contextengine/embedding-cache.json` | ❌ Never |
| Git history & branches | Local `git` commands | ❌ Never |
| Dependencies & package.json | Read locally | ❌ Never |
| .env variable names | Read locally (values are never read) | ❌ Never |

### What the activation server receives (PRO only)

| Data | When | Purpose |
|---|---|---|
| License key (`CE-XXXX-...`) | Activation + daily heartbeat | Validate subscription |
| Machine ID (SHA-256 hash) | Activation + daily heartbeat | Enforce machine limit |
| Platform/arch (e.g., `darwin/arm64`) | Activation only | Compatibility check |

**The server never receives:** project names, file contents, learnings, sessions, git history, dependencies, code, .env variables, or anything about your actual work.

### Why this matters

Most AI coding tools (Copilot, Cursor, Codeium) send your code to external servers for processing. ContextEngine takes the opposite approach — **embeddings run locally on CPU**, search runs locally, and all persistent state stays in `~/.contextengine/` on your disk. The only network call is a lightweight license check for PRO users.

## License

BSL-1.1 (Business Source License) — see [LICENSE](LICENSE).

You may use ContextEngine for any purpose, including production, **except** offering it as a hosted/managed service competing with ContextEngine PRO/Team/Enterprise.

Converts to AGPL-3.0 on February 22, 2030.

For commercial licensing: [yannick@compr.ch](mailto:yannick@compr.ch)

---

## Built by [PROD LLC](https://compr.fr)

ContextEngine is built by the team behind
[compr.app](https://compr.app) · [crowlr.io](https://crowlr.io) · [crowlr.com](https://crowlr.com) · [invoc.io](https://invoc.io) · [plank.io](https://plank.io) · [konive.com](https://konive.com) · [invoc.me](https://invoc.me)

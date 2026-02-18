# ContextEngine

**An MCP server that turns your project documentation into a queryable knowledge base for AI agents.**

ContextEngine indexes your `copilot-instructions.md`, `SKILLS.md`, `CLAUDE.md`, runbooks, and source code — then exposes it via the [Model Context Protocol](https://modelcontextprotocol.io) so AI coding assistants (GitHub Copilot, Claude, Cursor, Windsurf) can search your accumulated knowledge in real time.

## Why

AI coding agents are powerful — but they forget everything between sessions. Your team's hard-won knowledge lives in scattered markdown files that agents can't search.

ContextEngine fixes this: **zero-config, fully local, privacy-first.**

- 🔍 **Hybrid Search** — keyword + semantic (vector embeddings) across all your docs
- 🧠 **Semantic Search** — `all-MiniLM-L6-v2` runs locally on CPU (no API keys)
- 📁 **Auto-discover** — finds `copilot-instructions.md`, `CLAUDE.md`, `.cursorrules`, `AGENTS.md` across all projects
- 💻 **Code Parsing** — extracts functions, classes, interfaces from TS/JS/Python source files
- ⚙️ **Operational Intelligence** — collects git, Docker, PM2, nginx, cron, package.json data
- 🔒 **Local-only** — nothing leaves your machine
- ⚡ **Instant startup** — keyword search ready immediately, embeddings load in background
- 💾 **Session Persistence** — AI agents can save/restore context across conversations
- � **Learning Store** — permanent operational rules that auto-surface in search results
- �🔌 **MCP native** — works with any MCP-compatible client

## Quick Start

### 1. Scaffold config (optional)

```bash
npx @compr/contextengine-mcp init
```

Detects your project type, creates `contextengine.json` + `.github/copilot-instructions.md` template.

### 2. Add to your MCP client

**VS Code (recommended — global setup)**

Create `~/Library/Application Support/Code/User/mcp.json` (macOS) or `~/.config/Code/User/mcp.json` (Linux):

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

This makes ContextEngine available in **every VS Code workspace** automatically — no per-project config needed.

> **Per-project alternative:** Create `.vscode/mcp.json` in any repo with the same content. This only activates ContextEngine when that workspace is open.

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

**Cursor** — add to MCP settings:

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

### 3. Pin your config (recommended)

If you have a `contextengine.json` with custom sources, add this to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export CONTEXTENGINE_CONFIG="$HOME/path/to/contextengine.json"
```

Without this, ContextEngine falls back to auto-discovery (finds `copilot-instructions.md` etc.) but won't load your explicit sources, code dirs, or custom patterns.

That's it. ContextEngine auto-discovers your docs in `~/Projects`.

## Tools (15)

| Tool | Description |
|------|-------------|
| `search_context` | Hybrid keyword+semantic search with mode selector |
| `list_sources` | Show all indexed sources with chunk counts |
| `read_source` | Read full content of a knowledge source by name |
| `reindex` | Force full re-index of all sources |
| `list_projects` | Discover and analyze all projects (tech stack, git, docker, pm2) |
| `check_ports` | Scan all projects for port conflicts |
| `run_audit` | Compliance agent — git, hooks, .env, Docker, PM2, versions |
| `score_project` | AI-readiness scoring 0-100% with letter grades (A+ to F) |
| `save_session` | Save key-value entry to a named session |
| `load_session` | Load all entries from a named session |
| `list_sessions` | List all saved sessions |
| `end_session` | Pre-flight checklist — checks uncommitted changes + doc freshness |
| `save_learning` | Save a permanent operational rule — auto-surfaces in search results |
| `list_learnings` | List all permanent learnings, optionally filtered by category |
| `import_learnings` | Bulk-import learnings from Markdown or JSON files |

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
  "codeDirs": ["src"]
}
```

### Auto-discovered patterns

| Pattern | Description |
|---------|-------------|
| `.github/copilot-instructions.md` | GitHub Copilot project instructions |
| `.github/SKILLS.md` | Team skills inventory |
| `CLAUDE.md` | Claude Code project instructions |
| `.cursorrules` | Cursor AI rules |
| `.cursor/rules` | Cursor AI rules (folder format) |
| `AGENTS.md` | Multi-agent instructions |

### Config resolution order

| Priority | Source |
|----------|--------|
| 1 | `CONTEXTENGINE_CONFIG` env var |
| 2 | `./contextengine.json` |
| 3 | `~/.contextengine.json` |
| 4 | `CONTEXTENGINE_WORKSPACES` env var |
| 5 | `~/Projects` auto-discover |

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

1. **Parse** — markdown heading-based chunker + code parser (TS/JS/Python)
2. **Embed** — `all-MiniLM-L6-v2` sentence embeddings (384-dim, local CPU)
3. **Search** — hybrid scoring: 40% keyword overlap + 60% cosine similarity
4. **Collect** — operational data from git, package.json, Docker, PM2, nginx, cron
5. **Audit** — compliance checks, port conflicts, AI-readiness scoring

### Performance

| Metric | Value |
|--------|-------|
| Startup (keyword ready) | Instant |
| Startup (semantic ready) | ~200ms from cache, ~15s first run |
| Embedding speed | ~50 chunks/sec (Apple Silicon) |
| Embedding cache | `~/.contextengine/embedding-cache.json` |
| Session storage | `~/.contextengine/sessions/` |
| Learnings storage | `~/.contextengine/learnings.json` |

## Architecture

```
src/
├── cli.ts           # CLI - init scaffolding, help, routes to MCP
├── index.ts         # MCP server - 15 tools, resources, file watcher
├── config.ts        # Config loading, auto-discovery, 7 patterns
├── ingest.ts        # Markdown heading-based chunker
├── search.ts        # Keyword search - term overlap scoring
├── embeddings.ts    # MiniLM-L6-v2 - vector search, cosine similarity
├── cache.ts         # Embedding cache - SHA-256 hash invalidation
├── code-chunker.ts  # Code parser - TS/JS/Python function extraction
├── collectors.ts    # 11 operational data collectors
├── agents.ts        # Compliance auditor, port checker, AI scorer
├── sessions.ts      # Session persistence - key-value store
└── learnings.ts     # Permanent learning store - auto-indexed rules
```

## Development

```bash
git clone https://github.com/FASTPROD/ContextEngine.git
cd ContextEngine
npm install
npm run build
npm start
```

## Requirements

- Node.js 18+
- No API keys needed — embeddings run locally

## Contributing

Issues, feature requests, and PRs welcome at [github.com/FASTPROD/ContextEngine](https://github.com/FASTPROD/ContextEngine/issues).

If you're using ContextEngine, we'd love to hear about it — feedback helps us improve.

## License

AGPL-3.0 — see [LICENSE](LICENSE).

For commercial licensing: yannick@compr.ch

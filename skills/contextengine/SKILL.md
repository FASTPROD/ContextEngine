---
name: contextengine
description: "Queryable knowledge base for AI coding agents via MCP. Hybrid BM25 + semantic search across project docs, operational data (git, docker, pm2, nginx), and persistent learnings. Use when: (1) searching project documentation or context files, (2) collecting operational insights from workspaces, (3) storing and retrieving persistent learnings across sessions, (4) auditing project compliance or AI-readiness, (5) managing session data. Zero API keys — runs 100% locally with CPU embeddings."
homepage: https://github.com/FASTPROD/ContextEngine
metadata: { "openclaw": { "emoji": "🧠", "requires": { "bins": ["npx"] }, "homepage": "https://github.com/FASTPROD/ContextEngine" } }
---

# ContextEngine — Knowledge Base for AI Agents

ContextEngine turns your project documentation into a **queryable knowledge base** with hybrid BM25 keyword + semantic vector search. Zero API keys required — embeddings run locally on CPU.

## Quick Start

### 1. Initialize (one-time per project)

```bash
npx @compr/contextengine-mcp init
```

Creates `contextengine.json` config + `.github/copilot-instructions.md` template in the current directory.

### 2. Search your knowledge base

```bash
# Ask the agent to search for context
search_context "deployment docker nginx setup"
```

ContextEngine auto-discovers documentation files from 7 common patterns:
- `.github/copilot-instructions.md`
- `.github/SKILLS.md`
- `CLAUDE.md`
- `.cursorrules`
- `.cursor/rules`
- `AGENTS.md`

## CLI Usage (no MCP required)

ContextEngine also works as a standalone CLI tool — no MCP client needed:

```bash
npx @compr/contextengine-mcp search "docker nginx"    # Search knowledge base
npx @compr/contextengine-mcp list-sources              # Show indexed sources
npx @compr/contextengine-mcp list-projects             # Discover all projects
npx @compr/contextengine-mcp score                     # AI-readiness score
npx @compr/contextengine-mcp score --html               # Visual HTML report
npx @compr/contextengine-mcp list-learnings security   # List learnings by category
npx @compr/contextengine-mcp audit                     # Compliance audit
npx @compr/contextengine-mcp help                      # Show all commands
```

## MCP Server Setup

ContextEngine runs as an **MCP server** via stdio transport. Configure it in your MCP client:

### VS Code (Global)

Add to `~/.vscode/mcp.json`:

```json
{
  "servers": {
    "contextengine": {
      "command": "npx",
      "args": ["-y", "@compr/contextengine-mcp"],
      "env": {
        "CONTEXTENGINE_WORKSPACES": "/path/to/your/projects"
      }
    }
  }
}
```

### Claude Desktop

Add to Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "contextengine": {
      "command": "npx",
      "args": ["-y", "@compr/contextengine-mcp"],
      "env": {
        "CONTEXTENGINE_WORKSPACES": "/path/to/your/projects"
      }
    }
  }
}
```

### OpenClaw MCP Config

Add to your OpenClaw `openclaw.json` MCP servers section:

```json
{
  "mcpServers": {
    "contextengine": {
      "command": "npx",
      "args": ["-y", "@compr/contextengine-mcp"],
      "env": {
        "CONTEXTENGINE_WORKSPACES": "/path/to/your/projects"
      }
    }
  }
}
```

## Available Tools (15)

| Tool | Description |
|------|-------------|
| `search_context` | Hybrid BM25+semantic search with temporal decay. Modes: hybrid, keyword, semantic |
| `list_sources` | Show all indexed sources with chunk counts and embedding status |
| `read_source` | Read full content of a knowledge source by name |
| `reindex` | Force full re-index of all sources |
| `list_projects` | Discover and analyze all projects (tech stack, git, docker, pm2) |
| `check_ports` | Scan all projects for port conflicts |
| `run_audit` | Compliance agent — git remotes, hooks, .env, Docker, PM2, versions |
| `score_project` | AI-readiness scoring 0-100% with anti-gaming v2 (symlink/ghost config detection) |
| `save_session` | Save key-value entry to a named session for cross-session persistence |
| `load_session` | Load all entries from a named session |
| `list_sessions` | List all saved sessions with entry counts and timestamps |
| `end_session` | Pre-flight checklist — checks uncommitted git changes + doc freshness |
| `save_learning` | Save a permanent operational rule — auto-surfaces in search results |
| `list_learnings` | List all permanent learnings, optionally filtered by category |
| `import_learnings` | Bulk-import learnings from Markdown or JSON files |

## Core Capabilities

### Hybrid Search

Combines three signals for optimal relevance:
- **40% BM25 keyword search** — IDF-weighted, rare terms rank higher
- **60% semantic similarity** — cosine distance via MiniLM-L6-v2 (22MB, local CPU)
- **Temporal decay** — 90-day half-life boosts recent content

```bash
# Search with mode selection
search_context "docker nginx proxy" --mode hybrid
search_context "deployment steps" --mode keyword
search_context "how to configure SSL" --mode semantic
```

### Operational Data Collection

Auto-collects from your projects (no setup needed):
- **Git**: branches, remotes, recent commits, hooks
- **package.json / composer.json**: dependencies, scripts
- **Docker**: Dockerfile, docker-compose services
- **PM2**: process list, ecosystem config
- **Nginx**: server blocks, proxy configs
- **.env**: variable names (never values)
- **Cron**: scheduled tasks

### Persistent Learnings

Save reusable patterns, bug fixes, and operational rules that auto-surface in search results:

```bash
# Save a learning
save_learning --category "deployment" --rule "Always use --platform linux/amd64 for cross-arch Docker builds" --context "Apple Silicon to AMD64 server"

# List by category
list_learnings --category "security"
```

16 categories: architecture, security, bug-patterns, deployment, testing, api, frontend, backend, infrastructure, tooling, devops, git, data, dependencies, performance, accessibility.

### Session Persistence

Save and restore key-value data across sessions:

```bash
save_session --name "project-x" --key "current_task" --value "Implementing auth flow"
load_session --name "project-x"
```

## Configuration

Create `contextengine.json` in your project root (or run `npx @compr/contextengine-mcp init`):

```json
{
  "sources": ["docs/architecture.md", "RUNBOOK.md"],
  "workspaces": ["/home/user/projects"],
  "patterns": [".github/copilot-instructions.md", "CLAUDE.md"],
  "codeDirs": ["src", "lib"]
}
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `CONTEXTENGINE_CONFIG` | Path to contextengine.json config file |
| `CONTEXTENGINE_WORKSPACES` | Colon-separated list of workspace directories |

## Architecture

- **Embeddings**: all-MiniLM-L6-v2 via @huggingface/transformers (22MB, local CPU, no API key)
- **Transport**: MCP SDK v1.26 via stdio
- **Chunking**: Markdown heading-based with 4-line overlap + code chunker (TS/JS/Python)
- **Dedup**: SHA-256 content hashing prevents duplicate chunks
- **Caching**: Embedding cache to disk (~/.contextengine/embedding-cache.json)
- **File watching**: fs.watch with 500ms debounce → auto re-index on changes
- **Non-blocking**: Keyword search available instantly, embeddings load in background

## Notes

- Requires **Node.js 18+**
- First run downloads the embedding model (~22MB) — subsequent runs use cache
- Keyword search is available instantly at startup; semantic search becomes available once the model loads
- License: AGPL-3.0 (modifications must be shared)
- npm: `@compr/contextengine-mcp`

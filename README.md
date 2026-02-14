# ContextEngine

**An MCP server that turns your project documentation into a queryable knowledge base for AI agents.**

ContextEngine indexes your `copilot-instructions.md`, `SKILLS.md`, runbooks, and any markdown documentation — then exposes it via the [Model Context Protocol](https://modelcontextprotocol.io) so AI coding assistants (GitHub Copilot, Claude, Cursor, Windsurf) can search your accumulated knowledge in real time.

## Why

AI coding agents are powerful — but they forget everything between sessions. Your team's hard-won knowledge lives in scattered markdown files that agents can't search.

ContextEngine fixes this: **zero-config, fully local, privacy-first.**

- 🔍 **Search** — keyword + relevance scoring across all your project docs
- 📁 **Auto-discover** — finds `copilot-instructions.md` in all your projects automatically
- 🔒 **Local-only** — nothing leaves your machine, no API keys needed
- ⚡ **Instant** — indexes hundreds of docs in milliseconds at startup
- 🔌 **MCP native** — works with any MCP-compatible client out of the box

## Quick Start

### Install

```bash
npm install -g contextengine
```

### Use with VS Code (GitHub Copilot)

Add to your `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "ContextEngine": {
      "command": "contextengine"
    }
  }
}
```

Or in your `.code-workspace` settings:

```json
{
  "settings": {
    "mcp": {
      "servers": {
        "ContextEngine": {
          "command": "contextengine"
        }
      }
    }
  }
}
```

### Use with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ContextEngine": {
      "command": "contextengine"
    }
  }
}
```

## Configuration

ContextEngine works **zero-config** — it auto-discovers `.github/copilot-instructions.md` files in `~/Projects`.

For full control, create a `contextengine.json` in your project root:

```json
{
  "sources": [
    { "name": "Team Runbook", "path": "./docs/RUNBOOK.md" },
    { "name": "Architecture", "path": "./docs/ARCHITECTURE.md" }
  ],
  "workspaces": [
    "~/Projects",
    "~/Work/repos"
  ],
  "patterns": [
    ".github/copilot-instructions.md",
    ".github/SKILLS.md",
    "docs/RUNBOOK.md"
  ]
}
```

### Configuration Resolution

| Priority | Source | Description |
|----------|--------|-------------|
| 1 | `CONTEXTENGINE_CONFIG` env var | Explicit path to config file |
| 2 | `./contextengine.json` | Config in current working directory |
| 3 | `~/.contextengine.json` | Global user config |
| 4 | `CONTEXTENGINE_WORKSPACES` env var | Colon-separated workspace paths |
| 5 | `~/Projects` | Auto-discover fallback |

## Tools

ContextEngine exposes three MCP tools:

### `search_context`

Search across all indexed knowledge sources by natural language query.

```
Query: "Docker deployment PHP"
→ Returns top-k chunks with source, section headings, line numbers, and relevance score
```

### `list_sources`

List all indexed knowledge sources with their status and chunk counts.

### `read_source`

Read the full content of any indexed source by name.

## How It Works

```
Your Markdown Files          ContextEngine              AI Agent
┌────────────────┐     ┌──────────────────┐     ┌──────────────┐
│ copilot-        │     │  1. Parse         │     │ GitHub       │
│  instructions   │────▶│  2. Chunk by §    │◀───▶│  Copilot     │
│ SKILLS.md       │     │  3. Score & rank  │     │ Claude       │
│ runbooks        │     │  4. Return top-k  │     │ Cursor       │
└────────────────┘     └──────────────────┘     └──────────────┘
                            stdio (MCP)
```

1. **Parse** — reads all configured markdown sources at startup
2. **Chunk** — splits on headings, preserving section hierarchy
3. **Index** — builds in-memory search index (keyword scoring with term overlap + multi-term bonuses)
4. **Serve** — exposes MCP tools over stdio transport

## Development

```bash
git clone https://github.com/FASTPROD/ContextEngine.git
cd ContextEngine
npm install
npm run build
npm start
```

### Project Structure

```
src/
├── index.ts     # MCP server entry point — tool registration
├── config.ts    # Configuration loading & source discovery
├── ingest.ts    # Markdown parser & heading-based chunker
└── search.ts    # Keyword search engine with relevance scoring
```

## Roadmap

- [ ] **Vector embeddings** — semantic search via `all-MiniLM-L6-v2` (local, no API)
- [ ] **File watching** — auto-reindex on file changes
- [ ] **MCP resources** — expose docs as browsable resources
- [ ] **Multi-format** — support YAML, JSON, code comments
- [ ] **Team server** — shared HTTP transport for team knowledge bases
- [ ] **VS Code extension** — one-click install from marketplace

## License

MIT — see [LICENSE](LICENSE).

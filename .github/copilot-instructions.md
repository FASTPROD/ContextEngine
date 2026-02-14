# Copilot Instructions — ContextEngine

## Project Context
- **TypeScript MCP Server** — queryable knowledge base for AI coding agents
- **GitHub**: FASTPROD/ContextEngine
- **Version**: v1.9.43
- **Branch**: `main`
- **License**: MIT (open-source, npm-publishable)

## Architecture
- **MCP SDK**: `@modelcontextprotocol/sdk` v1.26 — stdio transport
- **Embeddings**: `all-MiniLM-L6-v2` via `@huggingface/transformers` (22MB, local CPU, no API key)
- **Search**: Hybrid — 40% keyword (term overlap scoring) + 60% semantic (cosine similarity)
- **Indexing**: Markdown heading-based chunker + code chunker (TS/JS/Python) → in-memory vector store
- **Caching**: Embedding cache to disk (`~/.contextengine/embedding-cache.json`) — SHA-256 hash invalidation
- **Non-blocking**: Keyword search available instantly at startup, embeddings load in background (or from cache)
- **File watching**: `fs.watch` on all sources with 500ms debounce → auto re-index
- **Auto-discovery**: 7 patterns (copilot-instructions, SKILLS, CLAUDE.md, .cursorrules, .cursor/rules, AGENTS.md)

## Source Files
| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server entry point — 8 tools, MCP resources, file watcher, startup |
| `src/config.ts` | Configuration loading — contextengine.json, env vars, auto-discovery |
| `src/ingest.ts` | Markdown parser — heading-based chunking with section hierarchy |
| `src/search.ts` | Keyword search engine — tokenizer, term overlap scoring, multi-term bonus |
| `src/embeddings.ts` | Vector embeddings — MiniLM-L6-v2 pipeline, cosine similarity, batch embedding |
| `src/cache.ts` | Embedding cache — SHA-256 hash, disk persistence, instant restart |
| `src/collectors.ts` | 11 operational data collectors — git, package.json, composer, .env, docker, pm2, nginx, cron |
| `src/agents.ts` | Multi-agent — project analyzer, port conflict detector, compliance auditor, AI-readiness scorer |
| `src/code-chunker.ts` | Code parser — regex-based TS/JS/Python function/class/interface extraction |
| `src/test.ts` | Test harness — validates keyword + semantic search on real data |

## MCP Tools Exposed (8 tools)
| Tool | Description |
|------|-------------|
| `search_context` | Hybrid keyword+semantic search with mode selector (hybrid/keyword/semantic) |
| `list_sources` | Show all indexed sources with chunk counts and embedding status |
| `read_source` | Read full content of a knowledge source by name |
| `reindex` | Force full re-index of all sources |
| `list_projects` | Discover and analyze all projects (tech stack, git, docker, pm2) |
| `check_ports` | Scan all projects for port conflicts |
| `run_audit` | Compliance agent — git remotes, hooks, .env, Docker, PM2, versions |
| `score_project` | AI-readiness scoring 0-100% with letter grades (A+ to F) |

## Configuration System
- **Priority**: `CONTEXTENGINE_CONFIG` env → `./contextengine.json` → `~/.contextengine.json` → `CONTEXTENGINE_WORKSPACES` env → auto-discover `~/Projects`
- **contextengine.json**: `sources` (explicit files), `workspaces` (dirs to scan), `patterns` (filenames to match), `codeDirs` (source dirs to parse)
- **Default patterns**: `.github/copilot-instructions.md`, `.github/SKILLS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules`, `AGENTS.md`

## Critical Rules
1. **ES Modules** — `"type": "module"` in package.json, all imports use `.js` extension
2. **Node 18+** required — uses ES2022 features
3. **Embeddings are optional** — if model fails to load, keyword search still works
4. **MiniLM is NOT an LLM** — it's a sentence embedding model (text→vector), not generative
5. **Git auto-push** — post-commit hook pushes to `origin` (GitHub) + `gdrive` (Google Drive backup)
6. **Embedding cache** — `~/.contextengine/embedding-cache.json`, invalidated by SHA-256 hash of all chunk contents

## Stats (as of v1.9.43)
- 555+ chunks from 13+ sources auto-discovered
- 127+ operational chunks from 19 projects
- 76 code chunks from TS/JS/Python source files
- Keyword search: instant
- Semantic search: ~15s model load (first run), ~200ms from cache
- Embedding speed: ~50 chunks/sec on Apple Silicon

## Related
- **Competitive Analysis**: `COMPETITIVE_ANALYSIS.md` (8 competitors analyzed)
- **Multi-Agent Architecture Plan**: `FASTPROD/docs/MULTI_AGENT_ARCHITECTURE_PLAN.md`
- **Session Doc**: `FASTPROD/docs/CROWLR_COMPR_APPS_SESSION.md`
- **SKILLS**: `GDrive/CTRL/EXO/SKILLS.md`

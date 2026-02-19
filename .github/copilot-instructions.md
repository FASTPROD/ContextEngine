# Copilot Instructions — ContextEngine

## Project Context
- **TypeScript MCP Server** — queryable knowledge base for AI coding agents
- **GitHub**: FASTPROD/ContextEngine
- **Version**: v1.14.0
- **Branch**: `main`
- **License**: AGPL-3.0 (open-source, copyleft — modifications must be shared)
- **npm**: `@compr/contextengine-mcp` — `npx @compr/contextengine-mcp`
- **CLI**: 6 standalone subcommands — `search`, `list-sources`, `list-projects`, `score`, `list-learnings`, `audit` (no MCP required)
- **npm account**: `compr` (yannick@compr.ch)
- **npm token**: granular, expires March 18, 2026

## Architecture
- **MCP SDK**: `@modelcontextprotocol/sdk` v1.26 — stdio transport
- **Embeddings**: `all-MiniLM-L6-v2` via `@huggingface/transformers` (22MB, local CPU, no API key)
- **Search**: Hybrid — 40% keyword (BM25 scoring with IDF + doc length normalization) + 60% semantic (cosine similarity) + temporal decay (90-day half-life)
- **Indexing**: Markdown heading-based chunker with 4-line context overlap + code chunker (TS/JS/Python) → in-memory vector store
- **Deduplication**: SHA-256 content hashing prevents duplicate chunks across sources
- **Caching**: Embedding cache to disk (`~/.contextengine/embedding-cache.json`) — SHA-256 hash invalidation (cache v2)
- **Non-blocking**: Keyword search available instantly at startup, embeddings load in background (or from cache)
- **File watching**: `fs.watch` on all sources with 500ms debounce → auto re-index
- **Auto-discovery**: 7 patterns (copilot-instructions, SKILLS, CLAUDE.md, .cursorrules, .cursor/rules, AGENTS.md)
- **Session persistence**: `~/.contextengine/sessions/` — key-value store per named session, persists across restarts
- **Learning store**: `~/.contextengine/learnings.json` — permanent operational rules, auto-surface in search_context results
- **Bundled defaults**: 30 curated universal learnings ship with npm — auto-merged on first load (dedup by rule text)
- **Bulk import**: `import_learnings` tool parses Markdown (H2=category, H3=rule, bullets=context) or JSON arrays
- **CLI**: `npx @compr/contextengine-mcp init` — scaffolds contextengine.json + copilot-instructions.md template
- **Plugin adapters**: `src/adapters.ts` — custom data source connectors, ES module loading, env var resolution, factory pattern
- **OpenClaw skill**: `skills/contextengine/SKILL.md` — AgentSkills-compatible, targets 208K-star OpenClaw community

## Source Files
| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI entry point — 6 standalone subcommands + `init` scaffolding + MCP server routing |
| `src/index.ts` | MCP server entry point — 15 tools, MCP resources, file watcher, startup |
| `src/config.ts` | Configuration loading — contextengine.json, env vars, auto-discovery |
| `src/ingest.ts` | Markdown parser — heading-based chunking with section hierarchy, 4-line overlap, SHA-256 dedup |
| `src/search.ts` | BM25 keyword search engine — IDF weighting, doc length normalization, multi-term boost |
| `src/embeddings.ts` | Vector embeddings — MiniLM-L6-v2 pipeline, cosine similarity, batch embedding |
| `src/cache.ts` | Embedding cache v2 — SHA-256 hash, disk persistence, instant restart |
| `src/collectors.ts` | 11 operational data collectors — git, package.json, composer, .env, docker, pm2, nginx, cron |
| `src/agents.ts` | Multi-agent — project analyzer, port conflict detector, compliance auditor, AI-readiness scorer (anti-gaming v2), HTML report generator |
| `src/sessions.ts` | Session persistence — save/load/list/delete named sessions to disk |
| `src/learnings.ts` | Learning store — permanent operational rules, 18 categories, auto-tag extraction, bulk import, bundled defaults |
| `defaults/learnings.json` | 30 curated universal best practices — shipped with npm, auto-merged on first load |
| `src/adapters.ts` | Plugin adapter system — Adapter interface, registry, ES module loading, env var resolution |
| `src/code-chunker.ts` | Code parser — regex-based TS/JS/Python function/class/interface extraction |
| `src/test.ts` | Test harness — validates keyword + semantic search on real data |
| `skills/contextengine/SKILL.md` | OpenClaw skill package — AgentSkills frontmatter, 15 tools, MCP setup docs |
| `examples/adapters/` | Example adapters — Notion skeleton + RSS feed adapter |

## MCP Tools Exposed (15 tools)
| Tool | Description |
|------|-------------|
| `search_context` | Hybrid BM25+semantic search with temporal decay and mode selector (hybrid/keyword/semantic) |
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
| `end_session` | Pre-flight checklist — checks uncommitted git changes + doc freshness across all repos |
| `save_learning` | Save a permanent operational rule — auto-surfaces in search_context results |
| `list_learnings` | List all permanent learnings, optionally filtered by category |
| `import_learnings` | Bulk-import learnings from Markdown or JSON files |

## Configuration System
- **Priority**: `CONTEXTENGINE_CONFIG` env → `./contextengine.json` → `~/.contextengine.json` → `CONTEXTENGINE_WORKSPACES` env → auto-discover `~/Projects`
- **contextengine.json**: `sources` (explicit files), `workspaces` (dirs to scan), `patterns` (filenames to match), `codeDirs` (source dirs to parse), `adapters` (plugin data sources)
- **Default patterns**: `.github/copilot-instructions.md`, `.github/SKILLS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules`, `AGENTS.md`

## Critical Rules
1. **ES Modules** — `"type": "module"` in package.json, all imports use `.js` extension
2. **Node 18+** required — uses ES2022 features
3. **Embeddings are optional** — if model fails to load, keyword search still works
4. **MiniLM is NOT an LLM** — it's a sentence embedding model (text→vector), not generative
5. **Git auto-push** — post-commit hook pushes to `origin` (GitHub) + `gdrive` (Google Drive backup)
6. **Embedding cache** — `~/.contextengine/embedding-cache.json`, cache v2 format, invalidated by SHA-256 hash of all chunk contents
7. **End-of-session protocol** — before ending ANY session, ALWAYS:
   - Update `ContextEngine/.github/copilot-instructions.md` (version, new features, stats)
   - Update `~/Projects/EXO/SKILLS.md` (new capabilities learned)
   - Append session summary to `~/FASTPROD/docs/CROWLR_COMPR_APPS_SESSION.md`
   - Git commit + push ALL changed repos (ContextEngine, EXO, FASTPROD)
8. **⛔ MANDATORY: `save_learning` in real-time** — when you discover a reusable pattern, bug fix, architecture decision, security rule, or operational insight during ANY session:
   - **ALWAYS call `save_learning`** immediately via the ContextEngine MCP tool — do NOT write learnings into markdown files (SCORE.md, SESSION docs, etc.) as a substitute
   - The learning store (`~/.contextengine/learnings.json`) is the **single source of truth** — markdown docs are for humans, the tool is for agents
   - Categories: `architecture`, `security`, `bug-patterns`, `deployment`, `testing`, `api`, `frontend`, `backend`, `infrastructure`, `tooling`, `devops`, `git`, `data`, `dependencies`, `performance`, `accessibility`
   - If ContextEngine MCP is not connected in the current workspace, **say so** and ask the user to connect it — do NOT silently skip
   - This rule exists because learnings written to markdown files are stranded — they don't auto-surface in `search_context` results

## Stats (as of v1.12.0)
- 555+ chunks from 13+ sources auto-discovered (with 4-line overlap at section boundaries)
- 127+ operational chunks from 19 projects
- 76 code chunks from TS/JS/Python source files
- 151+ learnings across 16 categories (151 user + 30 bundled defaults, deduped on merge)
- 30 bundled starter learnings ship with npm (security, deployment, architecture, frontend, testing, tooling, git, accessibility, bug-patterns)
- Keyword search: instant (BM25 with IDF — rare terms rank higher)
- Temporal decay: 90-day half-life (recent content boosted, old content demoted)
- Semantic search: ~15s model load (first run), ~200ms from cache
- Embedding speed: ~50 chunks/sec on Apple Silicon

## Related
- **Competitive Analysis**: `COMPETITIVE_ANALYSIS.md` (8 competitors + OpenClaw strategic complement analyzed)
- **Multi-Agent Architecture Plan**: `FASTPROD/docs/MULTI_AGENT_ARCHITECTURE_PLAN.md`
- **Session Doc**: `FASTPROD/docs/CROWLR_COMPR_APPS_SESSION.md`
- **SKILLS**: `~/Projects/EXO/SKILLS.md`

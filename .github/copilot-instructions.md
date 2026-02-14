# Copilot Instructions — ContextEngine

## Project Context
- **TypeScript MCP Server** — queryable knowledge base for AI coding agents
- **GitHub**: FASTPROD/ContextEngine
- **Version**: v1.9.40
- **Branch**: `main`
- **License**: MIT (open-source, npm-publishable)

## Architecture
- **MCP SDK**: `@modelcontextprotocol/sdk` v1.26 — stdio transport
- **Embeddings**: `all-MiniLM-L6-v2` via `@huggingface/transformers` (22MB, local CPU, no API key)
- **Search**: Hybrid — 40% keyword (term overlap scoring) + 60% semantic (cosine similarity)
- **Indexing**: Markdown heading-based chunker → in-memory vector store
- **Non-blocking**: Keyword search available instantly at startup, embeddings load in background
- **File watching**: `fs.watch` on all sources with 500ms debounce → auto re-index

## Source Files
| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server entry point — 4 tools, MCP resources, file watcher, startup |
| `src/config.ts` | Configuration loading — contextengine.json, env vars, auto-discovery |
| `src/ingest.ts` | Markdown parser — heading-based chunking with section hierarchy |
| `src/search.ts` | Keyword search engine — tokenizer, term overlap scoring, multi-term bonus |
| `src/embeddings.ts` | Vector embeddings — MiniLM-L6-v2 pipeline, cosine similarity, batch embedding |
| `src/test.ts` | Test harness — validates keyword + semantic search on real data |

## MCP Tools Exposed
| Tool | Description |
|------|-------------|
| `search_context` | Hybrid keyword+semantic search with mode selector (hybrid/keyword/semantic) |
| `list_sources` | Show all indexed sources with chunk counts and embedding status |
| `read_source` | Read full content of a knowledge source by name |
| `reindex` | Force full re-index of all sources |

## Configuration System
- **Priority**: `CONTEXTENGINE_CONFIG` env → `./contextengine.json` → `~/.contextengine.json` → `CONTEXTENGINE_WORKSPACES` env → auto-discover `~/Projects`
- **contextengine.json**: `sources` (explicit files), `workspaces` (dirs to scan), `patterns` (filenames to match)
- **Default pattern**: `.github/copilot-instructions.md`

## Critical Rules
1. **ES Modules** — `"type": "module"` in package.json, all imports use `.js` extension
2. **Node 18+** required — uses ES2022 features
3. **Embeddings are optional** — if model fails to load, keyword search still works
4. **MiniLM is NOT an LLM** — it's a sentence embedding model (text→vector), not generative
5. **Future**: Mistral LLM on OVH server can be added for RAG synthesis (retrieve chunks → generate answer)
6. **Git auto-push** — post-commit hook pushes to `origin` (GitHub) + `gdrive` (Google Drive backup)

## Stats (as of v1.9.40)
- 407 chunks from 13 sources auto-discovered
- Keyword search: instant
- Semantic search: ~15s model load (first run), then instant
- Embedding speed: ~50 chunks/sec on Apple Silicon

## Related
- **Multi-Agent Architecture Plan**: `FASTPROD/docs/MULTI_AGENT_ARCHITECTURE_PLAN.md`
- **Session Doc**: `FASTPROD/docs/CROWLR_COMPR_APPS_SESSION.md`
- **SKILLS**: `GDrive/CTRL/EXO/SKILLS.md`

# ContextEngine — Competitive Analysis

> Last updated: 2026-02-15 · v1.9.40

## Executive Summary

The MCP Knowledge & Memory space has **~20+ active projects** but is fragmented into 4 distinct categories. ContextEngine's unique position: **zero API keys, local-only, operational data sources** (git, docker, pm2, nginx, cron) that no competitor touches. Most competitors either require OpenAI/cloud accounts or focus narrowly on code indexing.

---

## Competitive Landscape — Top 8 Competitors

### 1. Context7 (`@upstash/context7-mcp`)
| Metric | Value |
|--------|-------|
| Downloads | **1.2M+/week** (market leader) |
| Stars | N/A (cloud service) |
| License | MIT |
| API Keys | Optional (higher rate limits) |
| Approach | **Cloud-hosted library documentation** |

**What it does**: Fetches up-to-date documentation for popular libraries (Next.js, Supabase, etc.) directly into AI prompts. 2 tools only: `resolve-library-id` + `get-library-docs`.

**Why it's big**: Solves a real pain (LLMs hallucinate outdated APIs). Massive adoption because it's zero-config.

**NOT a competitor**: Context7 indexes **public library docs**, not your private codebase. Completely different use case. We could even recommend it alongside ContextEngine.

---

### 2. Memory Bank MCP (`@grec0/memory-bank-mcp`)
| Metric | Value |
|--------|-------|
| Downloads | 45/week |
| Stars | Low |
| License | MIT |
| API Keys | **OpenAI REQUIRED** |
| Approach | Code indexing + AI doc generation + multi-agent coordination |

**What it does**: AST-based code chunking → OpenAI embeddings → LanceDB vector store. Generates 6 structured docs per project using GPT-5-mini reasoning. Multi-agent coordination with file locking. Task orchestration for cross-project delegation.

**Strengths**:
- Massive feature set (20+ tools)
- Multi-agent coordination (file locks, agent board)
- Task routing / cross-project delegation
- Session context management (Cline-style)
- Map-reduce for large projects

**Weaknesses**:
- **Requires OpenAI API key** (deal-breaker for privacy/cost-sensitive users)
- Complex setup (many env vars)
- Only 45 downloads/week despite feature richness → indicates discovery problem
- Heavy: 456KB unpacked, 13 dependencies

**ContextEngine advantage**: Zero API keys, local-only embeddings, instant setup, lighter footprint.

---

### 3. ContextStream (`@contextstream/mcp-server`)
| Metric | Value |
|--------|-------|
| Downloads | 1,239/week |
| Stars | N/A |
| License | MIT |
| API Keys | **Auth required** (proprietary backend) |
| Approach | SaaS — semantic code search + team integrations |

**What it does**: "Intelligence, not just memory." Semantic code search, SmartRouter context delivery, team knowledge fusion (GitHub, Slack, Notion), code graph analysis, context pressure awareness.

**Strengths**:
- Polished marketing / product positioning
- Team collaboration (GitHub/Slack/Notion integration)
- Code graph analysis (dependency mapping)
- Context pressure tracking (token usage)
- Setup wizard

**Weaknesses**:
- **Proprietary backend** — not truly open-source despite MIT npm package
- Requires authentication (account creation)
- 1.78MB unpacked — heavy
- Vendor lock-in risk
- "60+ tools" claim but actual tool count is ~9 categories

**ContextEngine advantage**: Fully open-source, no vendor lock-in, no account needed, works offline.

---

### 4. claude-brain
| Metric | Value |
|--------|-------|
| Downloads | 5,005/week |
| Stars | N/A |
| License | MIT |
| API Keys | **None** (fully local) |
| Approach | Obsidian vault → ChromaDB semantic memory |

**What it does**: Bridges Obsidian knowledge vaults with Claude Code. 25 MCP tools. Knowledge graph, episodic memory, hybrid retrieval (BM25 + semantic + reranking), temporal intelligence, cross-project patterns, predictive intelligence.

**Strengths**:
- **Zero cloud dependencies** — runs completely local
- Massive tool count (25 tools)
- Sophisticated retrieval (BM25 + semantic fusion + cross-encoder reranking)
- Knowledge graph with entity extraction
- Episodic memory with session detection
- Compiles to single binary
- 750+ tests

**Weaknesses**:
- **Requires Bun** (not Node.js — smaller ecosystem)
- **Obsidian-centric** — assumes vault-based workflow
- 1.52MB, 247 files — very heavy
- ChromaDB dependency (another server process)
- 20 npm dependencies
- Claude Code specific (not IDE-agnostic marketing)

**ContextEngine advantage**: Works with any markdown (not just Obsidian), Node.js native, no ChromaDB server needed, lighter, IDE-agnostic.

---

### 5. DevRag
| Metric | Value |
|--------|-------|
| Downloads | N/A (Go binary) |
| Stars | 29 |
| License | MIT |
| API Keys | **None** (fully local) |
| Approach | Go binary + ONNX embeddings for markdown search |

**What it does**: Lightweight local RAG for markdown files. Claims 40x token reduction. Single binary, auto-downloads multilingual-e5-small model. GPU/CPU auto-detection. 5 MCP tools.

**Strengths**:
- **Single binary** — no Node.js/Python needed
- Local embeddings (multilingual-e5-small, 384 dims — same tier as our MiniLM)
- Fast: 95ms search on 100 files
- Cross-platform (macOS/Linux/Windows)
- Clean, minimal design (Go)
- Multilingual (100+ languages)

**Weaknesses**:
- **Markdown only** — no code, no operational data
- Only 5 tools (search, index, list, delete, reindex)
- No hybrid search (vector only)
- No file watching (must manually reindex)
- Small community (29 stars, 3 contributors)
- Go binary = can't extend in JavaScript ecosystem

**ContextEngine advantage**: Hybrid search (keyword + semantic), file watching with auto-reindex, richer tool set, JS ecosystem extensibility, operational data sources planned.

---

### 6. FAF MCP (`faf-mcp`)
| Metric | Value |
|--------|-------|
| Downloads | ~10K (via faf-cli) |
| Stars | 2 |
| License | MIT |
| API Keys | None |
| Approach | IANA-registered `.faf` format for project context |

**What it does**: Defines a YAML-based "Foundational AI-context Format" for projects. AI-readiness scoring (0-100%). Bi-sync between `.faf` ↔ `CLAUDE.md`. 22 MCP tools. Cloud sync via mcpaas.live.

**Strengths**:
- IANA-registered format (`application/vnd.faf+yaml`) — unique differentiator
- AI-readiness scoring concept (gamification)
- Bi-directional sync (`.faf` ↔ `CLAUDE.md`)
- Cloud sharing via mcpaas.live
- Multi-platform (Cursor, Windsurf, Cline, VS Code)
- WASM SDK for scoring (<5ms)

**Weaknesses**:
- **No search** — it's a context format, not a retrieval system
- No embeddings, no vector search, no semantic understanding
- AI-readiness scoring is subjective/gamified (not proven value)
- Only 2 GitHub stars despite heavy marketing effort
- Relies on manual context authoring
- "Eternal bi-sync" is just file watching

**ContextEngine advantage**: Actual semantic search, automated indexing (no manual authoring), hybrid retrieval, embeddings-based understanding.

---

### 7. src-to-kb (`@vezlo/src-to-kb`)
| Metric | Value |
|--------|-------|
| Downloads | Low |
| Stars | 28 |
| License | **AGPL-3.0** (commercial license required) |
| API Keys | **OpenAI required** for AI search |
| Approach | Source code → knowledge base generator |

**What it does**: Converts any repo into a structured knowledge base (JSON chunks + optional OpenAI embeddings). 3 answer modes (enduser/developer/copilot). REST API with Swagger. Notion integration. External server support.

**Strengths**:
- Multi-language code support (15+ languages)
- Answer modes concept (audience-specific responses)
- Notion integration
- REST API with Swagger docs
- Enterprise deployment options

**Weaknesses**:
- **AGPL license** — poison pill for commercial use
- **Requires OpenAI for intelligent search** (basic keyword without it)
- Separate processes (CLI + API server + MCP server)
- Complex setup (multiple npm commands)
- Uses GPT-5 (expensive per query)
- JavaScript-only codebase (no TypeScript)

**ContextEngine advantage**: MIT license, zero API keys, TypeScript, simpler architecture, no commercial license needed.

---

### 8. ContextMCP (`contextmcp`)
| Metric | Value |
|--------|-------|
| Downloads | Low |
| Stars | 14 |
| License | Apache-2.0 |
| API Keys | **Pinecone + OpenAI REQUIRED** |
| Approach | Self-hosted docs → Pinecone vector DB |

**What it does**: Index documentation (MDX, Markdown, OpenAPI) → OpenAI embeddings → Pinecone vector DB → Cloudflare Worker MCP server.

**Strengths**:
- Supports MDX, Markdown, OpenAPI specs
- Cloudflare Worker deployment (serverless)
- CLI scaffolding tool (`npx contextmcp init`)

**Weaknesses**:
- **Double vendor lock-in** (Pinecone + OpenAI)
- Cloud-only architecture (no local option)
- Small project (14 stars, 3 contributors)
- Requires Cloudflare account for deployment

**ContextEngine advantage**: Zero vendor dependencies, runs locally, no cloud accounts needed.

---

## Feature Comparison Matrix

| Feature | ContextEngine | Context7 | Memory Bank | ContextStream | claude-brain | DevRag | FAF | src-to-kb | ContextMCP |
|---------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Zero API Keys** | ✅ | ⚠️ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Local Embeddings** | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Hybrid Search** | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **File Watching** | ✅ | N/A | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| **Markdown Chunking** | ✅ | N/A | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ |
| **Code Chunking (AST)** | ❌ | N/A | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| **Multi-Project** | ✅ | N/A | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| **Multi-Agent** | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **MCP Resources** | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **MIT License** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅* |
| **Node.js Native** | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Instant Keyword** | ✅ | N/A | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Non-blocking Start** | ✅ | N/A | ❌ | ❌ | ❌ | ❌ | N/A | ❌ | ❌ |
| **Team Integrations** | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Operational Data** | 🔜 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

\* ContextMCP is Apache-2.0

---

## Gap Analysis: What We Don't Have (Yet)

### High Priority — Build These
| Gap | Who Has It | Difficulty | Impact |
|-----|-----------|------------|--------|
| **Operational data sources** (git, docker, pm2, nginx, cron, .env) | **Nobody** | Medium | 🔥 **UNIQUE MOAT** |
| **Code chunking (AST)** | Memory Bank, ContextStream, src-to-kb | Hard | High |
| **Multi-agent coordination** | Memory Bank | Medium | Medium |
| **Session context persistence** | Memory Bank, claude-brain | Easy | Medium |
| **Knowledge graph** | claude-brain, ContextStream | Hard | Medium |

### Medium Priority — Nice to Have
| Gap | Who Has It | Difficulty | Impact |
|-----|-----------|------------|--------|
| Team integrations (Slack, GitHub, Notion) | ContextStream | Hard | Medium |
| AI-readiness scoring | FAF | Easy | Low |
| Answer modes (enduser/dev/copilot) | src-to-kb | Easy | Low |
| Cross-project delegation | Memory Bank | Medium | Low |

### Low Priority — Ignore for Now
| Gap | Who Has It | Why Skip |
|-----|-----------|----------|
| Cloud sync | FAF, ContextStream | Privacy-first positioning = advantage |
| REST API | src-to-kb | MCP is the protocol, REST is legacy |
| Notion/Slack integrations | ContextStream, src-to-kb | Different target audience |

---

## ContextEngine's Unique Positioning

### What NOBODY else does:
1. **Operational data sources** — git log, docker ps, pm2 list, nginx configs, crontab, .env (sanitized), zsh_history. This is the **#1 differentiator**. Every other tool indexes code or docs. We index the **entire developer environment**.

2. **Non-blocking startup** — keyword search available instantly while embeddings load in background. No other competitor does this.

3. **Zero-dependency local embeddings** — MiniLM-L6-v2 runs locally with zero API keys, zero accounts, zero cost. Only DevRag and claude-brain match this, but both have other dependencies (Go binary / Bun + ChromaDB).

4. **Auto-discovery** — scans `~/Projects` for copilot-instructions.md files automatically. No manual configuration needed. No other competitor auto-discovers project context.

5. **Hybrid search with instant fallback** — 40% keyword + 60% semantic, with keyword always available even when embeddings haven't loaded yet.

### Elevator Pitch
> **ContextEngine is the only MCP server that gives AI agents instant access to your entire developer environment — not just code and docs, but git history, running services, server configs, and environment variables — with zero API keys, zero cloud accounts, and zero cost.**

### One-liner for npm
> Queryable knowledge base for AI coding agents. Hybrid search (keyword + semantic), local embeddings, zero API keys. Indexes docs, git, docker, pm2, nginx, cron automatically.

---

## Strategic Recommendations

### Phase 1: Differentiate (NOW)
- [x] Hybrid search (keyword + semantic) ✅
- [x] Local embeddings (MiniLM) ✅
- [x] Auto-discovery ✅
- [x] File watching ✅
- [ ] **Operational data sources** ← THIS IS THE MOAT
- [ ] Session context persistence

### Phase 2: Compete (v2.0)
- [ ] Code chunking (AST-based for TS/JS/Python)
- [ ] Multi-agent coordination (Phase 1)
- [ ] Knowledge graph (entities from chunks)
- [ ] VS Code extension (for discoverability)

### Phase 3: Dominate (v3.0)
- [ ] npm publish (compiled dist only)
- [ ] Team features (shared knowledge bases)
- [ ] Enterprise features (audit trail, access control)
- [ ] Plugin system (custom data source adapters)

---

## Market Size Estimate

| Segment | TAM | Notes |
|---------|-----|-------|
| VS Code MCP users | ~500K | Based on Copilot extension installs |
| Claude Code users | ~100K | Growing rapidly |
| Cursor/Windsurf users | ~200K | MCP-native |
| **Total addressable** | **~800K developers** | Who use AI coding assistants with MCP |

Context7 proves demand: 1.2M downloads/week. Even capturing 0.1% = 800 active users.

---

*Analysis by ContextEngine team · FASTPROD*

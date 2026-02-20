# ContextEngine — Skills & Capabilities

## Core Technologies
- **TypeScript** (ES2022, strict mode) — entire codebase, ~7,500 lines
- **MCP Protocol** (Model Context Protocol) — stdio transport, JSON-RPC 2.0, 17 tools
- **Node.js 18+** — ESM modules, native crypto, child_process for git

## Search & NLP
- **BM25** — keyword search with IDF weighting, temporal decay (90-day half-life)
- **Semantic Embeddings** — Xenova `all-MiniLM-L6-v2`, 384-dim vectors, cosine similarity
- **Chunking** — Markdown-aware section splitting with 4-line overlap at boundaries

## Security & Cryptography
- **AES-256-CBC** — delta module encryption (key = SHA-256 of licenseKey + machineId)
- **Machine Fingerprinting** — SHA-256 hash of platform, arch, homedir, username
- **Express Security** — Helmet headers, CORS whitelist, rate limiting (express-rate-limit)
- **Input Validation** — license format regex, charset/length checks on all user input
- **Parameterized SQL** — all SQLite queries use `?` placeholders

## Server & Infrastructure
- **Express 4** — activation/licensing server, 3 endpoints
- **SQLite3** (better-sqlite3) — license database, synchronous API
- **PM2** — process manager on Gandi VPS (Debian 10)
- **Nginx** — reverse proxy with path-based routing
- **GitHub Actions CI** — Node 18/20/22 matrix, build + smoke test

## npm Publishing
- **Scoped package** — `@compr/contextengine-mcp` on npmjs.com
- **BSL-1.1 license** — Business Source License (non-compete clause)
- **Selective files** — only `dist/`, `defaults/`, `skills/`, `examples/` published
- **Bundled defaults** — 30 starter learnings ship with npm

## Development Patterns
- **Zero-config** — auto-discovers project docs, git context, deps without setup
- **Plugin adapters** — auto-configure Claude Desktop, VS Code, Cursor
- **Append-only store** — learnings in `~/.contextengine/learnings.json`, never overwritten
- **Activation gate** — premium tools check license before execution
- **Offline grace** — 7-day window without heartbeat before lockout

## Key Learnings Applied
- SSH keys with passphrases block CI/agent automation — use deploy scripts
- `cors({ origin: true })` reflects ANY origin — always use explicit whitelist
- `express-rate-limit` pattern: separate limiter instances per route group
- `better-sqlite3` is synchronous — no async/await needed, simpler error handling
- Heredoc in zsh terminals can corrupt with special characters — use file-based approach

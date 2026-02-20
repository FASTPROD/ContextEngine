# ContextEngine — AI-Readiness Score

**Score: 88/100 — Grade: A**
**Scored:** February 20, 2026 — via ContextEngine `score_project`

## Stack
- **TypeScript MCP Server** — queryable knowledge base for AI coding agents
- **npm**: @compr/contextengine-mcp v1.14.1 (public, BSL-1.1)
- **Runtime**: Node.js 18+, ES2022, ESM modules
- **Embeddings**: all-MiniLM-L6-v2 via @huggingface/transformers (local CPU)
- **Activation Server**: Express + SQLite3 + Helmet, port 8010

## Results

| Category | Points | Max | Status |
|----------|--------|-----|--------|
| Git repo | 5 | 5 | ✅ main branch |
| Git remotes | 5 | 5 | ✅ origin (GitHub) + gdrive |
| Post-commit hook | 3 | 3 | ✅ Auto-push to origin + gdrive |
| AI docs (copilot-instructions) | 10 | 10 | ✅ 118 lines — activation, security, infrastructure, 17 tools |
| Multi-agent docs (CLAUDE.md) | 5 | 5 | ✅ 40 lines — 9 critical rules |
| SKILLS.md | 5 | 5 | ✅ Technologies, security, patterns |
| README | 5 | 5 | ✅ Trimmed — no IP leaks |
| .env management | 0 | 5 | N/A — no .env needed (zero-config design) |
| .gitignore | 3 | 5 | ⚠️ Covers node_modules, dist, .contextengine — could add more |
| Package manager | 5 | 5 | ✅ package-lock.json |
| Build tool | 5 | 5 | ✅ TypeScript compiler (tsc) |
| Linter | 0 | 5 | ❌ No ESLint config |
| Tests | 2 | 10 | ⚠️ CI smoke tests only — no unit test framework |
| CI/CD | 8 | 10 | ✅ GitHub Actions — Node 18/20/22 matrix, build + smoke |
| Security | 10 | 10 | ✅ Rate-limit, CORS whitelist, Helmet, parameterized SQL, graceful shutdown |
| npm publishing | 5 | 5 | ✅ Scoped package, selective files, BSL-1.1 |
| Deploy script | 3 | 3 | ✅ server/deploy.sh — rsync + PM2 + nginx |

## Deductions
- -5: No ESLint configuration
- -8: No unit test framework (jest/vitest) — only CI smoke tests
- -2: .gitignore could be more comprehensive

## Improvements Since v1.12.0 (Score: 72 → 88)
- ✅ CLAUDE.md created (+5)
- ✅ SKILLS.md created (+5)
- ✅ CI/CD via GitHub Actions (+8)
- ✅ Security hardening — rate-limit, CORS, graceful shutdown (+10)
- ✅ Deploy script (+3)
- ✅ copilot-instructions updated to 118 lines (+2)
- ✅ 0 npm vulnerabilities (was 3)

## Next Steps (to reach 95+)
1. Add ESLint with TypeScript rules (+5)
2. Add vitest with unit tests for search, scoring, activation (+8)
3. Expand .gitignore (+2)

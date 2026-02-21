# ContextEngine — AI-Readiness Score

**Score: 96/100 — Grade: A+**
**Scored:** February 21, 2026 — via ContextEngine `score_project`

## Stack
- **TypeScript MCP Server** — queryable knowledge base for AI coding agents
- **npm**: @compr/contextengine-mcp v1.14.1 (public, BSL-1.1)
- **Runtime**: Node.js 18+, ES2022, ESM modules
- **Embeddings**: all-MiniLM-L6-v2 via @huggingface/transformers (local CPU)
- **Activation Server**: Express + SQLite3 + Helmet, port 8010
- **Production**: https://api.compr.ch/contextengine/ (SSL, Gandi VPS)

## Results

| Category | Points | Max | Status |
|----------|--------|-----|--------|
| Git repo | 5 | 5 | ✅ main branch |
| Git remotes | 5 | 5 | ✅ origin (GitHub) + gdrive |
| Post-commit hook | 3 | 3 | ✅ Auto-push to origin + gdrive |
| AI docs (copilot-instructions) | 10 | 10 | ✅ 135 lines — activation, security, infrastructure, deployment, 17 tools |
| Multi-agent docs (CLAUDE.md) | 5 | 5 | ✅ 40 lines — 9 critical rules |
| SKILLS.md | 5 | 5 | ✅ Technologies, security, patterns |
| README | 5 | 5 | ✅ Trimmed — no IP leaks |
| .env management | 0 | 5 | N/A — no .env needed (zero-config design) |
| .gitignore | 3 | 5 | ⚠️ Covers node_modules, dist, .contextengine — could add more |
| Package manager | 5 | 5 | ✅ package-lock.json |
| Build tool | 5 | 5 | ✅ TypeScript compiler (tsc) |
| Linter | 5 | 5 | ✅ ESLint typescript-eslint flat config (0 errors, 36 warnings) |
| Tests | 10 | 10 | ✅ 25 vitest tests (search 11, activation 8, learnings 6) |
| CI/CD | 10 | 10 | ✅ GitHub Actions — Node 18/20/22, lint + build + test + smoke |
| Security | 10 | 10 | ✅ Rate-limit, CORS whitelist, Helmet, parameterized SQL, graceful shutdown |
| npm publishing | 5 | 5 | ✅ Scoped package, selective files, BSL-1.1 |
| Deploy script | 3 | 3 | ✅ server/deploy.sh — rsync + nginx + VPS live |

## Deductions
- -2: .gitignore could be more comprehensive (OS/editor patterns)
- -2: PM2 not globally installed on VPS (server runs as raw node process, no auto-restart on reboot)

## Improvements Since v1.12.0 (Score: 72 -> 88 -> 96)
- ✅ CLAUDE.md created (+5)
- ✅ SKILLS.md created (+5)
- ✅ CI/CD via GitHub Actions (+8 -> +10 with lint+test)
- ✅ Security hardening — rate-limit, CORS, graceful shutdown (+10)
- ✅ Deploy script (+3)
- ✅ copilot-instructions updated to 135 lines (+2)
- ✅ 0 npm vulnerabilities (was 3)
- ✅ ESLint typescript-eslint flat config (+5) — commit 36ad8f0
- ✅ 25 vitest unit tests (+8) — commit 36ad8f0
- ✅ VPS deployment live with SSL — commit ff26ba6

## Next Steps (to reach 100)
1. Install PM2 globally on VPS + startup script for auto-restart (+2)
2. Expand .gitignore with OS/editor patterns (+2)

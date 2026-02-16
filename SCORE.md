# ContextEngine — AI-Readiness Score

**Score: 72/100 — Grade: B**
**Scored:** February 16, 2026 — via ContextEngine `score_project`

## Stack
- **TypeScript MCP Server** — queryable knowledge base for AI coding agents
- **npm**: @compr/contextengine-mcp v1.9.48 (public, AGPL-3.0)
- **Runtime**: Node.js 18+, ES2022, ESM modules
- **Embeddings**: all-MiniLM-L6-v2 via @huggingface/transformers (local CPU)

## Results

| Category | Points | Max | Status |
|----------|--------|-----|--------|
| Git repo | 5 | 5 | ✅ main branch |
| Git remotes | 5 | 5 | ✅ origin (GitHub) + gdrive |
| Post-commit hook | 3 | 3 | ✅ Auto-push to origin + gdrive |
| AI docs (copilot-instructions) | 8 | 10 | ✅ 87 lines — good, comprehensive |
| Multi-agent docs | 0 | 5 | ❌ No CLAUDE.md, .cursorrules, AGENTS.md |
| README | 5 | 5 | ✅ 209 lines — excellent, full documentation |
| .env management | 0 | 5 | N/A — no .env needed (zero-config design) |
| .gitignore | 1 | 5 | ❌ Only 5 lines — very thin |
| Package manager | 5 | 5 | ✅ package-lock.json |
| Build tool | 5 | 5 | ✅ TypeScript compiler (tsc) |
| Linter | 0 | 5 | ❌ No ESLint config |
| Tests | 1 | 10 | ❌ 1 test file (test.ts — manual harness, not a framework) |
| CI/CD | 0 | 10 | ❌ No GitHub Actions |
| Docker | 0 | 5 | N/A — npm package, not server-deployed |
| PM2 | 0 | 5 | N/A — MCP stdio server, not long-running |
| Source code | 5 | 5 | ✅ 12 TypeScript source files |
| Uncommitted changes | 0 | 0 | ✅ Clean working tree |
| TypeScript | 5 | 5 | ✅ Full TypeScript with tsconfig.json |
| License | 3 | 0 | ✅ AGPL-3.0 (bonus) |
| npm published | 5 | 0 | ✅ Public package, 5 versions, proper metadata (bonus) |
| Competitive analysis | 3 | 0 | ✅ COMPETITIVE_ANALYSIS.md 360 lines (bonus) |

## Backlog — Action Items to Reach A+

### Priority 1 — Quick wins
- [ ] **Expand .gitignore** — only 5 lines, should cover dist/, .npmrc, .env, etc. (+4 pts)
- [ ] **Add CLAUDE.md** — ContextEngine should eat its own dog food with multi-agent docs (+5 pts)

### Priority 2 — Tooling
- [ ] **Add ESLint** — TypeScript ESLint config (+5 pts)
- [ ] **Add CI/CD** — GitHub Actions: lint + build + npm publish on tag (+10 pts)
- [ ] **Add proper test framework** — Vitest, test the search/embeddings/chunking pipeline (+9 pts)

### Priority 3 — Product
- [ ] **Add `save_learning` / `search_learnings` tools** — structured persistent knowledge store for operational rules AI agents keep rediscovering. Categories: deployment, API, GPS, security, etc. Unlike sessions (ephemeral context), learnings are permanent rules. Examples:
  - "Always restart backend after model/route changes — stale server code returns old API responses"
  - "Never estimate GPS manually — always verify against Nominatim API"
  - "npm README comes from tarball at publish time — update README before `npm publish`"
  - "Never suggest global npm updates without cross-project impact analysis"
- [ ] **Add `dependency_impact_analysis` tool** — cross-reference npm/composer outdated against all discovered projects before recommending updates. Flag breaking changes (pinned versions, patches like Expo port fix)
- [ ] **Automated npm publish** — CI/CD triggered by git tag
- [ ] **MCP tools can't be called from terminal** — document this in README (JSON-RPC over stdio only)

### Potential score after all: 95/100 — Grade: A+

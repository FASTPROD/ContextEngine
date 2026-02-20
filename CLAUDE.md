# CLAUDE.md — ContextEngine

## What This Is
MCP (Model Context Protocol) server that indexes project documentation and source code into a searchable knowledge base for AI coding agents. Published as `@compr/contextengine-mcp` on npm.

## Critical Rules

1. **Never expose scoring internals in public docs** — exact point values, category weights, anti-gaming detection methods, and search weight ratios are trade secrets. README should sell outcomes, not blueprint.

2. **Activation gate is mandatory for premium tools** — `score_project`, `run_audit`, `check_ports`, `list_projects` require a valid Pro license. The gate check in `index.ts` and `cli.ts` must never be removed.

3. **Delta modules are the moat** — `agents.ts`, `collectors.ts`, `search.ts` contain the highest-value IP. These are stripped from the npm package and delivered encrypted via the activation server. The `server/` directory must never be included in npm publishes (`files` field in package.json).

4. **All `exec()` calls must use hardcoded strings** — `agents.ts` and `collectors.ts` use `execSync` for git/docker/pm2 data collection. Never interpolate user input into shell commands.

5. **MCP stdout is sacred** — the MCP protocol communicates over stdio. `console.log` in MCP server mode pollutes the protocol stream. Use `console.error` for diagnostics. CLI mode can use `console.log` freely.

6. **Embedding model is local-only** — `all-MiniLM-L6-v2` runs on CPU via `@huggingface/transformers`. No API keys, no data leaves the machine. This is a privacy feature, not a limitation.

7. **Learning store is the single source of truth** — `~/.contextengine/learnings.json` is the canonical knowledge base. Never write learnings to markdown files as a substitute for `save_learning`.

8. **AGPL-3.0 is intentional** — forces competitors who fork to open-source their modifications. Commercial licensing available separately.

9. **Test before publish** — `npm run build` must succeed. Run `npx . search "test"` and `npx . score ContextEngine` to smoke-test before `npm publish`.

## Architecture
- `src/` — 14 TypeScript source files (~7K lines)
- `server/` — Activation server (Express + SQLite + AES-256-CBC)
- `dist/` — Compiled output (npm publishes this)
- `skills/` — OpenClaw skill package
- `examples/` — Adapter examples (Notion, RSS)

## Key Commands
```bash
npm run build          # Compile TypeScript
npm start              # Start MCP server (stdio mode)
npx . search "query"   # CLI search
npx . score            # Score all projects
npx . audit            # Run compliance audit
```

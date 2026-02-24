# SKILLS.md — ContextEngine

> Development guide for AI agents working on the ContextEngine codebase.

## When to use

- Modifying MCP server tools (17 tools in `src/index.ts`)
- Updating CLI subcommands (15 commands in `src/cli.ts`)
- Changing search/ranking logic (`src/search.ts`, `src/embeddings.ts`)
- Working on the learnings store (`src/learnings.ts`)
- Modifying the activation server (`server/src/server.ts`, `server/src/stripe.ts`)
- Updating the VS Code extension (`vscode-extension/src/`)
- Deploying to VPS or publishing to npm/marketplace

## Key rules

### Architecture
- MCP protocol over `stdio` — no HTTP server in the main package
- Dual search: BM25 keyword (instant) + semantic embeddings (Xenova `all-MiniLM-L6-v2`)
- Sources auto-discovered from 7 file patterns — `contextengine.json` is optional
- Learnings: append-only JSON in `~/.contextengine/learnings.json`
- Delta modules: premium code extracted by `gen-delta.ts`, encrypted per-machine (AES-256-CBC)

### Project-Scoped Learnings (v1.18.0)
- `listLearnings()` and `learningsToChunks()` accept `projects?: string[]`
- Only returns learnings matching active workspace project names + universal (no project)
- MCP: `activeProjectNames` state from `loadProjectDirs()` during reindex
- CLI: `cliListLearnings()` and `initEngine()` scope by project
- **NEVER expose all learnings without project scoping** — cross-project IP leakage risk

### Protocol Firewall (v1.19.0)
- **File**: `src/firewall.ts` — `ProtocolFirewall` class
- Wraps EVERY tool response via `respond(toolName, text)` helper in `index.ts`
- Replaced old `maybeNudge()` system (only on 2/17 tools, zero consequences)
- Tracks 4 obligations: learnings saved, session saved, git status, doc freshness
- Escalation: silent → footer → header → degraded (output truncation)
- Compliance-related tools (save_learning, save_session, etc.) are exempt — pass through unmodified
- `firewall.setProjectDirs()` called during reindex and startup
- **⚠️ TRADE SECRET**: Do NOT expose exact thresholds, scoring formula, truncation limits, exempt tool list, or cache intervals in README/docs
- When modifying firewall: always test with `npx vitest run` — all 25 tests must pass
- The `respond()` helper in `index.ts` is the single integration point — all tools funnel through it

### Build & Test
- `npx tsc` — TypeScript compilation (strict mode)
- `npx vitest run` — 25 tests across 3 files (search, learnings, activation)
- `npx eslint .` — typescript-eslint flat config
- Tests must pass before any commit

### npm Publishing
- Package: `@compr/contextengine-mcp`
- `npm publish --access public` (prepublishOnly runs `npm run build`)
- `files` field restricts to: `dist/`, `defaults/`, `skills/`, `examples/`
- `server/` is NEVER published to npm

### VPS Deployment
- SSH: Credentials in `.copilot-credentials.md` (local, gitignored) — use `sshpass -p "$VPS_SSH_PASS"` or source credentials file before running SSH commands
- rsync/scp hang — use `cat local | ssh 'cat > remote'` instead
- Server path: `/var/www/contextengine-server/`
- Dist path: `/var/www/contextengine-dist/`
- PM2: `ecosystem.config.cjs` (NOT `.js` — ESM incompatibility)
- better-sqlite3 pinned to v9.4.3 (VPS g++ 8.3 = C++17 max)
- After deploy: `npx pm2 restart ecosystem.config.cjs && npx pm2 save`

### VS Code Extension
- Source: `vscode-extension/` — 8 TypeScript files
- Publisher: `css-llc` (Azure DevOps PAT, `ymolinier@hotmail.com`)
- Package: `npx @vscode/vsce package` → `.vsix`
- Publish: `echo '<PAT>' | npx @vscode/vsce publish`
- Extension delegates to CLI — benefits from CLI fixes automatically
- Chat commands: `/status`, `/commit`, `/search`, `/remind`, `/sync`
- Doc freshness: `checkCEDocFreshness()` in contextEngineClient.ts — checks copilot-instructions, SKILLS.md, SCORE.md staleness
- Pre-commit hook: `hooks/pre-commit` — warns about stale CE docs (never blocks)
- Terminal watcher: `terminalWatcher.ts` — monitors all terminal commands via Shell Integration API, fires notifications on completion

### Git Hooks & Terminal Patterns
- **Post-commit hook** (`hooks/post-commit`): Auto-pushes to origin + gdrive after every commit
- Push takes 3-10s → VS Code terminal tool reports "cancelled" — but commit AND push succeed
- **MANDATORY**: After ANY "cancelled" git commit, run `git log --oneline -1` to verify — NEVER re-attempt
- **Pre-commit hook** (`hooks/pre-commit`): zsh script — NEVER use `path` as a variable name (zsh ties `$path` to `$PATH`)
- Use `candidate_path`, `file_path`, etc. instead — overwriting `$path` destroys PATH for the rest of the script

### Critical Constraints
- **NEVER commit `.contextengine/`** — user data directory
- **BSL-1.1 license** — no hosted/SaaS competitor allowed
- **Search ranking weights are trade secrets** — don't expose in docs/README
- **Scoring internals are trade secrets** — don't expose point values or anti-gaming methods
- **Protocol Firewall internals are trade secrets** — don't expose thresholds, scoring formula, truncation limits, exempt tool list, or cache intervals
- **Skill files require schema**: `## When to use`, `## Key rules`, `## Examples`

## Examples

### Adding a new MCP tool
```typescript
// In src/index.ts — register in the tools array
{ name: "my_tool", description: "...", inputSchema: { ... } }

// Handle in the CallToolRequest handler
case "my_tool": { /* implementation */ }
```

### Adding a new CLI subcommand
```typescript
// In src/cli.ts — add case in the switch
case "my-command":
  await myCommandHandler();
  break;

// Update help text in cliHelp()
```

### Saving a learning programmatically
```typescript
import { saveLearning } from './learnings.js';
await saveLearning({
  category: 'security',
  rule: 'Always project-scope learnings',
  context: 'Prevents cross-project IP leakage',
  project: 'ContextEngine'
});
```

### Deploying a single file to VPS
```bash
# Load VPS_SSH_PASS from .env or .copilot-credentials.md, then:
export SSHPASS="$VPS_SSH_PASS"
cat dist/file.js | sshpass -e ssh -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no admin@92.243.24.157 \
  'cat > /var/www/contextengine-dist/file.js'
```

---
*Last updated: 2026-02-23 — v1.19.0 + extension v0.4.1*

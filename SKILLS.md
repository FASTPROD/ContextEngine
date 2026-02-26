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

### Learning Quality Gates (v1.19.1)
- **Minimum rule length**: `MIN_RULE_LENGTH = 15` in `src/learnings.ts` — `saveLearning()` throws if rule < 15 chars
- **Auto-categorization**: `inferCategory()` maps 30+ keywords to proper categories when agent sends "other"
- **Import filters**: `importFromMarkdown()` and `importFromJson()` skip rules < 15 chars silently
- **MCP rejection**: `index.ts` `save_learning` handler has try-catch — surfaces rejection message to agents
- All H3 headings, bold bullets, inline-category bullets, and table rows in markdown import check MIN_RULE_LENGTH
- `flushRule()` has its own length check + try-catch to prevent import crashes

### Build & Test
- `npx tsc` — TypeScript compilation (strict mode)
- `npx vitest run` — 57 tests across 6 files (search, learnings, activation, cli, sessions, firewall)
- `npx eslint .` — typescript-eslint flat config
- Tests must pass before any commit

### npm Publishing
- Package: `@compr/contextengine-mcp`
- `npm publish --access public` (prepublishOnly runs `npm run build`)
- `files` field restricts to: `dist/`, `defaults/`, `skills/`, `examples/`
- `server/` is NEVER published to npm

### VPS Deployment
- Credentials in `.copilot-credentials.md` (gitignored)
- rsync/scp hang — use `cat local | ssh 'cat > remote'` instead
- Server path: `/var/www/contextengine-server/`
- Dist path: `/var/www/contextengine-dist/`
- PM2: `ecosystem.config.cjs` (NOT `.js` — ESM incompatibility)
- better-sqlite3 pinned to v9.4.3 (VPS g++ 8.3 = C++17 max)
- After deploy: `npx pm2 restart ecosystem.config.cjs && npx pm2 save`

### VS Code Extension
- Source: `vscode-extension/` — 10 TypeScript files
- Publisher: `css-llc` (Azure DevOps PAT, `ymolinier@hotmail.com`)
- Package: `npx @vscode/vsce package` → `.vsix`
- Publish: `echo '<PAT>' | npx @vscode/vsce publish`
- Extension delegates to CLI — benefits from CLI fixes automatically
- Chat commands: `/status`, `/commit`, `/search`, `/remind`, `/sync`
- Doc freshness: `checkCEDocFreshness()` in contextEngineClient.ts — checks copilot-instructions, SKILLS.md, SCORE.md staleness
- Pre-commit hook: `hooks/pre-commit` — **BLOCKS** (exit 1) when CE docs stale >4h. Override: `git commit --no-verify`
- Terminal watcher: `terminalWatcher.ts` — 9 categories (git, npm, build, deploy, test, database, python, ssh, other), 10 credential redaction patterns, stuck-pattern detection
- Multi-window output.log: `outputLogger.ts` tags lines with `[wsTag]` (workspace name) to disambiguate shared log across windows

### MCP Configuration Per Workspace
- VS Code DEPRECATED MCP in user `settings.json` AND global `mcp.json` — use `.vscode/mcp.json` per workspace
- Schema: `{"servers":{"contextengine":{"type":"stdio","command":"node","args":["..."]}}}` (NOT `mcpServers`)
- Without it, agents in that project have zero ContextEngine tools
- Every new project workspace needs this file — the bootstrapping gap means agents can't access the knowledge base that would tell them how to configure it

### Credential Redaction (v0.6.6)
- 10 patterns: WORD_API_KEY=, WORD_SECRET_KEY=, WORD_SECRET=, WORD_ACCESS_TOKEN=, WORD_API_SECRET=, vendor prefixes (gsk_, sk-live_, sk-test_, ghp_, glpat-, xoxb-, xoxp-), Bearer tokens, connection strings
- Always test redaction with real-world Output panel samples — `api_key=` is too narrow, need `WORD_API_KEY=` format
- `.git/hooks/` path operations classified as [git] not [other]

### Git Hooks & Terminal Patterns
- **Post-commit hook** (`hooks/post-commit`): Auto-pushes to origin + gdrive after every commit
- Push takes 3-10s → VS Code terminal tool reports "cancelled" — but commit AND push succeed
- **MANDATORY**: After ANY "cancelled" git commit, run `git log --oneline -1` to verify — NEVER re-attempt
- **Pre-commit hook** (`hooks/pre-commit`): **BLOCKS** (exit 1) when code staged but CE docs stale (>4h) or missing
- zsh script — NEVER use `path` as a variable name (zsh ties `$path` to `$PATH`)
- Use `candidate_path`, `file_path`, etc. instead — overwriting `$path` destroys PATH for the rest of the script

### Polling & Event Source Dedup (v0.6.5)
- Polling-based architectures (StatsPoller, GitMonitor) must deduplicate at the event source
- Pattern: cheap fingerprint string comparison (`${key1}|${key2}|...`) — only fire events/log when fingerprint changes
- Eliminates 99% of log noise in VS Code Output panel
- Apply to: `onStats` events, git scan logging, status bar updates

### Output File Logger (v0.6.7)
- `LoggedOutputChannel` wraps `vscode.OutputChannel`, mirrors all writes to `~/.contextengine/output.log`
- Agents in any project can `read_file ~/.contextengine/output.log` for terminal/extension activity analysis
- Log has `[HH:MM:SS]` timestamps, session markers (`═══`), auto-rotation at 512 KB
- Debounced writes (2s) — not every appendLine triggers a disk write
- Graceful failure: if logging fails, real OutputChannel still works
- Constructor: `new LoggedOutputChannel(rawChannel)` — drop-in replacement

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
# See .copilot-credentials.md for SSH credentials
cat dist/file.js | sshpass -p '<PASSWORD>' ssh -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no admin@92.243.24.157 \
  'cat > /var/www/contextengine-dist/file.js'
```

---
*Last updated: 2026-02-26 — v1.20.2 + 57 tests + MCP config fix + multi-window output.log tagging*

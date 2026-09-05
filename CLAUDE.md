# CLAUDE.md — ContextEngine

## MODEL POLICY: Opus 4.6 only. Sonnet code requires Opus review before merging.

## What This Is
MCP (Model Context Protocol) server that indexes project documentation and source code into a searchable knowledge base for AI coding agents. Published as `@compr/opscontext-mcp` on npm. (The old `@compr/contextengine-mcp` name is deprecated and frozen at 1.23.1 — never point a command at it.)

## Critical Rules

1. **Keep scoring internals out of *marketing*, but know they are readable** — don't put exact point values, category weights, anti-gaming methods, or search weight ratios in the README or landing pages; sell outcomes, not blueprint. **They are not secret, though.** `dist/agents.js` ships in the npm tarball in plain readable JavaScript, and has since at least 2.1.3 — one `npm pack @compr/opscontext-mcp` and a text editor gets the whole rubric. Do not write, or let anyone believe, that these values are protected. (Updated 2026-08-14 — the previous wording claimed "trade secrets", which was false against what actually shipped.)

2. **Activation gate is mandatory for premium tools** — `score_project`, `run_audit`, `check_ports`, `list_projects` require a valid Pro license. The gate check in `index.ts` and `cli.ts` must never be removed.

3. **The licence is the moat, not the code** — `server/` must never be published (it holds the activation authority). But `agents.ts`, `collectors.ts` and `search.ts` **do** ship compiled in `dist/`, and cannot be excluded: `dist/index.js` and `dist/cli.js` import `./agents.js` directly, and no decrypt-at-runtime machinery exists in `dist/`. Removing them from `files` ships a broken package.

   What actually protects the product: (a) the activation gate — premium tools refuse to run without a valid licence (rule 2), and (b) BSL-1.1's non-compete — no hosted/SaaS offering built on this codebase (rule 8). Reading the algorithm is not the threat; running it unlicensed and reselling it are, and both are already covered.

   **Planned hardening (not yet built):** keep the canonical rubric text on the VPS and ship a build whose strings are neutered — meaningless labels that still let the tool compute and run. That obscures intent without pretending the code is hidden. Until that exists, assume everything in `dist/` is public.

   **Client-side delta bundle retired 2026-08-21** (LOCK `[DELTA-RETIRED]` in `src/activation.ts`): it was downloaded on activation and never imported, from its first commit. The gate is the signed licence alone. Do not bring the bundle back; the planned hardening above is the only sanctioned path.

   _(Updated 2026-08-14. The previous rule required excluding files that were being published anyway, so it was unenforceable and quietly false for at least three releases.)_

4. **All `exec()` calls must use hardcoded strings** — `agents.ts` and `collectors.ts` use `execSync` for git/docker/pm2 data collection. Never interpolate user input into shell commands.

5. **MCP stdout is sacred** — the MCP protocol communicates over stdio. `console.log` in MCP server mode pollutes the protocol stream. Use `console.error` for diagnostics. CLI mode can use `console.log` freely.

6. **Embedding model is local-only** — `all-MiniLM-L6-v2` runs on CPU via `@huggingface/transformers`. No API keys, no data leaves the machine. This is a privacy feature, not a limitation.

7. **Learning store is the single source of truth** — `~/.contextengine/learnings.json` is the canonical knowledge base. Never write learnings to markdown files as a substitute for `save_learning`.

8. **BSL-1.1 license** — non-compete clause: no hosted/SaaS offering using this codebase. Commercial licensing available separately.

9. **Test before publish** — `npm run build` must succeed. Run `npx . search "test"` and `npx . score ContextEngine` to smoke-test before `npm publish`.

10. **Post-push checkpoint** — after every `git push`, call `end_session` (MCP) or run `npx @compr/opscontext-mcp end-session` (CLI fallback). Enforced by hook (`.claude/settings.json` → PostToolUse Bash).

## MULTI-AGENT COST — read this before fanning out

**Cost follows `calls × context`, not `calls × result`.** Every tool result stays in an agent's
context for the rest of its life, and every later turn re-reads the whole accumulation. A
5,936-line reference file searched 11 times is paid for **11 times inside one agent**.

Measured failure, real run: **300 agents, 21.5M tokens — 7.5% real output, 92.5% context
re-reads.** Median 11 tool calls and 73,675 context tokens per agent, to classify 24 products.

1. **Hand the agent what it needs; do not send it searching.** More than 2 tool calls per agent
   is an alarm, not a plan. Pre-computing the candidate set took one task from 8,984 → 1,932
   tokens per item — **4.6×, same model, same output quality**.
2. **Run ONE unit and read its consumption before scaling.** A quality canary is not a cost
   canary. `74k × 300 = 22M` was visible in two minutes, before spending any of it.
3. **Budget the fleet, not just the prompt.** 40 of 300 agents were lost to the session limit —
   13% of the spend bought nothing.

**Why this is dangerous:** the run looks healthy, the quality canary passes, and nothing in the
output hints at it. Cost has to be measured directly; it never shows up in the result.

## Local dev wiring — READ THIS BEFORE ANSWERING "how do I get the update?"

**All FIVE CE surfaces on this machine run the local repo build, not an npm install.**

| Surface | Runs | Refresh after a code change |
|---|---|---|
| Terminal `contextengine` | `npm link` → this repo (`lib/node_modules/@compr/contextengine-mcp` is a **symlink** to `/Users/yan/Projects/ContextEngine`, still under the old package name) | `npm run build` — nothing else, no reinstall |
| VS Code MCP server | `.vscode/mcp.json` → `/Users/yan/Projects/ContextEngine/dist/index.js` (absolute path) | `npm run build`, then **reload the VS Code window** — the MCP process is long-lived and holds the old code until it restarts |
| **launchd autostart MCP server** | `~/Library/LaunchAgents/com.opscontext.mcp.plist` → the same `dist/index.js` | `npm run build`, then **`launchctl kickstart -k gui/$(id -u)/com.opscontext.mcp`**. A VS Code reload does **NOT** touch this — it is a separate process owned by launchd |
| Claude Code MCP (project) | `.mcp.json` → `node dist/index.js`, cwd = this repo, i.e. the local build (since 2026-09-05; see the wiring note below) | `npm run build`, then restart Claude Code |
| Claude Code MCP (global) | `~/.claude.json` user scope (`claude mcp add --scope user contextengine -- npx -y @compr/opscontext-mcp`), the **published** package; applies to **every other project on this machine** | `npm publish`, then restart Claude Code |
| VS Code extension `css-llc.contextengine` | shells out to the CLI | inherits the link automatically |

So: **`npm run build` updates the tooling; `npm publish` does not** — except for the global Claude Code entry above, which runs the *published* package and therefore DOES need a publish.

⚠ **Claude Code wiring, corrected 2026-09-05.** Two things were wrong for weeks and nothing said so:
(1) `mcpServers` in `~/.claude/settings.json` is not read by Claude Code at all; MCP servers live in
`~/.claude.json` (user scope) or a project's `.mcp.json`. The global entry was inert. (2) Inside THIS
repo, `npx -y @compr/opscontext-mcp` can never work: the repo's own `package.json` carries that
name, so npx treats the package as locally installed and runs its bin from the repo's
`node_modules/.bin`, which does not exist (`sh: opscontext: command not found`; `-p` does not help).
Claude Code's MCP log for this project showed that exact failure on 2026-08-23 and 2026-09-05, so
the "Claude Code runs the published 2.5.3 here" premise of SESSION_23 was never true: it ran
nothing. Fix: the project entry runs the local build, like VS Code and launchd; the published
package is exercised from any other project through the user-scope entry.

⚠ **"Reload the VS Code window" is not sufficient on its own.** 2026-08-17: the launchd agent was found still running code loaded on **3 July** — six weeks and four releases stale — because every previous "how do I get the update?" answer listed only three surfaces. Long-lived stale processes are silent: they keep answering, just with old logic, and a long-lived pre-2.4.3 process is the likeliest source of the two unexplained audit-chain forks (SESSION_21 §K/§L).

**Check what is actually running before claiming an update landed:**
```bash
ps aux | grep -E "dist/index\.js|opscontext-mcp|contextengine-mcp" | grep -v grep
launchctl list | grep opscontext
```
Compare each process's start time against your last `npm run build`. Anything older is stale.

⚠ `dist/` is the live artifact here, not a throwaway build output. `scripts/obfuscate-rubric.mjs` rewrites `dist/rubric.js` into its encoded publish form — if you run it manually, finish with a plain `npm run build` so local tooling isn't left running the published artifact.

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
npx . score            # Score THIS project only (writes its SCORE.md)
npx . score --all      # Score every discovered project — writes into EACH (add --no-save to dry-run)
npx . audit            # Run compliance audit
npx . audit-verify     # Verify the hash chain (reads archived segments too)
npx . audit-rotate --dry-run   # Plan a log rotation; archives history, never deletes it
npx . cost             # Multi-agent token/cost/capacity report from Claude Code transcripts
```

<!-- BEGIN: managed by OpsContext (regenerated by `opscontext sync-claude-md`; manual edits to this block are overwritten) -->
## OpsContext snapshot for ContextEngine

_Regenerated 2026-06-11T10:56:37Z. Run `opscontext sync-claude-md` to refresh._

### Top operational rules for this project
- [`0000019eb588e13c` · discipline] Before charging into the next batch off a morning audit, re-run the audit with 4 sub-agents in parallel (anti-pattern, security, lock-enforcer, skeptic). The skeptic will challenge
- [`mpzttwvp4p77` · tooling] Publishing Workflow
- [`mpzttwvnustv` · tooling] git filter-repo
- [`mpzttwvkm1hv` · tooling] Secret patterns
- [`mpzttwvhtx3a` · tooling] Pre-Commit Hook (v0.4.0, upgraded v1.20.0, secret scanner v1.21.1)

### Active policy gates (`.contextengine/policy.json`)
- 3 secret pattern(s): jwt_in_session_doc, anthropic_api_key, openai_api_key
- 4 doc-coverage rule(s)
- 1 deploy-verify host(s)
- 1 bypass token(s)

### Recent hook blocks (last 3, from `~/.contextengine/audit.log`)
- 2026-06-10 — `doc-coverage` blocked: doc-coverage on src/activation.ts → SKILLS.md#activation-and-licensing (doc-not-staged-and-section-unchanged)
- 2026-06-10 — `secret-scan` blocked: secret pattern jwt_in_session_doc at docs/sessions/SESSION_99.md:1
- 2026-06-10 — `doc-coverage` blocked: doc-coverage on src/firewall.ts → SKILLS.md#protocol-firewall (doc-section-not-found)

<!-- END: managed by OpsContext -->

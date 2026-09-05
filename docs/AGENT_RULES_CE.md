# Working rules for agents, with ContextEngine behind them

_Written 2026-08-21, sessions 22 and 23 of ContextEngine. Share this file with any agent working
in Yan's workspace. It lists the rules, why each exists, and the CE tool that enforces or supports
it. Rules without a mechanism are listed as such; a rule that lives only in a file the agent does
not open is not a rule, so the mechanism matters more than the prose._

## 1. Before writing code

| Rule | Why | Mechanism |
|---|---|---|
| Top-tier model only for code, review, commits (Fable 5 or Opus 4.8). Smaller models' output gets a top-tier review before merge. | Unreviewed code from a smaller model shipped once and had to be audited after the fact. | Policy in `~/.claude/CLAUDE.md`. No hook. |
| Read the project's `CLAUDE.md`, `SKILLS.md`, and the latest `docs/sessions/SESSION_N.md` before acting. | Two "findings" this week (delta never loaded, `lock_inventory.sh` not a gate) were already written in SKILLS.md and not read. | `search_context` MCP tool, `contextengine search "..."`. Session auto-injection at MCP start. |
| Re-verify any reading that lowers perceived risk ("by design", "not a bug", "already handled") a second way, never on the surface where the guard already worked. | A benign reading is the one nobody checks. | Memory `feedback-reverify-risk-lowering-reads`. |

## 2. While writing code

| Rule | Why | Mechanism |
|---|---|---|
| Every verified fix gets its LOCK block in the same commit. ASCII markers in source (`[LOCKED] [TAG]`, `[NEVER]`, `WHY:`, `FIX:`), never emoji. | A fix without a LOCK was reintroduced hours later (2026-08-21). Emoji markers make `grep` go silent on the file. | Convention in `~/.claude/CLAUDE.md` § LOCK. `grep -rn "\[LOCKED\]"` before touching a utility. |
| Never remove or route around an existing LOCK. If its subject disappears, replace it with a LOCK that carries the old WHY. | The WHY is the part that survives. | Review. Example: `[DELTA-RETIRED]` carries `[DELTA-VERSION-PIN]`'s history. |
| Shell regex: no `\xNN`, bench under zsh AND bash, both must agree. | Measured: 8 self-introduced defects in two days on this terrain, one reintroduced after its fix. `grep -E` ignores `\xNN`; git hooks run under zsh, benches under bash. | `scripts/test-secret-scan.sh` runs both shells. |
| `exec()` calls use hardcoded strings. Never interpolate input into a shell command. | Injection. | CLAUDE.md rule 4. |
| MCP stdout is the protocol. Diagnostics go to `console.error`. | One `console.log` corrupts the stream. | CLAUDE.md rule 5. |
| An absence of output is a measurement, not a verdict. A check that cannot run says "unknown", never "pass". | `git ls-files .env` returned "" on a broken repo and a security check awarded 6/6. | LOCK `[EXEC-FAILURE-IS-NOT-EMPTY]` in `src/agents.ts`. Inventory of swallowed errors in SESSION_23. |
| Secrets never appear in a command, a doc, a commit message, a test fixture, or a comment. Credential files are read only through `~/.claude/bin/cred-field`. | Four leaks on 2026-08-20/21, one by an agent printing a credentials file. | PreToolUse hook blocks any Bash command naming a credentials file (it blocked the first draft of this very file). Pre-commit secret scanner on 25 repos. |

## 3. Before anything leaves the repo

| Rule | Why | Mechanism |
|---|---|---|
| Adversarial second pass, unasked, on any code that ships (a hook synced to 25 repos, a deploy script, a package). Real files, real commits, both shells, the failure path. "Bench green" is where verification starts. | Asked once, such a pass found 5 defects in code whose bench was green. | Memory `feedback-adversarial-pass-before-deploy`. Not mechanised; it is the agent's job. |
| Absolute paths for every script. Read the first line of its output: every deploy script prints its project name. | A bare `./deploy.sh` ran the wrong project's deploy against production (2026-08-16). | Working-style rule. `cd /abs/path && ./script` in one command. |
| Deploy = verify live. `git push` is backup, not deployment. | Activation server was ten weeks behind while everyone assumed it shipped. | `server/deploy.sh` with `--check` drift detection. Post-push `end_session` hook. |
| After `npm publish`, `npm run verify-release` must pass before the word "published" is written anywhere: a real MCP `initialize` + `tools/list` from the repo build AND from the registry package in a foreign cwd, served version compared to package.json. `npm view`, a tarball grep or `--version` prove nothing about Claude Code. | Three releases were "published and verified" while Claude Code ran nothing here (`sh: opscontext: command not found` in its MCP log, 2026-08-23 and 2026-09-05). | `scripts/verify-release.sh`, LOCK `[RELEASE-PROVEN-BY-HANDSHAKE]`. |
| Never `--no-verify`. If the scanner blocks, reformulate. | It refused four agent commits this session, all four times correctly. | Pre-commit hook. |
| Score verification always with `--no-save`; any subagent gets `CONTEXTENGINE_WORKSPACES` pointed at a sandbox. | `score --all` writes SCORE.md into every project. | CLI flags. |
| Shared VPS: before any ssh to a box another terminal is using, ask where it is. fail2ban: 3 attempts, 2 h on Gandi. Read `admin.CROWLR/docs/SSH_REMOTE_EXECUTION.md` first. | Lockouts. | Runbook. Jump hosts in `~/.ssh/config`. |

## 4. Cost and scale

| Rule | Why | Mechanism |
|---|---|---|
| No subagents or workflows unless Yan asks in his own words. State the price (agent count, expensive path) before launching. Default subagents to Sonnet for mechanical work. | One day: 74% of usage from `workflow-subagent`, never warned. | `~/.claude/AGENT_USAGE.md`. `agent_cost` MCP tool / `contextengine cost` measure it afterwards. |
| Cost follows calls x context, not calls x result. Hand the agent what it needs; more than 2 tool calls per agent is an alarm. Run one unit and read its consumption before scaling. | 300 agents, 21.5M tokens, 92.5% of it context re-reads. | CLAUDE.md § MULTI-AGENT COST. `agent_cost` reports `context_burn` and `fanout_without_canary`. |
| Dollar figures are notional on a Max subscription. Never present them as spend; capacity is the scarce resource. | Misleading otherwise. | `agent_cost` labels them NOTIONAL; unknown models report UNPRICED, never $0. |

## 5. Communication

- Short. Plain words. Lead with the answer or the ask. Three lines over three paragraphs.
- Never an em-dash or en-dash, anywhere, including commit messages and docs. Comma or restructure.
- When asking Yan to test: what to run, what to look for, one or two lines.
- Details go in the session doc, not the chat.
- Report faithfully: a failed test is reported with its output, a skipped step is named as skipped.

## 6. What ContextEngine gives the agent (state at 2.5.6 published, 2026-09-05 evening)

| Surface | What it does | Command / tool |
|---|---|---|
| Search | Hybrid BM25 + local embeddings over every project's docs, sessions, learnings, ops data. Nothing leaves the machine. | `search_context`, `contextengine search` |
| Learnings | Single source of truth at `~/.contextengine/learnings.json`. Never write learnings to markdown instead. **Read them through the tool, never by probing the JSON:** on 2026-09-05 two agents read a key the records do not have and answered "0 saved today" with confidence. Every entry now shows its `created` instant (UTC + Europe/Zurich); `--since today` answers the question. LOCK `[LEARNINGS-LIST-SHOWS-CREATED]`. | `save_learning`, `list_learnings` (`since`), `contextengine list-learnings [cat] --since today` |
| Sessions | Save at the end, auto-injected at the next start. | `save_session`, `end_session` (enforced after every `git push` by hook) |
| Audit log | Hash-chained, tamper-evident record of every state change and every tool call. Verifies the whole history, archived segments included. | `audit_verify`, `contextengine audit-verify` |
| Audit rotation | Automatic: at MCP start and hourly, when the live log passes 100k records, down to 50k. Archives, never deletes. One runner at a time. | `contextengine audit-rotate --dry-run` to inspect. `CONTEXTENGINE_AUTO_ROTATE=0` to disable. |
| Redactions | Removing a secret from an old record is legitimate; acknowledge it on the chain so the verifier reports "redacted", not "altered". No side list. | `contextengine audit-redact-ack --index i,j --reason "..."` |
| Policy gates | `.contextengine/policy.json`: secret patterns, doc coverage, deploy-verify hosts, bypass tokens, agent_cost thresholds and rates. | `contextengine policy validate`, pre-commit hook |
| Pre-commit scanner | One hook, synced to 25 repos, value-independent password patterns, 0 false positives on 45 real commits. | `scripts/sync-hooks.sh --check` to see drift |
| Multi-agent cost | Tokens moved, notional cost, capacity intensity, top runs, burn signals, from Claude Code's own transcripts. | `agent_cost` (2.5.4), `contextengine cost` |
| Drift detection | Loop, stuck tool, fabrication, silent failure signals over the recent audit window. | `drift_status` |
| Scoring and audit (Pro) | AI-readiness score, compliance audit, port conflicts, cross-project view. Gate is the signed licence. | `score_project --no-save`, `run_audit`, `check_ports`, `list_projects` |

## 7. Changed this week, so agents stop relying on the old shape

- The client-side "delta bundle" is gone (2.5.4). Premium code ships in the package; the signed licence is the gate. Do not write code that expects `~/.contextengine/delta/`.
- The activation server moves to a new Gandi box (reinstall in progress). `server/deploy.sh` must be repointed before the first deploy. Until then, no deploy to the old IP.
- `lock_inventory.sh` in the Odoo connector is an inventory, not a gate. Run it by hand around the ASCII migration of that repo.
- Rotation no longer refuses because of damage inside already-archived segments; it refuses only for damage in the live log.
- `agent_cost` needs `policy_dir` when called from the long-lived MCP server: the daemon's cwd is the home dir, not a repo.
- Claude Code's MCP entries run the **published** package (`npx @compr/opscontext-mcp`). New tools appear there only after `npm publish`. The terminal CLI and the launchd server run the local build.

## 8. Where things are

| What | Path |
|---|---|
| Global rules | `~/.claude/CLAUDE.md` |
| Subagent cost method | `~/.claude/AGENT_USAGE.md` |
| This repo's rules | `CLAUDE.md`, `SKILLS.md` |
| Session history | `docs/sessions/SESSION_22_2026-08-19.md`, `docs/sessions/SESSION_23_2026-08-21.md` |
| SSH runbook for shared boxes | `~/Projects/admin.CROWLR/docs/SSH_REMOTE_EXECUTION.md` |
| Credentials | per-project credentials file (gitignored), read via `~/.claude/bin/cred-field` only |

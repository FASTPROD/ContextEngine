# Prompt - CE fleet audit: which repos are actually gated, and by what

**Status: Yan GO to open when he wants it. Independent of every other thread,
waiting on nothing.** Written 2026-09-04 from the connector S28 thread, where the
gap surfaced.

**Read this first: AUDIT AND REPORT BEFORE YOU CHANGE ANYTHING.** The first
deliverable is one table. Migrations happen only on the rows Yan picks, in a
second pass. Do not migrate 24 repos because you found 24 repos.

## The finding that opens this

Measured 2026-09-04 across `~/Projects`:

- **2 repos** have `.contextengine/policy.json`: `invoc.io` and `ContextEngine`.
- **24 repos** have a `pre-commit` hook and **no** policy file, so they fall back
  to the legacy 4-hour wall-clock doc-freshness gate.

The hook's own comment names why that matters: the wall-clock path *"was the
workaround pattern (touching SKILLS.md to reset the clock)"*. A gate whose
documented bypass is "touch a file" is a gate people bypass, and in the S28
session FC's pre-commit was bypassed on all six commits while `invoc.io`'s
policy-driven `doc_coverage` hook passed cleanly on equivalent commits the same
day. The modern path is diff-aware; the legacy one is a timer.

Migration is explicitly opt-in in the hook: add `.contextengine/policy.json`.

**The 24 include `FC_project` and `invocme-odoo-connector`**, the two most active
repos in the fleet.

## Already-known open items to fold in, not rediscover

- **`admin-invoc-node`'s hook still BLOCKS.** Recorded in auto-memory
  `reference_ce_precommit_is_vestige` and `project_ce_hook_stale_docs_backlog`:
  it needs its three CE docs refreshed and a learning saved. This is the one
  repo where the gate is actively costing someone time.
- **`lock_inventory.sh` is an inventory, NOT a gate, and stays that way.** Owner
  decision 2026-08-21, re-verified 2026-09-01, with three reasons written down in
  `~/.claude/CLAUDE.md`. **Do not re-litigate it and do not wire it into a hook.**
- **`sync-hooks.sh` covers 25 repos** (ContextEngine `scripts/sync-hooks.sh`).
  Nothing verifies they are all on the same hook version. Check it; drift here is
  invisible and would explain any repo behaving differently from its neighbours.
- **A CLI bug in `save-learning`**, hit again 2026-09-04: it stored the literal
  string `--rule ` as the first characters of the rule text. The learnings store
  was swept the same day and only ONE entry was affected, which was fixed, so
  there is no data backlog. **The bug is at source, in the CLI, so it will keep
  recurring.** `~/.claude/CLAUDE.md` already carries "check the stored JSON after
  saving" as a workaround; fixing the CLI retires the workaround.

## The work, in order

1. **One table, committed before any change.** Per repo: has policy.json yes/no,
   pre-commit hook version or hash, whether the hook currently blocks, last
   commit date, and whether a chat is live in it right now (`git status`).
   Include the dormant repos and mark them dormant - a dormant repo probably does
   not deserve a migration.
2. **Recommend, do not act.** Which repos are worth migrating and why. Expect the
   answer to be "the active handful", not all 24. FC and the Odoo connector are
   the obvious first candidates on commit volume alone.
3. **Fix `admin-invoc-node`**, which is a live block, not a preference.
4. **Fix the `save-learning` CLI prefix bug** at source, with a test.
5. **Only then**, and only on Yan's picks, author the policy files. Each one is a
   behaviour change on every future commit in that repo.

## RAILS

- **`git status` in a repo BEFORE touching it, every time.** Several repos run
  parallel chats. On 2026-09-04 two chats in one checkout swept each other's work
  into their commits one second apart. **Stage explicit paths, never
  `git add -A`.** (`invocme-odoo-connector`
  `docs/sessions/SESSION_28_2026-09-04.md` section 6c.)
- **A hook change lands on every commit that repo makes afterwards.** Do not ship
  one into a repo with a live chat mid-feature. Ask, or wait.
- **Never claim absence from a partial search.** Env files and the per-project
  credentials notes are hook-blocked and CANNOT be read here, so any statement
  about what is configured must say what was not checked. See
  `~/.claude/CLAUDE.md`, "NEVER claim absence from a partial search".
- Absolute paths on every command; the Bash cwd silently reverts.
- No subagents unless Yan asks. This is a `find` and a table, not a fan-out.

## What this is NOT

Not a rewrite of the shared hook, not a new gate, not a policy schema redesign,
and not an excuse to add doc requirements to 24 repos. The goal is that the fleet
runs the gate it already has, on purpose rather than by accident, and that the
one repo currently blocked stops being blocked.

# Fleet gate audit - which repos are gated, and by what

**Measured 2026-09-04, ~19:45 local. Report only: nothing was changed, no hook was
written, no policy file was authored.** Answers step 1 of
`docs/sessions/PROMPT_CE_FLEET_GATE_AUDIT.md`.

## Headline

| | count |
|---|---|
| repos with a `pre-commit` hook | **27** |
| of those, on the **policy** path (`.contextengine/policy.json` present) | **2** (ContextEngine, invoc.io) |
| of those, on the **legacy 4-hour wall-clock** path | **25** |
| legacy repos that would **block a code commit right now** | **23 of 25** |
| repos with **no hook at all** | 7 (4 are worktrees or sim clones) |

Two corrections to the opening finding, both measured:

1. The legacy set is **25, not 24**. `FASTPROD` lives in `~/`, not `~/Projects`, and
   carries the same hook. Any sweep scoped to `~/Projects/*` misses it. (`sync-hooks.sh`
   itself does look in `~/COMPR` and `~/FASTPROD`, so the script is right and the
   earlier count was the thing that was short.)
2. **A drift verifier does exist**: `scripts/sync-hooks.sh` with no arguments is a
   read-only drift report. It is not that nothing can check, it is that nothing runs it
   on a schedule and nothing fails when it drifts.

## The gate is a timer, not a staleness check

The legacy path blocks when a commit stages a code file
(`ts|tsx|js|jsx|py|rs|go|java|rb|php|vue|svelte|css|scss|html`) and any of
`copilot-instructions.md`, `SKILLS.md`, `SCORE.md` is missing, or was last written more
than 4 hours ago and is not itself in the commit.

That means **every repo fails four hours after its last doc write, with no code change
and no decision by anyone.** The two legacy repos that pass right now
(`admin-invoc-node`, `invocme-odoo-connector`) pass only because a session touched their
docs in the last hours; both are back to blocking by tonight. This is what the hook's own
comment means by *"the workaround pattern (touching SKILLS.md to reset the clock)"*.

**Five repos can never pass a code commit at all**, because a required doc does not exist
in any of the three locations the hook looks in: `DEUD.ch`, `EXO`, `VOILA.tips`,
`app.CROWLR-flutter-legacy`, `invocme-erpnext-connector`. For those, the only paths are
`--no-verify`, creating the file, or a policy file. All five are dormant, which is the
only reason it has not been felt.

## The table

Ages in hours at measurement time. `MISS` = file absent from `<repo>/`, `.github/` and
`.github/instructions/`. `blocks now` = would a commit staging one code file be refused.
`live` = uncommitted changes or a commit today, i.e. treat as an occupied checkout.

| repo | policy | hook | CI.md | SKILLS | SCORE | blocks now | commits 30d | code files 30d | live |
|---|---|---|---|---|---|---|---|---|---|
| invoc.io | **YES** | 5e54f088 | 339 | 339 | 339 | policy path | 351 | 71 | yes |
| ContextEngine | **YES** | 16502686 | 381 | 74 | 74 | policy path | 88 | 83 | yes |
| invocme-odoo-connector | no | 5e54f088 | 1 | 4 | 3 | no (timer not yet expired) | 235 | 310 | yes |
| FC_project | no | 5e54f088 | 7 | 3 | 58 | **YES** stale | 233 | 497 | yes |
| admin.CROWLR | no | 5e54f088 | 79 | 120 | 123 | **YES** stale | 134 | 89 | - |
| admin-invoc-node | no | 5e54f088 | 1 | 1 | 1 | no (timer not yet expired) | 126 | 180 | yes |
| KONIVE.com | no | 5e54f088 | 52 | 52 | 52 | **YES** stale | 103 | 301 | yes (6 dirty) |
| PLANK.io | no | 5e54f088 | 105 | 75 | 105 | **YES** stale | 81 | 6 | - |
| agent.invoq.me.ai | no | 5e54f088 | 2 | 75 | 80 | **YES** stale | 33 | 39 | yes (13 dirty) |
| CROWLR.io | no | 5e54f088 | 79 | 75 | 79 | **YES** stale | 21 | 20 | - |
| app.CROWLR | no | 5e54f088 | 96 | 96 | 96 | **YES** stale | 19 | 122 | - |
| shop.invoc.io | no | 5e54f088 | 440 | 75 | 457 | **YES** stale | 12 | 19 | - |
| INVOK.fr | no | 5e54f088 | 79 | 79 | 79 | **YES** stale | 10 | 5 | - |
| FASTPROD | no | 5e54f088 | 169 | 169 | 169 | **YES** stale | 6 | 63 | yes (4 dirty) |
| COMPR-app | no | 5e54f088 | 96 | 96 | 96 | **YES** stale | 6 | 2 | - |
| LinkedinHub | no | 5e54f088 | 123 | 123 | 123 | **YES** stale | 5 | 4 | - |
| COLDemail | no | 5e54f088 | 3704 | 3704 | 457 | **YES** stale | 5 | 0 | 5 dirty |
| VOILA.tips-front | no | 5e54f088 | 4006 | 4006 | 457 | **YES** stale | 3 | 0 | - |
| compR.fr | no | 5e54f088 | 1692 | 1692 | 457 | **YES** stale | 2 | 0 | - |
| STRIPE backend | no | 5e54f088 | 1256 | 1256 | 457 | **YES** stale | 2 | 0 | - |
| EXO | no | 5e54f088 | **MISS** | 440 | 457 | **YES** permanent | 2 | 0 | dormant |
| invoc.ch | no | 5e54f088 | 4031 | 4031 | 457 | **YES** stale | 1 | 0 | dormant |
| DEUD.ch | no | 5e54f088 | 4270 | **MISS** | 457 | **YES** permanent | 1 | 0 | dormant |
| VOILA.tips | no | 5e54f088 | 4271 | **MISS** | 457 | **YES** permanent | 1 | 0 | dormant |
| app.CROWLR-flutter-legacy | no | 5e54f088 | 4270 | **MISS** | 457 | **YES** permanent | 1 | 0 | dormant |
| invocme-erpnext-connector | no | 5e54f088 | **MISS** | **MISS** | 457 | **YES** permanent | 1 | 0 | dormant |
| GOOGLE Analytics | no | 5e54f088 | 4271 | 4562 | 457 | **YES** stale | 1 | 0 | dormant |
| invoc-mobileapp | no | none | MISS | MISS | 457 | no hook | 21 | 0 | - |
| invoq-skills | no | none | MISS | MISS | MISS | no hook | 4 | 1 | - |
| invoq-acp-python | no | none | 3486 | 3486 | 457 | no hook | 2 | 1 | 2 dirty |
| FC_project-sim | no | none | 1058 | 1058 | 457 | no hook | 2 | 0 | 2 dirty |
| FC_mc_wt / FC_mw_wt | no | none | 1231 | 1231 | 457 | no hook | 1 each | 0 | worktrees |
| COMPR | no | none | MISS | MISS | MISS | no hook | 0 | 0 | dormant (Apr 2026) |

## Three findings the table does not say out loud

**1. ContextEngine runs an older hook than the fleet it syncs.** Its hook is
`16502686`; all 25 others are `5e54f088`. The diff is exactly two hunks, both from
2026-08-29, both LOCK'd in the shared version:
`[ALLOWLIST-ROUTE-PATH-IS-LETTERS-ONLY-NEVER-DIGITS]` and
`[SKIP-LOCALES-IS-DIRECTORY-SCOPED-JSON-ONLY]`. `sync-hooks.sh` skips ContextEngine on
purpose (`[ "$name" = "ContextEngine" ] && continue`), so the source repo is the one repo
its own sync never reaches. The practical effect is narrow, CE has no `locales/` and no
router table, but the fleet's reference copy is behind its own product.

**2. The policy path silently degrades to the legacy path if the CLI is not found.**
The hook takes the policy branch only when `CE_CLI` resolves AND `policy.json` exists;
otherwise it falls through to the timer with no message. The CLI resolves to
`~/.nvm/versions/node/v20.19.4/bin/contextengine`, and that is the **only** node version
carrying it (`v19.0.0` and `v20.19.2` do not). The hook's hardcoded PATH prefix
(`/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`) does not include any nvm path, so it
works today purely because the interactive shell's PATH carries it. `nvm use 20.19.2`, a
GUI git client, or any non-login commit context turns both policy repos back into
wall-clock repos without printing anything.

**3. Doc freshness is measured by mtime, so `touch` is a full bypass** and a fresh
`git clone` or checkout is 100% compliant by construction, having just written every
file. The gate cannot distinguish a doc that was updated from one that was opened.

## Recommendation (nothing acted on)

Migrate the **five repos where the gate is a daily tax on real work**, in this order:

1. `FC_project` - 497 code files in 30 days, blocking right now.
2. `invocme-odoo-connector` - 310 code files, passing only on a timer.
3. `admin-invoc-node` - 180 code files, and the repo already named as actively blocking.
4. `KONIVE.com` - 301 code files, blocking right now, 6 dirty.
5. `admin.CROWLR` - 89 code files, blocking right now.

`agent.invoq.me.ai`, `app.CROWLR`, `CROWLR.io`, `PLANK.io`, `shop.invoc.io` are the
second tier: real but lower volume, worth doing only after the first five prove the shape.

**Leave the 12 dormant repos alone.** A dormant repo pays nothing for a broken gate,
and a policy file there is a behaviour change nobody will be present to notice. That
includes the five permanently-blocked ones: if one of them wakes up, migrate it then.

**The 7 hookless repos are a separate question**, not part of this migration: they have
no gate at all, which is a different problem from having the wrong one.

Two fleet-level fixes are worth more than any single migration, and neither is a policy
file:

- Put the CLI where the hook's own PATH can find it (a symlink into `/usr/local/bin`),
  so the policy path cannot degrade silently. Better: make the hook say so when
  `HAS_POLICY` is true and `CE_CLI` is empty, instead of falling through quietly.
- Run `scripts/sync-hooks.sh` (check mode) on a schedule, or from CI, and let it fail.
  A drift report nobody runs is the same shape as the disconnected `rule-parity`
  checker this repo already fixed once.

## Scope of this audit, and what was NOT checked

- Measured by reading each repo's `.git/hooks/pre-commit` (md5), `.contextengine/`,
  doc mtimes, and `git log`. Every number above is reproducible from a read-only sweep
  script kept in this session's scratchpad.
- **`scripts/sync-hooks.sh` could not be executed here** - the sandbox classifier denied
  running it. The md5 sweep above is a superset of what its check mode reports, but its
  own dead-code detection (`exit 0` before end of file) and its `Cr0wlr_Pr0d_` marker
  test were **not** run.
- **Not checked, and not checkable from here**: env files and the per-project credentials
  notes in every repo (both are off-limits to an agent by hook), any hook installed on a
  server rather than this Mac, CI-side gates in GitHub Actions, and whether any commit in
  history actually used `--no-verify` (git records no such marker).
- Repo scope was `~/Projects/*`, `~/COMPR`, `~/FASTPROD`. A repo outside those three
  locations was not seen.

# Handover: the deploy preflight, and which of the seven fleet scripts need which check

Written 2026-09-05 from the invoc merge session, so the ContextEngine session does not
re-derive it. **The survey and the snippet are DONE. What remains is wiring and
distribution.**

## Why this exists

The global CLAUDE.md multi-tenant deploy rule has always said: *"Commit the script BEFORE
running it the first time (so there's a rollback for the script itself)."*

On **2026-09-05 two separate agent sessions broke that rule on the same day, in two
different repos, independently.** Both then hit their deploy script's own drift guard,
because the server held content matching no commit. Neither could follow the printed fix:
one reconciliation commit was rejected by the secret scanner (a false positive on the word
"pass" followed by a colon), and the target directory was root-owned, so the owner had to
run a privileged delete by hand.

**The rule was loaded in context both times and simply not applied.** A third restatement
would not have helped. That is the whole argument for a check instead of a sentence, and it
is the same conclusion the invoc merge lane reached the same day for its own rulings.

## The survey, measured 2026-09-05

Machine check over all seven fleet deploy scripts: **none of them has this guard.** Only
`admin-invoc-node/scripts/safe-deploy.sh` does, added the same day (LOCK
[DEPLOY_ONLY_COMMITTED_FILES], and it is the reference implementation).

They are NOT one shape. They are three, and using the wrong check on the wrong one either
does nothing or refuses every deploy.

| script | what it ships | check to use |
|---|---|---|
| `compR.fr/deploy.sh` | source files by rsync | **files** |
| `PLANK.io/scripts/deploy_backend.sh` | whitelisted source files, one scp each | **files** |
| `ContextEngine/server/deploy.sh` | a built bundle | **tree** |
| `app.CROWLR/scripts/deploy_frontend.sh` | a built bundle | **tree** |
| `COMPR-app/scripts/deploy_frontend.sh` | a built bundle | **tree** |
| `invoc.io/deploy.sh` | a built bundle | **tree** |
| `admin.CROWLR/scripts/deploy_backend.sh` | nothing, the server pulls from git | **pushed** |

**Why three and not one:**

- **files** is the exact failure that happened: a named source file is shipped, so refuse
  if it is untracked or modified.
- **tree** is for the four that ship a build. The bundle is gitignored, so checking the
  bundle would refuse every deploy. What matters is the source it was built from: a bundle
  built from a dirty tree corresponds to no commit, so nothing can ever identify what is
  running. Arguably the strongest case of the three, because a built artifact carries no
  identity of its own at all.
- **pushed** is for the git-pull deploy. Uncommitted work cannot reach that server by
  construction, so the files check is pointless there. Its real risk is the opposite one:
  deploying while the commit is not pushed, so the server pulls older code than you think
  and the deploy silently does nothing.

## What is already done

`ContextEngine/scripts/deploy-preflight.sh`, LOCK [DEPLOY_ONLY_COMMITTED]. Three functions,
`deploy_preflight_files`, `deploy_preflight_tree`, `deploy_preflight_pushed`. Each returns 0
when clean, prints a refusal and returns 1 when not, and honours `ALLOW_UNCOMMITTED=1` as
the deliberate human exception, saying so out loud rather than skipping silently.

**Tested before handover:** clean tracked file passes, untracked file blocks, dirty tree
blocks, override skips. Written for bash 3.2 (macOS) and `set -u`.

## What remains, for the ContextEngine session

1. **Decide the distribution mechanism.** `sync-hooks.sh` copies one git hook into 25
   repos, but a deploy happens outside git so a hook cannot see it. This needs the same
   *pattern* (one source of truth here, copied out) applied to a sourceable shell file, not
   the hook path itself. Copying by hand into seven repos is the alternative and it drifts;
   the owner's own recorded reasoning when declining a per-repo lock inventory says the
   same thing.
2. **Wire each of the seven**, using the table above. One line to source it, one line to
   call it, placed after the file list is built and before anything is transferred.
3. **Verify each wiring the way the reference one was verified**: make a real uncommitted
   change, confirm the script refuses, restore. An exit code is not evidence.
4. **Record the lesson as a CE learning**, not as seven copies of prose. Per the owner's
   "one canonical home" rule, a cross-project process lesson lives in a CE learning and
   every other layer gets a pointer.

## Caveats worth carrying

- Do not add the **files** check to the git-pull script; it would pass trivially and give
  false comfort.
- Do not add the **tree** check to a repo where the build output is committed, if any turn
  out to be; check before assuming.
- **Where exactly the tree check goes, measured 2026-09-05.** THREE of the four bundle
  scripts run the build themselves, so the check must sit **above** that line or a dirty
  tree gets a full build first and is refused afterwards:

  | script | build line | put the check |
  |---|---|---|
  | `ContextEngine/server/deploy.sh` | 78, `npm run build` | above line 78 |
  | `app.CROWLR/scripts/deploy_frontend.sh` | 202, `npm run build` | above line 202 |
  | `invoc.io/deploy.sh` | 64, `npm run build` | above line 64 |
  | `COMPR-app/scripts/deploy_frontend.sh` | none, it REFUSES if the build is absent (line 29) | beside that same check, line 29 |

  Line numbers are from 2026-09-05; confirm them before editing rather than trusting them.

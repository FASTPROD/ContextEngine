# Prompt for Session 25: learnings quality, then the rubric

Paste this to start the next chat, in the ContextEngine repo.

---
ContextEngine, HEAD clean. Read docs/AGENT_RULES_CE.md in full, then
docs/sessions/SESSION_24_2026-09-05.md in full (the store wipe, its fix, the restore), then
~/.claude/CLAUDE.md. Rules of AGENT_RULES_CE.md apply unchanged, in particular: no em-dash,
adversarial pass before anything ships, LOCK in the same commit, absolute paths, tests run under
the isolated HOME (vitest setupFiles), `npm run verify-release` after any publish.

State: 2.5.6 published and verified; the store has ~3,005 records, of which a large share are
markdown headings auto-imported from ~880 doc files with an inferred category that is often
wrong ("Flow A" in mobile, "Scoring internals are trade secrets" in mobile). Yan's GO on
2026-09-05 evening for the three items below, in this order. Numbers first, then his GO on
anything that deletes or rewrites store records.

1. Stop importing every H3 heading as a rule. Measure first: how many store records come from
   auto-import (context "Imported from file" or a doc source), by file and by category; which
   files are real learnings files (AGENT-LEARNINGS.md, SKILLS.md "Learnings" sections) and
   which are ordinary docs. Propose the import rule (allowlist of files/sections, or a marker),
   implement, test, and propose a cleanup of the noise with counts, not a deletion.
2. Category inference: measure the current inferCategory() against a labelled sample, fix the
   worst rules, add tests. Every change must keep [LEARNINGS-LIST-SHOWS-CREATED] and
   [STORE-NEVER-STARTS-FRESH-OVER-DATA] intact.
3. Rubric rebalancing (SESSION_21), only after 1 and 2 are committed.

UX note from Yan (2026-09-05): a count of learnings is a vanity metric. What has value is what
CE prevents (blocks per week, last case) and what it recalls at the right moment (the 5 rules of
this repo, with a thumbs up/down), plus "what runs in prod, what changed today". Keep that in
mind for any surface touched.

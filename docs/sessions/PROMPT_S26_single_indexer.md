# Prompt for Session 26: one indexer, many readers

Paste this to start the next chat, in the ContextEngine repo.

---
ContextEngine, HEAD clean, 2.5.9 published. Read docs/AGENT_RULES_CE.md in full, then
docs/sessions/SESSION_25_2026-09-05.md in full (the store cleanup, the two stale servers, the
registry, the growth tripwire), then ~/.claude/CLAUDE.md. Rules unchanged: no em-dash,
adversarial pass before anything ships, LOCK in the same commit, absolute paths, tests under
the isolated HOME, `npm run verify-release` after any publish, `contextengine servers` after
any build, publish only on Yan's GO in his own words.

The problem, measured 2026-09-05 evening: every Claude Code chat spawns its own MCP server
(`.mcp.json` per project, user-scope entry elsewhere), plus launchd, plus VS Code. Each server
indexes the same ~820 doc sources, embeds the same chunks on CPU, watches the same files, and
re-indexes and re-embeds on every doc change. Nine chats open = nine full re-embeds per saved
file; load average 230 on Yan's Mac, a test suite that times out, and until 2.5.6 nine writers
racing on one learnings.json. The registry (`contextengine servers`) now shows the count and
warns above 3; it does not reduce the cost. Each server also holds its own copy of the
embedding cache in memory (`~/.contextengine/embedding-cache.json`, 36 MB on disk).

Goal: one process indexes and embeds; every other server reads. A doc change costs one
re-index, not N. Cheap to run, nothing leaves the machine (rule 6, local embeddings), no new
daemon the user must install by hand if it can be avoided.

Order of work, numbers first, Yan's GO before any design is committed:

1. Measure the cost today, from real data, before designing anything: per server, time and
   CPU of a cold start (index + embed), of a re-index after one doc change, memory held;
   how many doc changes per hour on a normal day (audit log, git); how often two servers
   re-index the same change. One table. `agent_cost` and the audit log are the sources; a
   stopwatch on a real `node dist/index.js` start is fine.
2. Read how it is wired today: `src/index.ts` (reindex, the fs.watch watchers around line
   322, loadCache/saveCache), `src/cache.ts` (`clearCache()` is known dead code, SESSION_23),
   `src/embeddings.ts`, `src/ingest.ts`, `src/http-server.ts` (there is an HTTP surface
   already; find out what it serves and who uses it), the launchd plist
   `~/Library/LaunchAgents/com.opscontext.mcp.plist`, `src/install-autostart.ts`.
3. Design options, each with what it costs the user to adopt and what breaks if the single
   indexer is absent. Candidates to weigh, not a list to implement: (a) leader election on a
   lock in ~/.contextengine, the leader indexes and writes the shared cache, followers load
   the cache read-only and never watch files; (b) the launchd server becomes the indexer and
   the MCP servers become thin clients over the existing HTTP surface or a unix socket;
   (c) a shared on-disk index (chunks + embeddings) with a version stamp, every server maps
   it read-only and re-reads on stamp change, one writer chosen by (a). Say which one you
   recommend and why in five lines. State what happens on the first machine with no
   launchd agent, and on a machine with one chat only.
4. Yan's GO on the design. Then implement behind a flag if the change is deep, tests under the
   isolated HOME, a real trial: three servers started from three cwds, one doc change, prove
   ONE re-index happened (audit log, registry, CPU), and prove a follower answers
   `search_context` with the new content within seconds.
5. Keep intact: [STORE-NEVER-STARTS-FRESH-OVER-DATA], [STORE-GROWTH-IS-A-TRIPWIRE-TOO],
   [SERVERS-ARE-INVENTORIED], [AUTO-IMPORT-ONLY-MARKED-LEARNINGS], MCP stdout is the protocol
   (rule 5), no API keys (rule 6). The registry should gain one field: role (indexer or
   reader), shown by `contextengine servers`.

Not this session: the VS Code status bar redesign (item 4 of the Session 25 prompt, still
open), the reindex-frequency and runtime-version-drift monitors named in SESSION_25. Mention
them in the session doc, do not build them.

UX note from Yan, still valid: the value of CE is what it prevents and what it recalls at the
right moment, not counts. A user should never have to know how many servers run.

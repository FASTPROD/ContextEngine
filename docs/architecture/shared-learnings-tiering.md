# Shared learnings — tiering decision

> Saved 2026-06-22 (Session 09).
> Decision: shared community learnings store is a **PRO+ feature**. Free tier stays local.

## The decision in one sentence

**Reading the shared community learnings library is a PRO feature. Writing to a private team library is a Team feature. Local-only learnings stay free for everyone.**

## Why this tiering

The community learnings store is the **data network effect** — every miss saved by every user makes every future user smarter. That's the single biggest moat we can build. But it costs us nothing per user to operate (one Git repo, one HTTP fetch per machine per day) — so the question is positioning, not infrastructure.

Three options were considered:

| Option | Tier model | Verdict |
|---|---|---|
| A — Everyone gets the shared library free | One tier, free everywhere | ❌ Gives away the moat. Free users have no reason to convert. |
| B — Library is PRO-only; free users get local only | Pro $X / Team $Y / Enterprise $Z | ✅ Adopted. Aligns library access with paid tiers; free users still get a working product, paid users get the network effect. |
| C — Library is free read; write is paid | Two-sided market | ❌ Reading IS the value. Writing is a contribution we'd want everyone to do. Confuses incentives. |

**Chosen: Option B.**

## What free users get

- Their **own local learnings** (~/.contextengine/learnings.json) — unchanged, today's behavior
- The bundled **starter learnings** in `defaults/learnings.json` (~14 cold-start rules — already shipping)
- Full ability to **save** and **search** their own learnings
- No connection to the community library

## What PRO users get on top

- **Read access to the community library** (~10K+ vetted rules at maturity)
  - Auto-fetched at install time, refreshed every 24h via background polling
  - Cached locally so offline use works
  - Surfaces in `search_context` results alongside the user's own learnings, tagged with `source: community`
- **Opt-in publish** — they can contribute their own learnings back to the library
  - Anonymization pass strips project names, file paths, machine IDs before upload
  - Submitted via PR to a public Git repo of rules (Markdown)
  - Maintainer-curated; not auto-merged
  - Contributors are credited (optional) in a CONTRIBUTORS.md
- **Drift detection benefit** — community library rules become drift signals: *"User claimed X but rule [community/N123] says Y."*

## What Team users get on top of PRO

- **Team-private library** — synced via `policy.json` `extends:` URL
- Each team controls who can write (typically the team admin)
- Team library lives in a private Git repo (team's own GitHub/GitLab, our hosted option, or a tarball URL)
- Team library is OVERLAID on top of community library + user's local — three-layer merge
- Conflict resolution: team > community > local (team wins, with override comment)

## What Enterprise users get on top of Team

- **Org-wide library** spanning multiple teams
- Audit-chain export to the org's SIEM (Splunk/Datadog HEC)
- SSO/SAML controls on who can publish to the team library
- DPA + customer-managed encryption keys (BYOK)
- SOC 2 attestation report (Phase 4-5 deliverable, when the org needs it)

## The trust contract — what gets uploaded

When a PRO user opts in to publish a learning, the upload includes:
- ✅ Rule text (the user authored it; they want it shared)
- ✅ Category (`security`, `flutter-ui-fit`, `deployment`, etc.)
- ✅ Severity hint
- ✅ Anonymized author handle (e.g., `gh:username` if they linked GitHub; else `anon-<hash>`)
- ✅ Anonymized framework / stack tags (e.g., `flutter`, `react`, `nextjs` — derived from the user's typical edit patterns, not their code)

What is NEVER uploaded:
- ❌ Project names
- ❌ File paths from the user's machine
- ❌ Machine IDs / hostnames / IP addresses
- ❌ Code snippets that triggered the learning (only the rule itself, not the original code)
- ❌ Customer data, customer names, API keys, secrets (already scrubbed by existing regex set)
- ❌ Anything from sessions or audit log entries — only learning records

The anonymization runs **before** the HTTP POST leaves the user's machine. The client computes a SHA-256 of the canonical (pre-anonymization) record and stores it locally so the user can prove "yes I published this, here's what stayed local". This is the same chain-of-custody pattern as the audit log.

## Architecture sketch

```
                  ┌───────────────────────────────┐
                  │  Community Library            │
                  │  github.com/FASTPROD/         │
                  │  opscontext-community-rules   │  ← PRs from PRO users,
                  │  (public, MIT-licensed rules) │     maintainer-merged
                  └───────────────────────────────┘
                            │
                       fetched daily
                            ↓
┌────────────────────────────────────────────────────────────┐
│  PRO user machine                                          │
│                                                            │
│  ~/.contextengine/community-learnings.json  (cached)       │
│  ~/.contextengine/learnings.json            (own, today)   │
│  search_context merges both, dedupes, ranks by relevance   │
└────────────────────────────────────────────────────────────┘
                            │
              opt-in publish (anonymized)
                            ↓
                  ┌───────────────────────────────┐
                  │  api.compr.ch/                │
                  │  contextengine/publish-rule   │
                  │  (auth: Ed25519-signed POST)  │
                  └───────────────────────────────┘
                            │
                  human review + PR merge
                            ↓
                  Community Library grows.
```

## Pricing implications

| Tier | Local learnings | Community library (read) | Team library (read+write) | Org library | Pricing today | Pricing post-Phase-1.5 |
|---|---|---|---|---|---|---|
| Community (free) | ✅ | ❌ | ❌ | ❌ | CHF 0 | CHF 0 (unchanged) |
| Pro | ✅ | ✅ | ❌ | ❌ | CHF 2 / month | CHF 5-9 / month (rebalance to reflect new value) |
| Team | ✅ | ✅ | ✅ | ❌ | CHF 12 / month | CHF 25 / seat / month |
| Enterprise | ✅ | ✅ | ✅ | ✅ | CHF 36 / month | CHF 50+ / seat / month + SOC 2 + SSO |

Pricing should rebalance when Phase 1.5 ships — community library is the single most valuable thing the PRO tier offers. Justifies a price increase even at the entry level.

## Open questions for later

- **License of contributed rules** — MIT? CC-BY? CC-BY-SA? Default proposal: MIT for individual rules, BSL-1.1 for the library aggregation. Decide before the first community PR.
- **Quality control at scale** — at 1,000 rules in the library, maintainer-curated PR review works. At 100,000 it doesn't. Plan a community-voting + flagging system for the v2 of the library (Phase 4+).
- **Rule lifecycle** — when a rule becomes obsolete (e.g., Flutter changes default tap target from 48dp to 40dp), how does it get deprecated? Proposed: each rule has a `deprecated_at` field that the client respects; community PR mark them.
- **GDPR + DPA** — even with anonymization, the publish endpoint receives data from EU users. Need a Data Processing Agreement template before launch in EU. Out of scope for MVP; add before EU enterprise sales.

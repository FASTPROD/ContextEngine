# OpsContext Roadmap

> Last updated: 2026-06-26 (Session 17).
> See [docs/sessions/](sessions/) for the full historical trail of decisions and verdicts.

This roadmap is **deliberately conservative**. Each phase ships in production before the next starts. No phase exists to "future-proof" something — each one ships customer value or unblocks a sale.

---

## ✅ Shipped (as of 2026-06-22)

- **npm `@compr/opscontext-mcp@2.0.2`** — strategic pivot, hash-chained audit log, Ed25519 license signing, policy.json contract, pre-commit hook checkers, Claude integration (install-skill + sync-claude-md + auto-memory discovery), HTML score report title rebrand
- **VS Code Marketplace `css-llc.contextengine 0.8.2`** — OpsContext displayName, command palette + dashboard button for HTML Score Report (PRO), back-compat preserved
- **Activation server live on `api.compr.ch`** — Ed25519-signing in production, 4 licenses, 1 activation
- **Pricing page live** at `https://api.compr.ch/contextengine/pricing`
- **Marketing positioning** in [docs/marketing/pitch-proposals.md](marketing/pitch-proposals.md) — EN+FR × 4 surfaces

---

## 🛠️ Backlog — operational guardrails

### Release hygiene: canonical npm publish sequence (fires at next publish)

**Context (2026-06-26, Session 17):** discovered `package.json` was bumped locally to `2.1.2` at `f9e8f9c` (Session 14 batch) but `npm publish` was never run — npm registry remained at `2.1.1`, git tag remained at `v2.1.1`. The bump was in-tree limbo. Going to tag `v2.1.2` on GitHub would have created a ghost release pointing at a version users can't `npm install`. The bump-commit-tag-publish steps were split across operations and one of them (`npm publish`) was forgotten.

**Fix: use `npm version` as the atomicity anchor.** It edits `package.json`, creates the commit, AND creates the local tag in one atomic call — eliminating the "bumped but not published" drift class entirely.

**Canonical sequence — run when ready to ship the next version:**

```bash
# 1. Bump (atomic: edits package.json + creates commit + creates local tag)
npm version patch     # or minor, or major
# 2. Build + test
npm run build && npm test
# 3. Publish — IRREVERSIBLE after 24h. Verify CHANGELOG entry exists.
npm publish --access public
# 4. Push the commit + tag created in step 1
git push origin main --follow-tags
# 5. GitHub Release from the tag (auto-generates release notes from commits)
gh release create v$(node -p "require('./package.json').version") --generate-notes
```

**Pre-flight before step 3:**
- [ ] `CHANGELOG.md` has an entry for the new version (commit history shows the bump usually lands BEFORE the changelog — invert this on next release)
- [ ] `npm run build && npm test` green
- [ ] `git status --short` clean (no stray uncommitted work in the publish snapshot)
- [ ] `npm whoami` returns the right account (avoid publishing under a personal handle by accident)

**Reason this lives in the backlog and not in a runbook:** the failure mode here was "the next time we ship," not "every time we ship." It needs to fire once when the next bump happens, then it's internalized. A LOCK comment in `package.json` referencing this section would also work — TBD whether to add one.

**Why npm version > manual `vim package.json + commit + tag`:** the manual sequence allows each step to be forgotten independently (the exact root cause this fixes). `npm version` collapses the three steps into one atomic operation; the only remaining gap is `npm publish` itself, which the pre-flight checklist guards.

### Version alignment between npm package and VS Code extension (fires at extension v1.0)

**Context (2026-06-26, Session 17):** the user surfaced the question "should we align directly from extension 0.11.0 → npm 2.1.x?" The current state has two parallel version streams:

- `@compr/opscontext-mcp` on npm: registry `2.1.1`, local `2.1.2` (the bump-without-publish drift above)
- `css-llc.contextengine` on VS Code Marketplace: published `0.9.0`, local `0.11.0`

Aligning the extension directly to the npm semver (`0.11.0 → 2.1.2`) was REJECTED. Three reasons:

1. **Broken semver signal.** `0.x.x` honestly says "still iterating, breaking changes possible." `2.x.x` promises "stable contract." The extension just added drift alerts in 0.11.0 (Session 13 commit `1eef67a`); 4 versions in 3 days — not stable enough for a 2.x signal.
2. **Marketplace UX cliff.** Skipping `0.9 → 2.1` makes users see "what happened to 1.0?" — looks like a fork, accidental skip, or quality issue.
3. **Two distinct distribution channels.** `css-llc.contextengine` (Marketplace, legacy publisher ID) and `@compr/opscontext-mcp` (npm, current name) have different audiences, different release cadences. Forcing patch-level alignment couples them artificially.

**The real goal is COORDINATED RELEASES, not synchronized numbers.** Plan:

1. **Bump extension to `1.0.0` first** — at the next moment when "I've finished iterating UI fundamentals, this is the stable contract" is honestly true. That moment is the trigger.
2. **From v1.0 onward, align MAJOR-version-only** — extension `1.x.x` ≈ npm `2.x.x`. When npm goes to `3.0`, extension goes to `2.0`. Patch + minor stay independent (UI iterates faster than the policy engine and that's healthy).
3. **Coordinate releases via a shared CHANGELOG section** for cross-cutting shippings. Format:
   ```
   ## Release 2026-06-26
   ### npm 2.1.x — [what changed in the package]
   ### vscode 0.11.x — [what changed in the extension]
   ```
4. **Optional: `vscode-ext-vX.Y.Z` git tags** alongside `vX.Y.Z` for the npm package. Two tag streams, but easier to navigate releases per layer.

**Why this lives in the backlog:** the trigger is "when extension reaches v1.0 maturity", not a scheduled date. Same shape as the publish-hygiene entry above — fires when a future condition is true, then is internalized.

**Related learnings:** [[feedback-multi-agent-for-shared-infra]] (don't sync things that don't need syncing), [[feedback-nerd-talk-avoidance]] (semver IS a marketing signal, not just engineering metadata).

### Fan-out cancellable+AbortController pattern to 5 remaining withProgress callsites (fires at 0.11.3, ~30 min mechanical)

**Context (2026-06-27, Session 18):** 0.11.2 fixed the `scoreHtml` hang by hardening `runCLI` (SIGKILL on timeout + `AbortSignal` propagation) AND wiring `cancellable: true` + `AbortController` on the `scoreHtml` `withProgress` callsite. The `runCLI` hardening benefits ALL 6 callsites implicitly (their timeouts now actually kill), but the UI-cancel button is only present on `scoreHtml`. The other 5 still show `cancellable: false` and have no way for the user to dismiss a stuck progress notification short of `Developer: Reload Window`.

**The 5 callsites to fix** (all in [vscode-extension/src/extension.ts](../../vscode-extension/src/extension.ts), line numbers verified at HEAD post-0.11.2 = commit `67dc77e`):

| Line | Command | Client call | Why it can hang |
|---|---|---|---|
| 291 | `contextengine.commitAll` | `client.gitCommitAll()` | git ops can stall on network-backed filesystems or large repos; loop over many dirty projects multiplies the risk |
| 395 | `contextengine.endSession` | `client.endSession()` | external gates (license validation, compliance checks, activation heartbeat to `api.compr.ch`) |
| 493 | `contextengine.sync` | `client.checkCEDocFreshness()` | filesystem stat calls across many projects; NFS / stale mount can hang for minutes |
| 592 | `contextengine.search` | `client.search()` | hybrid BM25+semantic search; embeddings inference is CPU-bound + non-cancellable without explicit signal |
| 872 | `pushAllProjects()` (helper called from `commitAll`) | `client.gitPush()` | git push over flaky network or slow remote hooks; no abort signal wired |

**The canonical pattern** (already proven on `scoreHtml` at line 681 — copy this shape):

```typescript
await vscode.window.withProgress(
  { location: vscode.ProgressLocation.Notification, title: "...", cancellable: true },
  async (_progress, token) => {
    const abortController = new AbortController();
    token.onCancellationRequested(() => abortController.abort());
    try {
      const result = await client.<theCall>(args, abortController.signal);
      // success path...
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (e.name === "AbortError" || token.isCancellationRequested) return; // silent exit
      // genuine-failure path...
    }
  }
);
```

Each client function (`gitCommitAll`, `endSession`, `checkCEDocFreshness`, `search`, `gitPush`) needs an optional `signal?: AbortSignal` parameter added to its signature, then passed through to `runCLI({ signal })`. `runCLI` already accepts the signal as of 0.11.2 ([vscode-extension/src/contextEngineClient.ts:119-153](../../vscode-extension/src/contextEngineClient.ts#L119)) — no changes needed there.

**Pre-flight before landing:**
- [ ] All 5 callsites set `cancellable: true` + wire `AbortController` to the cancellation token
- [ ] Each of the 5 client functions accepts + propagates `AbortSignal`
- [ ] Each callsite catches `AbortError` and exits silently (no error popup for user-cancel)
- [ ] Manual test: trigger each command, click the X mid-flight, verify the subprocess dies within 1-2s (use `ps aux | grep opscontext` to confirm no orphan)
- [ ] Bump to 0.11.3 + CHANGELOG entry: "Fan-out cancellable+AbortController to commitAll, endSession, sync, search, pushAllProjects (paired with 0.11.2's scoreHtml fix)"
- [ ] Publish + sideload + reload + verify on at least one of the 5 (e.g. trigger `OpsContext: Search Knowledge Base` with a query that returns many results, click X mid-flight)

**Reason this lives in the backlog and not in 0.11.2:** the canonical pattern needed proof-of-life on ONE callsite first (`scoreHtml`). Now that it's shipped + verified, fanning out is mechanical copy-paste — but it's also 5 separate callsite edits with 5 separate client-function signature changes, which is bigger surface than the 0.11.2 hotfix wanted. The trigger to land this is either (a) the next user report of a stuck non-scoreHtml progress, OR (b) the next time the repo is open with appetite for a tight ~30 min cleanup pass — whichever comes first.

**Related learnings:** [[feedback-multi-agent-for-shared-infra]] (the runCLI hardening already crosses the shared-infra threshold, but UI-level callsite changes are local), [[feedback-test-fixture-hides-bug]] (manual cancel-test required because automated tests mock `execFile` and won't catch real SIGTERM/SIGKILL behavior).

---

## 🚀 Phase 1 — Cross-surface capture + drift alerts  (now → ~4 weeks)

The wedge nobody else has. Catches the "stop the chat now" moments.

### Phase 1a — Chrome extension (capture only)
- New package `@compr/opscontext-chrome` (MV3, BSL-1.1)
- Captures `browser.prompt` / `browser.response` / `browser.tool_call` from claude.ai + chatgpt.com
- Streams via `POST http://127.0.0.1:7842/events` into the existing audit log
- Secret-based auth via `opscontext init-extension-secret`
- Selector library seeded from MIT-licensed prior art (Couchraver/claude-chatgpt-gemini-downloader 14⭐ + xvfeiran/ChatExporter, both MIT — attribute in `LICENSE_THIRD_PARTY.md`)
- **Estimate: 2 weeks**

### Phase 1b — VS Code event emitters
- Extension `0.8.3` adds emitters for `vscode.prompt_submit` + `vscode.tool_call`
- Writes to the same audit log via the existing CLI delegate
- **Estimate: 2 days**

### Phase 1c — Heuristic drift detector
- New module `src/detector.ts` (ships in `opscontext-mcp@2.1.0`)
- 8 deterministic heuristics (loop, stuck, context_bloat, fabrication_suspect, drift, no_insight, stale_doc_signal, silent_failure)
- Zero LLM calls. Pure rules. Cheap, fast, deterministic.
- CLI: `opscontext watch`
- MCP tool: `drift_status`
- Status-bar binding in VS Code extension turns yellow / orange / red+pulse
- Critical signals trigger OS notification: *"Stop the chat now — drift detected: <reason>"*
- **Estimate: 1 week**

### Phase 1d — CodeQL + Dependabot enabled (DONE 2026-06-22)
- ✅ `.github/dependabot.yml` — weekly npm + GitHub Actions updates, grouped minor/patch
- ✅ `.github/workflows/codeql.yml` — security-and-quality query suite on every push/PR + weekly cron
- **Why now**: free SOC 2 CC7.1 evidence accruing from day one, costs 0 dollars + 2 hours
- **Estimate: 0 (shipped)**

---

## 🔁 Phase 1.5 — Shared community learnings store  (~3 weeks, slots between 1 and 2)

The data network effect. Each user's miss makes every future user smarter. **The biggest unbuilt moat.**

- Free tier: **local learnings only** (today's behavior — never leaves the machine)
- **PRO tier**: read access to the **community library** (~10K vetted rules) auto-fetched at install and refreshed every 24h
- **Team tier**: read + write to a team-private library synced via `policy.json` `extends:` URL
- **Enterprise tier**: org-wide library + audit + SSO + (eventually) SOC 2
- Opt-in publish endpoint on `api.compr.ch` (reuses the existing Ed25519 activation infrastructure)
- Anonymization pass strips project names, file paths, machine IDs BEFORE upload
- Pre-seeded with ~1,000 redacted learnings from the maintainer's own store as cold-start corpus
- Community contributors submit via PR to a public Git repo of rules (Markdown, reviewable)
- See [docs/architecture/shared-learnings-tiering.md](architecture/shared-learnings-tiering.md) for the full design

**Estimate: 3 weeks**

---

## 🧪 Phase 2 — Policy-driven LLM-judge layer  (~1-2 weeks, slots after 1.5)

Closes the recall gap heuristics can't (drift via semantic understanding, spatial fit, a11y, novel concurrency bugs).

- Extend `policy.json` with a `judges:` array
- Each judge: `id`, `trigger` (event match), `prompt`, `model` (default: cheapest available), `severity`
- LLM execution layer in `opscontext-mcp` calls the judge prompt against matched events
- Default backend: Groq (Llama 3.1 8B, ~$0.0005/call) for cloud; Ollama Qwen 2.5 7B for local
- Opt-in per project. NOT on critical path; runs async after the heuristic pass.
- Status: **near-must for v2, NOT a must for v1.** Add when heuristics demonstrably miss a class users care about.

**Estimate: 1-2 weeks (when triggered by user demand, NOT before)**

---

## 🏢 Phase 3 — Enterprise gates (multi-tenant + SSO)  (~6 weeks, triggered by LOI)

**Do NOT build before a signed LOI says "we'd buy at $X if you had SSO".**

- Multi-tenant control plane on `api.compr.ch` (orgs / users / memberships / roles)
- OIDC via WorkOS (~$125/connection/month — cuts engineering 6 weeks → 2 weeks)
- License model migration: machine-fingerprint → identity-bound (or hybrid)
- Admin console for IdP config
- **NO SOC 2 spend until the LOI is signed.** SOC 2 Type I = $30K + 6 months calendar, won't move on demand.

**Estimate: 6 weeks engineering when triggered**

---

## 📋 Phase 4 — SOC 2 Type I  (~6 weeks evidence + 1 week audit, triggered by deal pipeline)

**Triggered when**: a deal worth ≥$30K ARR explicitly requires it.

- Type I = point-in-time. Unlocks deals up to ~$30K ARR.
- Auditor: $25K-$40K (A-LIGN, Sensiba, Prescient, or similar boutique)
- Vanta or Drata for evidence automation: $7K-$15K/year
- Pen test: $8K-$15K (required by most auditors)
- **Total Year 1: $45K-$80K cash + ~6-8 founder-weeks**
- **Foundations already accruing** (free, since 2026-06-22):
  - CC7.2 ✅ — hash-chained audit log
  - CC8.1 ✅ — policy.json + git hooks
  - CC7.1 🟡 — CodeQL + Dependabot live (clock started)
  - CC9 🟡 — vendor SOC 2 reports collected as Vercel/Cloudflare/Anthropic/OpenAI are used
  - CC6.x ❌ — needs MFA + access control once Phase 3 lands

---

## 🏭 Phase 5 — SOC 2 Type II + SAML + SIEM + DPA + CMK  (~5 months, deferred)

- Type II = period-of-operation. Unlocks deals above $100K ARR.
- $30K-$50K audit cost + Vanta continuing
- SAML 2.0 (Okta legacy, Azure AD, Ping) — required by Fortune 1000
- SCIM 2.0 provisioning (auto user lifecycle)
- SIEM export to Splunk / Datadog HEC
- DPA template (Data Processing Agreement)
- Customer-managed keys (BYOK) via AWS KMS
- **Trigger**: revenue at $300K+ ARR or signed enterprise contract requiring Type II

---

## 🗓️ Cumulative timing through Phase 4

| Cumulative spend | Cumulative founder-weeks | Unlocks deals up to |
|---|---|---|
| ~$0 (today) | 0 | individual + small-team |
| ~$5K (Phase 3) | 6 weeks | mid-market |
| ~$45K-$80K (Phase 4) | 14 weeks | $30K ARR |
| ~$75K-$135K (Phase 5 starts) | 22 weeks | $100K+ ARR |

**Pragmatic rule**: nothing in Phases 3-5 starts without an LOI in hand. The foundations Phase 1 + 1d puts in place are the ones that pay back instantly when an LOI arrives — auditor saves 3-6 months because evidence already exists.

---

## Anti-roadmap (things we deliberately AREN'T building)

| What | Why not |
|---|---|
| Multi-LLM orchestration (Mixture of Agents) | Crowded market (LangChain, CrewAI, LangGraph, autogen). No defensible advantage over funded players. |
| Hosted SaaS dashboard | Conflicts with local-first positioning. Reconsider only if 10+ paying customers ask for it. |
| Mobile app | Out of scope. AI agents don't live on phones today. |
| Spatial-fit / a11y / framework-specific UI auditing | Wrong abstraction. Ship the LLM-judge layer (Phase 2) so users author their own framework-specific judges. |
| Custom vector database | Use existing local FAISS / Qdrant embedded. Building one is a 6-month distraction. |
| "Cheaper than Helicone" marketing | Race we can't win. Compete on the four moats, not price. |
| Auto-pause the chat | Phase 3+ — needs IDE/agent APIs that don't exist today. Alert is the right scope for now. |

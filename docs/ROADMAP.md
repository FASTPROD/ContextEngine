# OpsContext Roadmap

> Last updated: 2026-06-22 (Session 09).
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

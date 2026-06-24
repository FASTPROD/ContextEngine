# About OpsContext — Publisher Disclosure

**Last updated**: 2026-06-24

This page exists because security and audit-log products targeting regulated industries need clear publisher attribution. The OpsContext audit log (`~/.contextengine/audit.log`) is meant to produce *evidence* — and evidence is only as trustworthy as the entity behind it.

If your compliance team is evaluating whether to allow OpsContext on the engineering laptop fleet, this page is the answer to "who are these people?"

---

## Legal entity

**OpsContext is built by PROD LLC** — an operating brand of **CSS LLC**.

| Layer | Name | What it is |
|---|---|---|
| Legal entity (parent) | **CSS LLC** = **Cross Stream Solutions Sàrl** | Swiss company, operating since **2005**. The "LLC" suffix is the English label for the Swiss Sàrl legal form (the equivalent of an LLC in Anglophone jurisdictions). Registered with the Swiss commercial registry; UID available on request. |
| Operating brand | **PROD LLC** | The brand under which the OpsContext development team operates. Carries the engineering, marketing, and product responsibilities. |
| Product imprint | **OpsContext** | The product itself. Formerly `ContextEngine` (rebranded 2026-06-11). Distributed as `@compr/opscontext-mcp` on npm + `css-llc.contextengine` on VS Code Marketplace + a Chrome Web Store submission in flight. |

The VS Code Marketplace publisher ID is **`css-llc`** — that is the *legal parent* name (Cross Stream Solutions Sàrl), not a typo or a legacy ID. Marketplace publisher names must map to a registered legal entity; CSS LLC = Cross Stream Solutions Sàrl is ours. The npm scope is **`@compr`** — referencing the `compr.fr` portfolio domain that CSS LLC owns. Both `css-llc` and `@compr` resolve to the same single legal entity.

## Sibling brands under PROD LLC

PROD LLC also operates these product brands. They are *not* OpsContext, but they live in the same engineering org and share infrastructure (the dev team, the OVH/Gandi VPS fleet, the Postgres backups, the SSO):

| Brand | Domain | Description |
|---|---|---|
| **FASTPROD** | [fast-prod.com](https://fast-prod.com) | DevOps + sysadmin operator. This is the team that builds + ships OpsContext. |
| **CROWLR** | [crowlr.io](https://crowlr.io), [admin.crowlr.com](https://admin.crowlr.com) | Crawling + monitoring platform (lead-gen and competitive-intelligence audiences). |
| **KONIVE** | [konive.com](https://konive.com) | (product) |
| **INVOC** | [invoc.io](https://invoc.io), [invoc.me](https://invoc.me) | (product) |
| **PLANK** | [plank.io](https://plank.io) | (product, Expo/React Native) |
| **compR** | [compr.fr](https://compr.fr), [compr.app](https://compr.app) | The portfolio + the consumer benchmark PWA. |

If your purchase team asks "is OpsContext part of a public-cloud platform play?" — the honest answer is **no**: OpsContext is local-first by design, and the sibling brands are independent products that happen to share an engineering team. There is no shared user database between OpsContext and any sibling brand. OpsContext does not call out to `compr.fr`, `crowlr.io`, or any other sibling site at runtime.

## What OpsContext is and is not

- ✅ Built and maintained by a single team (PROD LLC under CSS LLC)
- ✅ Local-first: no telemetry, no cloud account, no signup; license activation is the only outbound call
- ✅ Source-available under [BSL-1.1](https://github.com/FASTPROD/ContextEngine/blob/main/LICENSE) — NOT OSI-approved open source. You may use it in production; you may not offer it as a hosted service competing with the OpsContext PRO/Team/Enterprise plans. Converts to AGPL-3.0 on 2030-02-22.
- ❌ **NOT** SOC 2– or ISO 27001–certified itself. The audit log helps *your* org's auditor satisfy [SOC 2 CC7.2](compliance/cc7.2.md) and [ISO 27001 A.12.4.1](compliance/a.12.4.1.md), but OpsContext-the-tool carries no attestation. (See those docs for the exact evidence-vs-certification distinction.)
- ❌ **NOT** part of any larger public cloud, AI training pipeline, or data brokerage. The sibling brands listed above are independent products; none of them ingest your OpsContext audit log.

## Contact

| Purpose | Channel |
|---|---|
| Engineering / bug reports | [github.com/FASTPROD/ContextEngine/issues](https://github.com/FASTPROD/ContextEngine/issues) |
| Commercial licensing / enterprise | [yannick@compr.ch](mailto:yannick@compr.ch) |
| Security / responsible disclosure | [yannick@compr.ch](mailto:yannick@compr.ch) — please use subject line `[OpsContext security]` |
| General | [compr.fr](https://compr.fr) |

All three addresses currently route to the same inbox.

## Data flow and sub-processors

**The OpsContext binary makes exactly two kinds of outbound HTTP calls. That's it.** Verified by grep across `src/`, `chrome-extension/src/`, and `vscode-extension/src/` (audit `wgjc4m1bo`, 2026-06-24):

| # | Destination | What's sent | What's NOT sent |
|---|---|---|---|
| 1 | `http://127.0.0.1:7842` (your local machine) | Captured prompts + responses + tool calls from the browser ext / Claude Code hook / VS Code ext, written to your local audit log | Anything beyond your machine. Manifest `host_permissions` constrain this URL to loopback — Chrome will reject any attempt to redirect it. |
| 2 | `https://api.compr.ch/contextengine/{activate,heartbeat}` (PROD LLC's Gandi VPS, `92.243.24.157`) | License key (a 16-character `CE-XXXX-XXXX-XXXX-XXXX` token) + machine ID hash. Used to validate the PRO subscription and renew the local entitlement. | Audit-log contents. Prompt text. Response text. Tool calls. Project paths. File contents. Anything that resembles user work. The endpoint payload is a license check, nothing else. |

**Sub-processors for user data:** **NONE.** OpsContext does not transmit user prompts, responses, audit-log contents, project metadata, or file contents to any third party. The audit log lives on your machine and is never uploaded.

**Sub-processors for the license-activation server:**

| Service | Vendor | What for |
|---|---|---|
| `api.compr.ch` hosting | **Gandi SAS** (French registrar/hosting; GDPR-bound, EU-hosted) | Receives license-key validation requests; stores the license-key ↔ entitlement record |
| TLS certificate | Let's Encrypt | Standard CA |

We do **not** use: AWS, Cloudflare Workers, Vercel, Azure, GCP, or any other cloud-platform service for license activation. We do **not** use: Sentry, Bugsnag, Rollbar, Datadog, New Relic, or any other error-reporting / APM service. We do **not** use: Mixpanel, Amplitude, PostHog, Segment, Rudderstack, Heap, FullStory, Plausible, Umami, Fathom, or any other analytics / telemetry service. **Grep verifies — zero matches across all three `package.json` files.**

**For a formal DPA template** (the legal contract our processing of your license-validation traffic), email `yannick@compr.ch` — we'll send a standard EU-form DPA pre-signed by Cross Stream Solutions Sàrl.

## Marketing-data isolation (LOCKED commitment)

> **Customers who use OpsContext or hold an OpsContext license are NOT, and will NOT be, associated with any marketing activity, audience, or list operated by CSS LLC, PROD LLC, or any sibling brand (CROWLR, KONIVE, INVOC, FASTPROD, compR).**

This is a load-bearing commitment, not a privacy-page nicety. Specifically:

- The license-activation server stores only `{license-key, entitlement-tier, last-heartbeat-ts, machine-id-hash}`. It does **not** store email addresses except as required for license delivery — and email addresses are kept in a separate Stripe customer record, never joined to OpsContext usage data.
- The OpsContext customer list is **never** merged with CROWLR's prospect database, KONIVE's user list, INVOC's customer base, or compR's portfolio-visitor analytics.
- We do not enrich OpsContext customer records via Clearbit, ZoomInfo, Apollo, LinkedIn Sales Navigator, or any data broker.
- We do not retarget OpsContext customers in Facebook / LinkedIn / Google Ads.
- We do not include OpsContext customer email addresses in any marketing newsletter without explicit opt-in to that specific newsletter.

If you'd ever like a written confirmation that your organization is not in any marketing list operated by PROD LLC, email `yannick@compr.ch` — we'll send a one-line attestation.

This commitment is preserved against drift by a check in our pre-commit hook policy: any new outbound destination added to `src/`, any new analytics SDK added to any `package.json`, or any new field added to the activation payload requires deliberate justification + a corresponding update to this section of `about.md`.

## CROWLR carve-out

> **CROWLR (the sibling web-crawling platform under PROD LLC) does not touch OpsContext audit logs, license-activation traffic, or any OpsContext customer record. Verified by grep — zero runtime code-coupling between the two products.**

Specifically:

- CROWLR's crawlers fetch URLs **only** explicitly requested by CROWLR's own paying customers — they do not perform arbitrary discovery, do not crawl `127.0.0.1`, cannot reach the audit log living on a customer's local machine, and do not crawl `api.compr.ch/contextengine/*`.
- CROWLR and OpsContext share **no database**. CROWLR's customer list, target URLs, and crawl results never overlap with OpsContext's license-activation database.
- CROWLR has **no privileged access** to OpsContext systems. If OpsContext were ever to expose a server-side audit-log API in the future (it does not today), CROWLR would authenticate against it the same way any other internet client would — no special path.

A grep of the OpsContext source tree (`src/`, `chrome-extension/src/`, `vscode-extension/src/`) for "crowlr" returns three classes of mention, all benign:

1. Path strings to the developer's local session-doc filesystem (`/Users/yan/FASTPROD/docs/CROWLR_COMPR_APPS_SESSION.md`) — never executed at customer runtime.
2. **Isolation comments** in `src/learnings.ts:324` + `:739` documenting that learnings are project-scoped to *prevent* cross-project IP leakage — a deliberate isolation, not coupling.
3. Example strings in MCP tool descriptions ("e.g. `admin-crowlr-upgrade`") — documentation only.

No runtime data flow exists between OpsContext and any sibling brand.

## Remaining open questions

A handful of items remain pending real-enterprise-procurement feedback rather than verifier inference:

- **Sub-processor list of record** — we maintain the list above. If we add a vendor, we'll update this section AND email known PRO customers within 30 days.
- **Formal infra-isolation diagram** — the shared OVH/Gandi VPS fleet runs each brand in its own systemd unit + its own database; a one-page diagram capturing the SSO scoping is a carry-forward.
- **SOC 2 / ISO 27001 certification** — we are NOT certified. The audit log produces *evidence* for those controls (see [compliance/cc7.2.md](compliance/cc7.2.md) + [compliance/a.12.4.1.md](compliance/a.12.4.1.md)). If you need OpsContext to BE certified before deploying, we can discuss timing; a Phase 4 certification track is on the roadmap, not yet started.

For anything else blocking a procurement decision, email `yannick@compr.ch`.

## Historical note (why the names)

- **2005 → present** — Cross Stream Solutions Sàrl ("CSS LLC") has been the continuously-operating Swiss legal entity. PROD LLC is the product/engineering brand under it; FASTPROD, CROWLR, KONIVE, INVOC, and compR are product imprints, each launched on its own timeline as the team's focus evolved across roughly two decades.
- **2026-02** — `@compr/contextengine-mcp` 1.x line on npm. First public release of the persistent-memory + search product.
- **2026-06-11** — Rebrand to **OpsContext** to reflect the broader ops + compliance positioning. `@compr/contextengine-mcp` → `@compr/opscontext-mcp`; VS Code Marketplace publisher kept as `css-llc` (legal parent, doesn't change with product rename).
- **2026-06** onward — Cross-surface capture (browser ext + Claude Code hook + VS Code ext) closes the "agent saw / did what?" gap.

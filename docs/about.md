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

## Open questions a careful buyer will ask

This page is v1 of the publisher disclosure. Adversarial review by our own audit pass surfaced the questions below — questions a Swiss-domiciled compliance team would ask. **We're listing them as open rather than pretending they're closed.** They'll be answered iteratively as we collect feedback from real enterprise procurement processes; if you're an enterprise buyer who needs an answer to one of these before deciding, email `yannick@compr.ch` and we'll respond directly.

- **"CSS LLC" is not a recognized Swiss legal form (those are Sàrl, GmbH, AG). What is the Swiss commercial-registry UID (CHE-xxx.xxx.xxx) on Zefix?** — Will be added to this page in the next publisher-disclosure pass.
- **Sub-processor list / DPA / infra-isolation diagram?** — Not yet published. The audit-log product is local-first by design (zero remote storage; license activation is the only outbound call from your machine), so the sub-processor exposure is intentionally narrow — but a buyer wants this in writing.
- **Does CROWLR (the sibling crawling platform) interact in any way with the OpsContext audit log, license-activation traffic, or OpsContext customer data?** — A formal carve-out statement + isolation diagram will land in the next pass. The strong design constraint is that the audit log lives on the customer's machine and is never uploaded; CROWLR's web crawlers operate against public internet content and cannot reach `127.0.0.1`, but a formal sub-processor statement is the right artifact and we don't have one yet.
- **Shared dev team / shared VPS fleet / shared SSO across brands = shared blast radius. What's the isolation story?** — A formal isolation diagram is carry-forward.
- **Team size and runway?** — Not currently published. Happy to share under NDA to enterprise buyers.

If any of the above blocks a procurement decision you're trying to make, contacting `yannick@compr.ch` will get you a direct answer faster than waiting for the next pass.

## Historical note (why the names)

- **2005 → present** — Cross Stream Solutions Sàrl ("CSS LLC") has been the continuously-operating Swiss legal entity. PROD LLC is the product/engineering brand under it; FASTPROD, CROWLR, KONIVE, INVOC, and compR are product imprints, each launched on its own timeline as the team's focus evolved across roughly two decades.
- **2026-02** — `@compr/contextengine-mcp` 1.x line on npm. First public release of the persistent-memory + search product.
- **2026-06-11** — Rebrand to **OpsContext** to reflect the broader ops + compliance positioning. `@compr/contextengine-mcp` → `@compr/opscontext-mcp`; VS Code Marketplace publisher kept as `css-llc` (legal parent, doesn't change with product rename).
- **2026-06** onward — Cross-surface capture (browser ext + Claude Code hook + VS Code ext) closes the "agent saw / did what?" gap.

# ISO 27001 Annex A.12.4.1 — Plain English

**Last updated**: 2026-06-23

> **OpsContext is not ISO 27001 certified.** This document explains how the OpsContext audit log helps *your* organization satisfy *its own* ISO 27001 examination of control A.12.4.1 — not the other way around.

## What A.12.4.1 actually requires

Annex A.12.4.1 of ISO/IEC 27001:2013 (control "Event Logging"):

> *"Event logs recording user activities, exceptions, faults and information security events shall be produced, kept and regularly reviewed."*

The 2022 revision restates this as A.8.15. The text intent is unchanged.

Four concrete requirements an ISO auditor will probe:

1. **Production** — Are logs actually being written? Not "could be." Are they.
2. **Retention** — Are they kept long enough to be useful? (Your ISMS defines "long enough.")
3. **Review** — Is someone looking at them? When?
4. **Integrity** — Can a malicious insider or external attacker rewrite history without detection?

A.12.4.1 also implicitly requires *coverage*: logs must record user activities, exceptions, faults, and security events — not just one category.

## How the OpsContext audit log helps

OpsContext writes one append-only JSONL file at `~/.contextengine/audit.log`. Each line is a self-contained record with `prev_hash` + `hash` linking it to the prior record. Coverage:

| A.12.4.1 category | OpsContext event kinds |
|---|---|
| **User activities** | `vscode.prompt_submit`, `vscode.tool_call`, `browser.prompt`, `browser.response`, `cli.command` |
| **Exceptions** | `drift.hallucination`, `drift.stuck_tool`, `drift.silent_failure`, `drift.prompt_loop` |
| **Faults** | `hook.block`, `policy.violation`, `service.error`, `queue.overflow` |
| **Security events** | `auth.bad_secret`, `policy.secret_detected`, `bypass_token.used`, `bypass_token.forged` |

In A.12.4.1 terms:

| Auditor requirement | What OpsContext provides |
|---|---|
| **Production** | Events are written synchronously to JSONL at every state change. Verify with `tail -f ~/.contextengine/audit.log` while running any of the above. |
| **Retention** | OpsContext writes a single append-only file; the deploying organization controls retention. Default is forever (no rotation). Configure your backup policy accordingly. |
| **Review** | `opscontext audit_search` for ad-hoc queries; `opscontext audit_verify` for chain integrity; the VS Code extension surfaces drift events in real time. The *cadence* of review is your control to document. |
| **Integrity** | `prev_hash` + `hash` chain ties each record to its predecessor. `opscontext audit_verify` re-walks the chain end-to-end and reports the first divergence. |

## What this is NOT

- **Not an ISO 27001 certification.** OpsContext-the-tool has no ISO 27001 statement of applicability. We do not claim to be an ISO 27001 service organization. The hash chain is an artifact, not an attestation.
- **Not a complete event-logging program.** A.12.4.1 expects coverage of *all* user activities and faults across the entity, not just AI tooling. OpsContext supplements your existing logging stack with AI-tool events your SIEM/syslog isn't seeing; it does not replace them.
- **Not a guarantee of "regular review."** Production + integrity are technical properties OpsContext provides; *review cadence* is a process control. Document yours.

## How to cite this in your own ISO 27001 evidence

When your auditor asks for A.12.4.1 evidence on AI-tool activity:

1. Run `opscontext audit_verify --since <examination-period-start>` and capture the chain-valid output.
2. Show a sample period's events covering all four categories (user activity, exception, fault, security event) using `opscontext audit_search`.
3. Attach this document as the technical explainer.
4. Reference your ISMS document that defines retention and review cadence for AI-tool logs.

## Open questions an auditor will ask

- *"What is your retention period?"* — OpsContext does not enforce one. Your ISMS document specifies; back it up to immutable storage if your retention exceeds typical local-disk reliability.
- *"How frequent is regular review?"* — A.12.4.1 does not prescribe; your ISMS does. The OpsContext VS Code extension provides a continuous-review surface (status bar + popup) for engineers; periodic batch review (e.g. monthly drift-event summary) is your control to document.
- *"What if the chain breaks because a backup restore replaced the file?"* — Document your restore procedure: capture the post-restore `hash` and treat it as a new chain anchor. The auditor expects a documented break, not a hidden one.
- *"What about log access controls?"* — OpsContext relies on filesystem permissions. Your control is to restrict read+write on `~/.contextengine/` to the OpsContext service account and the SOC team. Document that ACL.

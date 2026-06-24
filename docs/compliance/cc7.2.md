# SOC 2 CC7.2 — Plain English

**Last updated**: 2026-06-23

> **OpsContext is not SOC 2 certified.** This document explains how the OpsContext audit log helps *your* organization satisfy *its own* SOC 2 examination of control CC7.2 — not the other way around.

## What CC7.2 actually requires

SOC 2 Common Criterion 7.2 is one sentence in the AICPA trust-services criteria:

> *"The entity monitors system components and the operation of those components for anomalies indicative of malicious acts, natural disasters, and errors affecting the entity's ability to meet its objectives."*

In an auditor's worksheet that becomes three concrete questions about your AI tooling:

1. **Detection** — When something abnormal happens (a model hallucinates a fix, a tool call hangs, a deploy script runs without approval), do you find out?
2. **Evidence** — When the auditor asks "show me a sample of detections from Q3," can you produce a tamper-evident record?
3. **Response** — When a detection fires, is there a documented action?

CC7.2 is *not* prescriptive about *how* you detect. A SIEM works; a hash-chained JSONL works; a journal-shipped Postgres table works. The auditor wants to see that detection happens, that the evidence is trustworthy, and that there is a response loop.

## How the OpsContext audit log helps

OpsContext writes every state-changing event (browser capture, Claude Code tool calls, learning save/delete, session save/delete, hook decisions, drift heuristic firings) to `~/.contextengine/audit.log` as JSONL. Each entry carries `prev_hash` + `hash` over the previous record + the current payload, so any modification to a past entry invalidates the chain from that point forward. `opscontext audit_verify` walks the chain and reports the first divergence.

In CC7.2 terms:

| Auditor question | What OpsContext provides |
|---|---|
| "Show evidence of anomaly detection." | The audit log records drift / hallucination / silent-failure heuristic firings as event kinds. Run `opscontext audit_search --kind drift.* --since 2026-04-01`. |
| "How do you know the evidence wasn't edited?" | `opscontext audit_verify` re-computes every `hash` field and reports the first mismatch. The chain anchors to the earliest record; a forged entry near the end is detectable. |
| "What is your response process?" | This is on you — OpsContext records the detection; your runbook defines the action. Link your runbook here and reference the relevant log kinds. |

## What this is NOT

- **Not a certification.** OpsContext-the-tool has no SOC 2 report. We do not claim to be a SOC 2 service organization. The hash-chained log is an artifact, not an attestation.
- **Not a complete SOC 2 program.** CC7.2 is one criterion of many. Your SOC 2 examination needs Type I / Type II reports across all relevant criteria; OpsContext addresses the *audit-evidence* sub-question for AI-tool activity, not your overall control environment.
- **Not a substitute for a SIEM.** If you're operating regulated infrastructure (PCI, HIPAA, FedRAMP), OpsContext supplements your existing SIEM with AI-tool telemetry it doesn't otherwise see; it does not replace the SIEM.

## How to cite this in your own SOC 2 evidence

When your auditor asks for CC7.2 evidence on AI-tool activity:

1. Run `opscontext audit_verify --since <examination-period-start>` and capture the output (chain valid Y/N + first divergence if any).
2. Run `opscontext audit_search --kind drift.* --since <date>` and capture a sample of anomaly detections.
3. Attach this document as the technical explainer of what the chain proves.
4. Document the OpsContext-version, log-path, and verification-command in your control narrative so a successor auditor can reproduce.

## Open questions an auditor will ask (and the honest answer)

- *"Who has write access to the log file?"* — Anyone with shell access to the machine. OpsContext does not enforce file ACLs; that is the deploying organization's responsibility (typically `chmod 600`, owned by the OpsContext service account).
- *"What stops an attacker from re-computing the chain after modifying entries?"* — Nothing intrinsic. Hash-chaining detects tampering; it does not prevent it. To strengthen this, periodically anchor the latest `hash` to an external system (S3 Object Lock with a daily PUT, a transparency log, etc.). OpsContext does not ship this anchor — it is your control to add.
- *"How do you handle log rotation?"* — OpsContext does not rotate by default. For long-lived examinations, keep the log as a single append-only file; if it grows beyond practical limits, segment by year and chain each segment's first record to the prior segment's last `hash`.

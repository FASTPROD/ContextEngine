# Ed25519 flag day — retiring legacy SHA-256 signature acceptance

**Status as of 2026-06-11**: NOT YET DONE. This document is the scheduled-action runbook. Calendar this; the actual work is a single small commit on or after the flag-day date.

## Context

The 2026-06-11 production deploy enabled Ed25519 signing for every new activation. Pre-Ed25519 licenses on existing customers' machines carry a 64-character hex SHA-256 "signature" (it was never a real signature — just a checksum). The client's `verifyLicenseSignature()` recognizes that 64-char-hex shape and returns `mode: "legacy-grandfathered"` with a one-line warning — the license is accepted but the audit log records `activation.legacy_signature`.

This grandfather window exists so customers don't lose access at the second the new server code lands. It is **temporary by design**.

## Flag-day target

**Recommended date: Friday 2026-08-15** (~65 days after the 2026-06-11 server deploy).

Rationale:
- 60+ days gives every customer at least one heartbeat-or-reactivation cycle (server heartbeat is 24h; most customers will roll through it organically).
- Friday + end of summer puts the window outside any normal-business-hours deploy crunch.
- 65 days lets me confirm the production audit log captures all `activation.legacy_signature` events for the grandfathering window — useful for a "we warned X customers Y times" data point in the deprecation notice.

## What to do on the flag day

### 1. Customer notification (1 week before, ~2026-08-08)

Email all active license holders. The list comes from the SQLite licenses.db on the activation server:

```bash
ssh admin@92.243.24.157 'sqlite3 /var/www/contextengine-server/data/licenses.db \
  "SELECT email, plan, expires_at FROM licenses WHERE is_active = 1"'
```

Email template (paste into the chosen SMTP tool):

> Subject: ContextEngine licence reactivation required by 2026-08-15
>
> Your `@compr/contextengine-mcp` (now `@compr/opscontext-mcp`) installation is using a pre-2026-06 licence signature. We deprecated that signature format and now require Ed25519. To keep using your PRO/Team/Enterprise tools without interruption, please run on each activated machine:
>
>     npx @compr/opscontext-mcp activate <your-key> <your-email>
>
> One re-activation per machine; total time about 30 seconds. The new signed licence file replaces the legacy one automatically. After 2026-08-15, legacy licences will be rejected and you will see "License signature rejected — signature field missing" until you re-activate.
>
> Reply to this email if you have any trouble.

### 2. Code change (on or after the flag day)

In `src/license-sig.ts` `verifyLicenseSignature()`, change the legacy-grandfathered branch from returning `ok: true` to returning `ok: false`:

```diff
   if (/^[a-f0-9]{64}$/.test(license.signature)) {
-    return {
-      ok: true,
-      mode: "legacy-grandfathered",
-      warning: "Legacy SHA-256 license signature accepted (grandfathered)...",
-    };
+    return {
+      ok: false,
+      reason: "Legacy SHA-256 license signature — reactivate at https://compr.ch/contextengine/pricing or run `npx @compr/opscontext-mcp activate <key> <email>`",
+    };
   }
```

Same commit:
- Update the `activation.legacy_signature` event docstring in `src/audit.ts` to note that this event is now an artifact (no longer used after flag day).
- Update `tests/license-sig.test.ts` — the `grandfathers a legacy SHA-256 hex signature` test should now assert `ok: false`. Add a `// LOCKED — flag day reached on 2026-08-15` comment so future-me knows why the assertion flipped.
- CHANGELOG entry titled `chore(activation): retire legacy SHA-256 signature acceptance (post-flag-day)`.

### 3. Publish + monitor

- `npm publish --access public` (no need to bump major — semver-patch is correct since this is a tightening of an existing check that was documented as temporary).
- Watch the production `audit.log` for `activation.signature_reject` events with reason `signature field missing` or `Legacy SHA-256 license signature` in the first 7 days. Those are the customers who didn't reactivate; reach out individually.

## What I should NOT do

- Do not touch the server-side signing code on flag day. The server has been signing Ed25519 since 2026-06-11; the client change is what enforces it.
- Do not auto-revoke licenses in the SQLite DB. Customers who haven't reactivated should see a clear local error and self-serve the fix; don't take a heavy hand.
- Do not extend the grandfather window without a written reason in the CHANGELOG. Slip dates rot.

## Calendar

- **Cron / reminder**: 2026-08-08 09:00 CEST → send customer notification email.
- **Cron / reminder**: 2026-08-15 09:00 CEST → ship the code change + publish.
- **Cron / reminder**: 2026-08-22 09:00 CEST → audit the `activation.signature_reject` events from the first week; reach out to any customers who haven't reactivated.

(Adding these to your actual calendar / cron is the human step — this file is the runbook.)

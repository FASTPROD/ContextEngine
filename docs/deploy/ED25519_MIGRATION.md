# Ed25519 License Signature Migration

**Status as of 2026-06-10**: Code merged to main. **Server NOT yet deployed to `api.compr.ch`.**
This document is the deploy runbook; nothing in production has changed yet.

## Why

The audit (Session 03) found that `loadLicense()` did not verify the `LicenseInfo.signature` field. The old "signature" was just `SHA-256(key:machineId:version:expiresAt)` — anyone with knowledge of the four inputs could recompute it. In practice: anyone could write `~/.contextengine/license.json` with `plan: "enterprise"` and unlock all PRO tools.

This is both a **security bug** (privilege escalation) and a **revenue leak** (paid features handed out free).

## What changed

- **`src/license-sig.ts`** (LOCK `[LICENSE-SIG]`) — Ed25519 verifier on the client.
- **`server/src/license-sig.ts`** (LOCK `[LICENSE-SIG-SERVER]`) — Ed25519 signer on the server. Loads private key at startup; refuses to start if missing.
- **`src/activation.ts` `loadLicense()`** — now calls `verifyLicenseSignature()` and rejects forged licenses. Old SHA-256 hashes are **grandfathered with a warning** to prevent breaking existing customers; the flag day for rejection ships in a separate commit.
- **`server/src/server.ts`** — the activate handler now signs the `LicenseInfo` with Ed25519 instead of a SHA-256 hash. The signature shape changed from 64-char hex to 88-char base64; the client distinguishes the two and routes appropriately.
- **`tests/license-sig.test.ts`** — 14 tests covering valid signature, wrong keypair, payload tampering, missing signature, garbage signature, legacy grandfathering, env-var override for self-hosters, plus three adversarial "audit attack" tests that pin the exact privilege-escalation scenarios.
- **`.gitignore`** — added `server/.secrets/` so the private key never gets staged.

## Production keypair

Generated 2026-06-10 with `crypto.generateKeyPairSync('ed25519')`.

- **Public key** (fingerprint `12d0c34c917a47fbed99945d2b7fb439`): embedded as a constant in `src/license-sig.ts` (`LICENSE_PUBLIC_KEY_PEM`). Safe to commit.
- **Private key**: lives at `server/.secrets/ed25519-license-private.pem` on this dev machine, mode `0600`. Gitignored. **Must be transferred to the production VPS** (see deploy steps below) AND backed up to `.copilot-credentials.md` (then `bash ~/Projects/backup-credentials.sh`).

If the private key is lost, EVERY existing customer's signed license becomes unverifiable and they will need to reactivate.

If the private key leaks, an attacker can forge `enterprise`-plan licenses. Rotation procedure: generate new keypair, ship a client update with the new public key as `LICENSE_PUBLIC_KEY_PEM_V2`, accept either signature for N weeks, then revoke v1.

## Deploy steps (manual — DO NOT automate without explicit approval)

### Pre-deploy checklist

- [ ] Local tests green: `cd /Users/yan/Projects/ContextEngine && npm test` — expect 160/160.
- [ ] Server builds: `cd server && npm run build` — clean tsc.
- [ ] Round-trip smoke verified (sign-with-prod-private-key → verify-with-prod-public-key).
- [ ] Private key backed up to `.copilot-credentials.md` and synced via `bash ~/Projects/backup-credentials.sh`.
- [ ] Explicit user authorization to deploy.

### Deploy

1. **Transfer the private key to the VPS.** The activation server runs on a VPS reachable per `~/.copilot-credentials.md`. Use the same channel that ships other secrets:

   ```bash
   # From local
   cat server/.secrets/ed25519-license-private.pem | \
     ssh <vps-user>@api.compr.ch 'sudo tee /var/www/contextengine-server/.secrets/ed25519-license-private.pem > /dev/null && sudo chmod 600 /var/www/contextengine-server/.secrets/ed25519-license-private.pem && sudo chown <pm2-user>:<pm2-group> /var/www/contextengine-server/.secrets/ed25519-license-private.pem'
   ```

2. **Deploy the updated server code.** Follow the existing `server/deploy.sh` flow:

   ```bash
   cd server && ./deploy.sh
   ```

   The PM2 ecosystem on the VPS will restart with the new code. Server startup will:
   - Load the private key from `ED25519_PRIVATE_KEY_PATH` env (set in PM2 ecosystem) or the default path above.
   - Log `✅ Ed25519 license-signing key loaded` on success.
   - **Fail loud and refuse to start** if the key is missing.

3. **Verify the deploy is live.** Per `CLAUDE.md` "DEPLOY = VERIFY LIVE":

   ```bash
   curl -sf https://api.compr.ch/contextengine/health   # expect 200
   # Watch the activation log for the next real activate call — signature
   # should now be an 88-char base64 string, not 64-char hex.
   ```

4. **Optional: roll a test activation.** Activate against a throwaway license key and confirm the client receives an Ed25519-shaped signature.

### Rollback plan

If anything goes wrong, the previous code path (SHA-256 hash) is one commit away. `git revert <ed25519-commit>` on the server, redeploy. Clients with the new code will see the SHA-256 hash as a "legacy-grandfathered" signature and accept it — no client-side rollback needed.

## Flag day for legacy-signature rejection

Today, the client accepts legacy SHA-256 signatures with a warning ("Reactivate to get an Ed25519-signed license"). This is **temporary backward compatibility** — existing customers should not lose access at deploy time.

**Flag day plan** (NOT done in this commit; ship in a follow-up):
- Pick a flag day approximately 60 days after the Ed25519 server deploy lands. Communicate to customers via email + README + activation server response field `signature_migration_deadline`.
- After the flag day, `verifyLicenseSignature()` returns `ok: false` for legacy hashes instead of `ok: true, mode: "legacy-grandfathered"`.
- Ship that change as `chore(activation): retire legacy SHA-256 signature acceptance` with a clear CHANGELOG entry pointing customers at reactivation.

## Test coverage

`tests/license-sig.test.ts` is the verifier contract. Run after any change to either side:

```bash
cd /Users/yan/Projects/ContextEngine && npx vitest run tests/license-sig.test.ts
```

Specific tests pinning the security boundary:

- `canonicalPayload → produces the locked reference byte-string for a known input` — pins the wire format so the client and server cannot drift.
- `audit attack: a hand-authored enterprise license without signature is rejected` — the exact attack the audit named.
- `audit attack: a license signed for ONE plan cannot have its plan field rewritten` — privilege-escalation via local file edit.

## Open questions

- **Stripe webhook-provisioned licenses** go through `provisionLicense()` in `stripe.ts` and are stored in SQLite. The signature happens at `activate` time, not at `provisionLicense` time, so the existing flow continues to work. Confirm during deploy that webhook → activate → signature still produces a valid roundtrip.
- **Heartbeat endpoint** doesn't currently re-sign. Decide whether to also sign heartbeat responses (extra cost: another `sign()` call per heartbeat; benefit: catches signature staleness sooner). Default is NO; signature is set at activation time only.

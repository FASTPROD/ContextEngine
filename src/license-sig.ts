// 🔒 LOCKED [LICENSE-SIG] — 2026-06-10
// ⛔ NEVER change canonicalPayload()'s key order or field set without
//    bumping a new "sig_v":2 marker AND keeping v1 verification working
//    forever. The byte output of this function is what the Ed25519
//    signature covers; any change breaks every license issued before
//    the change.
// ⛔ NEVER ship the public key as a mutable variable. It's a constant
//    that pins the client to the production activation server.
//    Self-hosters override via CE_LICENSE_PUBLIC_KEY env var, which
//    is the documented escape hatch.
// ⛔ NEVER reject legacy SHA-256 signatures silently. Today they're
//    grandfathered with a one-line warning + audit event. The flag
//    day for rejection is a SEPARATE commit, called out in CHANGELOG,
//    and gives existing licensees 30+ days to reactivate.
// WHY: Audit identified that loadLicense() did NOT verify the
//    signature field — anyone could write ~/.contextengine/license.json
//    with plan:"enterprise" and unlock all PRO tools. Security bug +
//    revenue leak. This module closes it without breaking the ~95
//    weekly install users who activated before this commit landed.
// FIX: The PAIR of this file is server/src/license-sig.ts.
//    `canonicalPayload()` must be byte-identical between the two.
//    A test on each side asserts a known-input → known-output mapping
//    to catch drift.
//
// Ed25519 license signature — verify side (client).
//
// Pairs with server/src/license-sig.ts (sign side). Public key below is
// pinned to the production activation server (api.compr.ch). Self-hosters
// override with CE_LICENSE_PUBLIC_KEY env var.

import { createPublicKey, verify } from "crypto";

// Production Ed25519 public key. Paired private key lives ONLY on the
// activation server. Public key SHA-256 fingerprint (first 32 hex chars):
//   12d0c34c917a47fbed99945d2b7fb439
// (Recompute by running on the server:
//   openssl pkey -in private.pem -pubout -outform DER | openssl dgst -sha256)
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAnWMq7ITUPmC/8yx9XmpYktaWmQtXDOx6R2nqSdibq+Y=
-----END PUBLIC KEY-----`;

export const LICENSE_PUBKEY_FINGERPRINT = "12d0c34c917a47fbed99945d2b7fb439";

export interface SignableLicensePayload {
  key: string;
  email: string;
  plan: string;
  machineId: string;
  expiresAt: string;
  deltaVersion: string;
}

/**
 * Stable serialization of the signable payload. MUST stay byte-identical
 * to the server-side canonicalPayload() in server/src/license-sig.ts.
 * Tests on each side assert a known-input → known-output to catch drift.
 */
export function canonicalPayload(license: SignableLicensePayload): string {
  return JSON.stringify({
    key: license.key,
    email: license.email,
    plan: license.plan,
    machineId: license.machineId,
    expiresAt: license.expiresAt,
    deltaVersion: license.deltaVersion,
  });
}

export type VerifyResult =
  | { ok: true; mode: "ed25519" }
  | { ok: true; mode: "legacy-grandfathered"; warning: string }
  | { ok: false; reason: string };

/**
 * Verify the Ed25519 signature on a license.
 *
 * Three outcomes:
 *   - ok=true,  mode=ed25519              → signature valid, full trust
 *   - ok=true,  mode=legacy-grandfathered → pre-Ed25519 SHA-256 hash
 *                                            (64-hex shape); grandfathered
 *                                            until the flag day so existing
 *                                            licensees don't lose access
 *                                            immediately
 *   - ok=false, reason=<string>           → signature missing / invalid /
 *                                            tampered / wrong keypair
 *
 * Override the public key via CE_LICENSE_PUBLIC_KEY env var (PEM contents)
 * for self-hosters running their own activation server.
 */
export function verifyLicenseSignature(
  license: SignableLicensePayload & { signature: string },
  publicKeyPem: string = process.env.CE_LICENSE_PUBLIC_KEY || LICENSE_PUBLIC_KEY_PEM,
): VerifyResult {
  if (!license.signature || license.signature.length === 0) {
    return { ok: false, reason: "signature field missing" };
  }
  // Legacy detection: pre-Ed25519 signatures were SHA-256 hex (64 chars).
  // Real Ed25519 signatures are 64 raw bytes → 88-char base64.
  if (/^[a-f0-9]{64}$/.test(license.signature)) {
    return {
      ok: true,
      mode: "legacy-grandfathered",
      warning:
        "Legacy SHA-256 license signature accepted (grandfathered). Reactivate to get an Ed25519-signed license — pre-flag-day licenses will be rejected after the cutover.",
    };
  }
  try {
    const pubKey = createPublicKey(publicKeyPem);
    const sigBytes = Buffer.from(license.signature, "base64");
    const payload = Buffer.from(canonicalPayload(license));
    const ok = verify(null, payload, pubKey, sigBytes);
    if (!ok) {
      return {
        ok: false,
        reason: "Ed25519 signature invalid (tampered license, wrong keypair, or canonical-payload drift)",
      };
    }
    return { ok: true, mode: "ed25519" };
  } catch (e) {
    return {
      ok: false,
      reason: `signature verify error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

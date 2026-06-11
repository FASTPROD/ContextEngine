// 🔒 LOCKED [LICENSE-SIG-SERVER] — 2026-06-10
// ⛔ NEVER change canonicalPayload() without making the IDENTICAL change
//    to src/license-sig.ts on the client side. The two must produce
//    byte-identical bytes for the same input — that's what the
//    Ed25519 signature covers.
// ⛔ NEVER log or echo the private key. It only goes from the gitignored
//    PEM file or env var into the createPrivateKey() handle.
// ⛔ NEVER fall back to a default private key. Refuse to start if the
//    key is missing — fail loud, never sign with a guess.
// WHY: Ed25519 license signing — closes the audit's revenue-leak
//    finding ("anyone can write license.json with plan:enterprise").
//    Production private key lives ONLY on api.compr.ch.
//
// Ed25519 license signature — sign side (server).
//
// Pairs with src/license-sig.ts (verify side). Private key is loaded from
// ED25519_PRIVATE_KEY_PATH env var or server/.secrets/ed25519-license-
// private.pem (gitignored). Public key is shipped in the client.

import { createPrivateKey, sign, KeyObject } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface SignableLicensePayload {
  key: string;
  email: string;
  plan: string;
  machineId: string;
  expiresAt: string;
  deltaVersion: string;
}

/**
 * MUST stay byte-identical to src/license-sig.ts canonicalPayload().
 * Drift breaks signature verification on every license issued after
 * the drift point. There is a test on each side that pins this to a
 * known reference string — if both pass, the contract holds.
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

/**
 * Load the Ed25519 private key. Priority:
 *   1. ED25519_PRIVATE_KEY_PEM env var (full PEM contents inline — for
 *      Docker / k8s secret-mount patterns).
 *   2. ED25519_PRIVATE_KEY_PATH env var (path to PEM file).
 *   3. server/.secrets/ed25519-license-private.pem (default dev path).
 *
 * Throws on failure. Refuse to start unsigned — never silently degrade
 * to "no signature" mode.
 */
export function loadPrivateKey(): KeyObject {
  if (process.env.ED25519_PRIVATE_KEY_PEM) {
    return createPrivateKey(process.env.ED25519_PRIVATE_KEY_PEM);
  }
  // __dirname is <server>/dist after tsc — one ".." reaches <server>/, where
  // .secrets/ lives. (Earlier this used TWO ".." which landed at /var/www/
  // on the production VPS and broke startup. Caught in prod 2026-06-11.)
  const path =
    process.env.ED25519_PRIVATE_KEY_PATH ||
    join(__dirname, "..", ".secrets", "ed25519-license-private.pem");
  if (!existsSync(path)) {
    throw new Error(
      `Ed25519 private key not found at ${path}. Set ED25519_PRIVATE_KEY_PEM or ED25519_PRIVATE_KEY_PATH, or place the file at server/.secrets/ed25519-license-private.pem (chmod 600). NEVER commit it.`,
    );
  }
  return createPrivateKey(readFileSync(path, "utf-8"));
}

/**
 * Sign a license payload with Ed25519. Returns the signature as base64
 * (88 chars) — matches the format the client-side verifier expects.
 */
export function signLicensePayload(
  license: SignableLicensePayload,
  privateKey: KeyObject,
): string {
  const payload = Buffer.from(canonicalPayload(license));
  return sign(null, payload, privateKey).toString("base64");
}

import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign } from "crypto";
import {
  canonicalPayload,
  verifyLicenseSignature,
  LICENSE_PUBLIC_KEY_PEM,
  LICENSE_PUBKEY_FINGERPRINT,
  type SignableLicensePayload,
} from "../src/license-sig.js";

// ---------------------------------------------------------------------------
// canonicalPayload — the byte-identical contract with the server side
// ---------------------------------------------------------------------------

const REFERENCE_LICENSE: SignableLicensePayload = {
  key: "CE-ABCD-1234-EFGH-5678",
  email: "test@example.com",
  plan: "pro",
  machineId: "abc123def456",
  expiresAt: "2027-01-01T00:00:00.000Z",
  deltaVersion: "1.5.0",
};

// LOCKED REFERENCE — must stay byte-identical to the server-side test.
// If this string changes, server/src/license-sig.ts canonicalPayload()
// MUST be updated to match, and every license issued before the change
// will fail verification. Do not change without a v2-marker migration.
const REFERENCE_CANONICAL =
  '{"key":"CE-ABCD-1234-EFGH-5678","email":"test@example.com","plan":"pro","machineId":"abc123def456","expiresAt":"2027-01-01T00:00:00.000Z","deltaVersion":"1.5.0"}';

describe("canonicalPayload — contract with server", () => {
  it("produces the locked reference byte-string for a known input", () => {
    expect(canonicalPayload(REFERENCE_LICENSE)).toBe(REFERENCE_CANONICAL);
  });

  it("key order is stable regardless of input field order", () => {
    const reordered: SignableLicensePayload = {
      deltaVersion: REFERENCE_LICENSE.deltaVersion,
      expiresAt: REFERENCE_LICENSE.expiresAt,
      machineId: REFERENCE_LICENSE.machineId,
      plan: REFERENCE_LICENSE.plan,
      email: REFERENCE_LICENSE.email,
      key: REFERENCE_LICENSE.key,
    };
    expect(canonicalPayload(reordered)).toBe(REFERENCE_CANONICAL);
  });
});

// ---------------------------------------------------------------------------
// Public key constant
// ---------------------------------------------------------------------------

describe("LICENSE_PUBLIC_KEY_PEM", () => {
  it("is a parseable PEM-encoded Ed25519 public key", () => {
    expect(LICENSE_PUBLIC_KEY_PEM).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(LICENSE_PUBLIC_KEY_PEM).toMatch(/-----END PUBLIC KEY-----$/m);
  });

  it("fingerprint is a 32-char lowercase hex string", () => {
    expect(LICENSE_PUBKEY_FINGERPRINT).toMatch(/^[a-f0-9]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// verifyLicenseSignature — three outcome modes
// ---------------------------------------------------------------------------

// Helper: build a license signed with a TEST keypair (NOT the production key)
function signWithTestKey(license: SignableLicensePayload): {
  signed: SignableLicensePayload & { signature: string };
  publicKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from(canonicalPayload(license));
  const signature = sign(null, payload, privateKey).toString("base64");
  return {
    signed: { ...license, signature },
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("verifyLicenseSignature", () => {
  it("accepts a valid Ed25519 signature with the matching public key", () => {
    const { signed, publicKeyPem } = signWithTestKey(REFERENCE_LICENSE);
    const r = verifyLicenseSignature(signed, publicKeyPem);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mode).toBe("ed25519");
  });

  it("rejects when signature was made with a DIFFERENT keypair", () => {
    const { signed } = signWithTestKey(REFERENCE_LICENSE);
    // Verify against the production public key (not the test keypair)
    const r = verifyLicenseSignature(signed, LICENSE_PUBLIC_KEY_PEM);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invalid|tampered|wrong keypair/);
  });

  it("rejects when the license payload is tampered after signing", () => {
    const { signed, publicKeyPem } = signWithTestKey(REFERENCE_LICENSE);
    const tampered = { ...signed, plan: "enterprise" };
    const r = verifyLicenseSignature(tampered, publicKeyPem);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invalid|tampered/);
  });

  it("rejects when the signature is empty", () => {
    const r = verifyLicenseSignature({ ...REFERENCE_LICENSE, signature: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/missing/);
  });

  it("rejects when the signature is garbage", () => {
    const r = verifyLicenseSignature(
      { ...REFERENCE_LICENSE, signature: "this-is-not-base64!!!" },
      LICENSE_PUBLIC_KEY_PEM,
    );
    expect(r.ok).toBe(false);
  });

  it("grandfathers a legacy SHA-256 hex signature (64-char hex) with a warning", () => {
    const legacyHexSig = "a".repeat(64);
    const r = verifyLicenseSignature({ ...REFERENCE_LICENSE, signature: legacyHexSig });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe("legacy-grandfathered");
      // Warning must point to reactivation, not silently pass
      expect(r.warning.toLowerCase()).toMatch(/reactivate|flag day|grandfathered/);
    }
  });

  it("the CE_LICENSE_PUBLIC_KEY env var overrides the bundled public key (self-hoster path)", () => {
    const { signed, publicKeyPem } = signWithTestKey(REFERENCE_LICENSE);
    const original = process.env.CE_LICENSE_PUBLIC_KEY;
    process.env.CE_LICENSE_PUBLIC_KEY = publicKeyPem;
    try {
      // Caller does not pass a publicKeyPem arg → falls back to env var
      const r = verifyLicenseSignature(signed);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.mode).toBe("ed25519");
    } finally {
      if (original === undefined) delete process.env.CE_LICENSE_PUBLIC_KEY;
      else process.env.CE_LICENSE_PUBLIC_KEY = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial: the audit's exact attack — "anyone can write license.json
// with plan:enterprise and unlock all PRO tools"
// ---------------------------------------------------------------------------

describe("audit attack: forged enterprise license MUST be rejected", () => {
  it("a hand-authored enterprise license without signature is rejected", () => {
    const forged: SignableLicensePayload & { signature: string } = {
      key: "CE-FAKE-FAKE-FAKE-FAKE",
      email: "attacker@evil.com",
      plan: "enterprise",
      machineId: "any-machine",
      expiresAt: "2099-01-01T00:00:00.000Z",
      deltaVersion: "1.0.0",
      signature: "", // attacker doesn't have the private key
    };
    const r = verifyLicenseSignature(forged);
    expect(r.ok).toBe(false);
  });

  it("a forged license with a guessed signature is rejected", () => {
    const forged: SignableLicensePayload & { signature: string } = {
      key: "CE-FAKE-FAKE-FAKE-FAKE",
      email: "attacker@evil.com",
      plan: "enterprise",
      machineId: "any-machine",
      expiresAt: "2099-01-01T00:00:00.000Z",
      deltaVersion: "1.0.0",
      // 88-char base64 of all zeros — Ed25519 will reject
      signature: Buffer.alloc(64).toString("base64"),
    };
    const r = verifyLicenseSignature(forged);
    expect(r.ok).toBe(false);
  });

  it("a license signed for ONE plan cannot have its plan field rewritten", () => {
    const original: SignableLicensePayload = {
      key: "CE-REAL-REAL-REAL-REAL",
      email: "buyer@example.com",
      plan: "pro",
      machineId: "real-machine",
      expiresAt: "2027-01-01T00:00:00.000Z",
      deltaVersion: "1.5.0",
    };
    const { signed, publicKeyPem } = signWithTestKey(original);
    // Attacker buys a pro license, rewrites their local file to "enterprise"
    const escalated = { ...signed, plan: "enterprise" };
    const r = verifyLicenseSignature(escalated, publicKeyPem);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invalid|tampered/);
  });
});

/**
 * Tests for the Tier B community-rules server endpoint.
 *
 * Spins up an in-memory SQLite DB seeded with three licenses (pro, free,
 * enterprise), an in-process Express app with the router mounted, and
 * verifies the auth + entitlement + signature paths.
 *
 * Does NOT use supertest (not in package.json) — uses Node's built-in
 * http module via the running express listener.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import Database from "better-sqlite3";
import {
  generateKeyPairSync,
  createPublicKey,
  verify as verifyEd25519,
} from "crypto";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AddressInfo } from "net";
import {
  createCommunityRulesRouter,
  canonicalSerialize,
  loadCommunityRules,
  _resetCommunityRulesCache,
  type CommunityRulesEnvelope,
  type ExportedRule,
} from "./community-rules-server.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PRO_KEY = "CE-PRO0-0000-0000-0001";
const FREE_KEY = "CE-FREE-0000-0000-0001";
const ENT_KEY = "CE-ENT0-0000-0000-0001";
const REVOKED_KEY = "CE-REVK-0000-0000-0001";

const PRO_MACHINE = "machine-pro-abc";
const FREE_MACHINE = "machine-free-abc";
const ENT_MACHINE = "machine-ent-abc";
const REVOKED_MACHINE = "machine-revoked-abc";

function buildSeededDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'pro',
      max_machines INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      notes TEXT
    );
    CREATE TABLE activations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_id INTEGER NOT NULL REFERENCES licenses(id),
      machine_id TEXT NOT NULL,
      platform TEXT,
      arch TEXT,
      version TEXT,
      activated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
      is_revoked INTEGER NOT NULL DEFAULT 0,
      UNIQUE(license_id, machine_id)
    );
  `);

  const futureExpiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const insLicense = db.prepare(
    "INSERT INTO licenses (key, email, plan, max_machines, expires_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insActivation = db.prepare(
    "INSERT INTO activations (license_id, machine_id, is_revoked) VALUES (?, ?, ?)",
  );

  const proLic = insLicense.run(PRO_KEY, "pro@example.com", "pro", 2, futureExpiry);
  insActivation.run(proLic.lastInsertRowid, PRO_MACHINE, 0);

  const freeLic = insLicense.run(FREE_KEY, "free@example.com", "community", 1, futureExpiry);
  insActivation.run(freeLic.lastInsertRowid, FREE_MACHINE, 0);

  const entLic = insLicense.run(ENT_KEY, "ent@example.com", "enterprise", 10, futureExpiry);
  insActivation.run(entLic.lastInsertRowid, ENT_MACHINE, 0);

  const revLic = insLicense.run(REVOKED_KEY, "rev@example.com", "pro", 2, futureExpiry);
  insActivation.run(revLic.lastInsertRowid, REVOKED_MACHINE, 1); // is_revoked = 1

  return db;
}

// ---------------------------------------------------------------------------
// In-process HTTP harness
// ---------------------------------------------------------------------------

let server: ReturnType<typeof import("http").createServer> | null = null;
let baseUrl = "";
let db: Database.Database;
const { publicKey: TEST_PUBLIC_KEY, privateKey: TEST_PRIVATE_KEY } =
  generateKeyPairSync("ed25519");
const TEST_PUBLIC_KEY_PEM = TEST_PUBLIC_KEY.export({ type: "spki", format: "pem" }).toString();

// Build a tiny custom corpus file so the test never depends on the production
// fixture moving underneath it.
const TMP_DIR = mkdtempSync(join(tmpdir(), "ce-comm-rules-"));
const TMP_DATA = join(TMP_DIR, "tier-b.json");
const TEST_RULES: ExportedRule[] = [
  {
    id: "test-001",
    category: "frontend",
    rule: "Test rule one — a long enough string to clear the 15-char minimum.",
    context: "Used only by community-rules-server.test.ts to assert end-to-end shape.",
    tags: ["test", "fixture"],
    project_cluster: null,
  },
  {
    id: "test-002",
    category: "backend",
    rule: "Test rule two — also long enough to satisfy the schema validator.",
    context: "Second rule so we can assert count >= 2 in the test response.",
    tags: ["test"],
    project_cluster: "cluster-x",
  },
];

beforeAll(async () => {
  writeFileSync(
    TMP_DATA,
    JSON.stringify({
      version: 1,
      generated_at: "2026-06-24T00:00:00.000Z",
      count: TEST_RULES.length,
      rules: TEST_RULES,
    }),
    "utf-8",
  );
  process.env.COMMUNITY_RULES_TIER_B_PATH = TMP_DATA;
  _resetCommunityRulesCache();

  db = buildSeededDb();

  const app = express();
  app.use(express.json());
  app.set("trust proxy", true);
  app.use(
    createCommunityRulesRouter({
      db,
      privateKey: TEST_PRIVATE_KEY,
      // No rate-limiting noise in tests
      rateLimiter: ((_req: any, _res: any, next: any) => next()) as any,
    }),
  );

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  db.close();
});

async function postFetch(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/contextengine/community-rules/fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /contextengine/community-rules/fetch", () => {
  it("returns 200 with a valid signature for a PRO license + active machine", async () => {
    const { status, json } = await postFetch({
      license_token: PRO_KEY,
      machine_id: PRO_MACHINE,
    });
    expect(status).toBe(200);
    expect(json.version).toBe(1);
    expect(typeof json.generated_at).toBe("string");
    expect(new Date(json.generated_at).toString()).not.toBe("Invalid Date");
    expect(json.count).toBe(TEST_RULES.length);
    expect(Array.isArray(json.rules)).toBe(true);
    expect(json.rules.length).toBe(TEST_RULES.length);
    expect(typeof json.signature).toBe("string");
    expect(json.signature.length).toBeGreaterThan(0);

    // Signature verifies with the test public key
    const envelope: CommunityRulesEnvelope = {
      version: json.version,
      generated_at: json.generated_at,
      count: json.count,
      rules: json.rules,
    };
    const ok = verifyEd25519(
      null,
      Buffer.from(canonicalSerialize(envelope)),
      createPublicKey(TEST_PUBLIC_KEY_PEM),
      Buffer.from(json.signature, "base64"),
    );
    expect(ok).toBe(true);
  });

  it("returns 200 + verifies for an enterprise license too", async () => {
    const { status, json } = await postFetch({
      license_token: ENT_KEY,
      machine_id: ENT_MACHINE,
    });
    expect(status).toBe(200);
    expect(json.signature).toBeTruthy();
  });

  it("returns 401 for an invalid license_token", async () => {
    const { status, json } = await postFetch({
      license_token: "CE-NOPE-NOPE-NOPE-NOPE",
      machine_id: PRO_MACHINE,
    });
    expect(status).toBe(401);
    expect(json.error).toMatch(/invalid license/i);
  });

  it("returns 403 for a free-tier license", async () => {
    const { status, json } = await postFetch({
      license_token: FREE_KEY,
      machine_id: FREE_MACHINE,
    });
    expect(status).toBe(403);
    expect(json.error).toMatch(/PRO/);
  });

  it("returns 401 for a machine_id mismatch (machine not activated for this license)", async () => {
    const { status, json } = await postFetch({
      license_token: PRO_KEY,
      machine_id: "machine-that-was-never-activated",
    });
    expect(status).toBe(401);
    expect(json.error).toMatch(/not activated|invalid/i);
  });

  it("returns 401 for a revoked activation", async () => {
    const { status } = await postFetch({
      license_token: REVOKED_KEY,
      machine_id: REVOKED_MACHINE,
    });
    expect(status).toBe(401);
  });

  it("returns 400 when license_token or machine_id is missing", async () => {
    const r1 = await postFetch({ machine_id: PRO_MACHINE });
    expect(r1.status).toBe(400);
    const r2 = await postFetch({ license_token: PRO_KEY });
    expect(r2.status).toBe(400);
  });

  it("response shape matches the CommunityStore schema (modulo signature)", async () => {
    const { status, json } = await postFetch({
      license_token: PRO_KEY,
      machine_id: PRO_MACHINE,
    });
    expect(status).toBe(200);
    // Envelope keys are exactly the locked set
    const envelopeKeys = Object.keys(json).sort();
    expect(envelopeKeys).toEqual(
      ["count", "generated_at", "rules", "signature", "version"].sort(),
    );
    // Each rule has exactly the locked field set
    for (const r of json.rules) {
      expect(Object.keys(r).sort()).toEqual(
        ["category", "context", "id", "project_cluster", "rule", "tags"].sort(),
      );
      expect(typeof r.id).toBe("string");
      expect(typeof r.category).toBe("string");
      expect(typeof r.rule).toBe("string");
      expect(typeof r.context).toBe("string");
      expect(Array.isArray(r.tags)).toBe(true);
      expect(r.project_cluster === null || typeof r.project_cluster === "string").toBe(true);
    }
  });

  it("tampered response fails signature verification (defense-in-depth)", async () => {
    const { json } = await postFetch({
      license_token: PRO_KEY,
      machine_id: PRO_MACHINE,
    });
    const tampered: CommunityRulesEnvelope = {
      version: json.version,
      generated_at: json.generated_at,
      count: json.count,
      // mutate one rule's text — sig is over the locked serialization
      rules: json.rules.map((r: ExportedRule, i: number) =>
        i === 0 ? { ...r, rule: r.rule + " EVIL APPEND" } : r,
      ),
    };
    const ok = verifyEd25519(
      null,
      Buffer.from(canonicalSerialize(tampered)),
      createPublicKey(TEST_PUBLIC_KEY_PEM),
      Buffer.from(json.signature, "base64"),
    );
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadCommunityRules — unit-level checks on the validator
// ---------------------------------------------------------------------------

describe("loadCommunityRules", () => {
  it("returns the fixture rules when the file is valid", () => {
    _resetCommunityRulesCache();
    const rules = loadCommunityRules();
    expect(rules.length).toBe(TEST_RULES.length);
    expect(rules[0].id).toBe("test-001");
  });

  it("throws clearly when the file has a duplicate id", () => {
    const bad = join(TMP_DIR, "dup.json");
    writeFileSync(
      bad,
      JSON.stringify({
        version: 1,
        generated_at: "2026-06-24T00:00:00.000Z",
        count: 2,
        rules: [
          { ...TEST_RULES[0] },
          { ...TEST_RULES[0] }, // duplicate id
        ],
      }),
    );
    const prev = process.env.COMMUNITY_RULES_TIER_B_PATH;
    process.env.COMMUNITY_RULES_TIER_B_PATH = bad;
    _resetCommunityRulesCache();
    try {
      expect(() => loadCommunityRules()).toThrow(/duplicate id/i);
    } finally {
      process.env.COMMUNITY_RULES_TIER_B_PATH = prev;
      _resetCommunityRulesCache();
    }
  });

  it("throws clearly when count mismatches rules.length", () => {
    const bad = join(TMP_DIR, "miscount.json");
    writeFileSync(
      bad,
      JSON.stringify({
        version: 1,
        generated_at: "2026-06-24T00:00:00.000Z",
        count: 99,
        rules: [TEST_RULES[0]],
      }),
    );
    const prev = process.env.COMMUNITY_RULES_TIER_B_PATH;
    process.env.COMMUNITY_RULES_TIER_B_PATH = bad;
    _resetCommunityRulesCache();
    try {
      expect(() => loadCommunityRules()).toThrow(/count/i);
    } finally {
      process.env.COMMUNITY_RULES_TIER_B_PATH = prev;
      _resetCommunityRulesCache();
    }
  });

  it("throws on unsupported version", () => {
    const bad = join(TMP_DIR, "v2.json");
    writeFileSync(
      bad,
      JSON.stringify({
        version: 2,
        generated_at: "2026-06-24T00:00:00.000Z",
        count: 0,
        rules: [],
      }),
    );
    const prev = process.env.COMMUNITY_RULES_TIER_B_PATH;
    process.env.COMMUNITY_RULES_TIER_B_PATH = bad;
    _resetCommunityRulesCache();
    try {
      expect(() => loadCommunityRules()).toThrow(/version/i);
    } finally {
      process.env.COMMUNITY_RULES_TIER_B_PATH = prev;
      _resetCommunityRulesCache();
    }
  });
});

// ---------------------------------------------------------------------------
// canonicalSerialize — locked key order contract
// ---------------------------------------------------------------------------

describe("canonicalSerialize", () => {
  it("produces stable, key-ordered output regardless of input field order", () => {
    const a: CommunityRulesEnvelope = {
      version: 1,
      generated_at: "2026-06-24T00:00:00.000Z",
      count: 1,
      rules: [TEST_RULES[0]],
    };
    const reordered = {
      count: 1,
      rules: [TEST_RULES[0]],
      generated_at: "2026-06-24T00:00:00.000Z",
      version: 1,
    } as unknown as CommunityRulesEnvelope;
    expect(canonicalSerialize(a)).toBe(canonicalSerialize(reordered));
  });

  it("orders rule fields the same way every time", () => {
    const env: CommunityRulesEnvelope = {
      version: 1,
      generated_at: "2026-06-24T00:00:00.000Z",
      count: 1,
      rules: [TEST_RULES[0]],
    };
    const out = canonicalSerialize(env);
    // Rule keys in the locked order
    const ruleKeyOrder = out.indexOf('"id"');
    const catIdx = out.indexOf('"category"');
    const ruleIdx = out.indexOf('"rule"');
    const ctxIdx = out.indexOf('"context"');
    const tagsIdx = out.indexOf('"tags"');
    const clusterIdx = out.indexOf('"project_cluster"');
    expect(ruleKeyOrder).toBeLessThan(catIdx);
    expect(catIdx).toBeLessThan(ruleIdx);
    expect(ruleIdx).toBeLessThan(ctxIdx);
    expect(ctxIdx).toBeLessThan(tagsIdx);
    expect(tagsIdx).toBeLessThan(clusterIdx);
  });
});

/**
 * community-sync.test.ts — exercises the Tier A / Tier B sync client.
 *
 * Strategy: we override the http transport with a per-test mock via
 * __setHttpForTesting(), so no real network is touched and we can drive
 * 200 / 304 / 401 / network-failure code paths deterministically.
 *
 * The community store path is fixed at ~/.contextengine/community-learnings.json
 * — we redirect this by writing into a tempdir-symlinked HOME for the
 * duration of the test (vitest scope only).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateKeyPairSync, sign } from "crypto";

import {
  loadCommunityStore,
  communityRulesToChunks,
  mergeWithDedup,
  syncTierA,
  syncTierB,
  __setHttpForTesting,
  getMachineId,
  STORE_PATH,
  type HttpResponse,
  type CommunityRule,
  type CommunityStore,
} from "./community-sync.js";
import {
  canonicalPayload,
  type SignableLicensePayload,
} from "./license-sig.js";
import type { Chunk } from "./ingest.js";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/**
 * The STORE_PATH constant is captured at import time from $HOME. We can't
 * easily redirect that mid-test, so instead we delete + restore the real
 * file across each test. The file lives at ~/.contextengine/community-learnings.json
 * — we save its prior contents (if any) before each test and restore after.
 */
let priorStoreContent: string | null = null;

function saveStoreSnapshot(): void {
  priorStoreContent = existsSync(STORE_PATH)
    ? readFileSync(STORE_PATH, "utf-8")
    : null;
  if (existsSync(STORE_PATH)) {
    rmSync(STORE_PATH, { force: true });
  }
}

function restoreStoreSnapshot(): void {
  if (priorStoreContent === null) {
    if (existsSync(STORE_PATH)) rmSync(STORE_PATH, { force: true });
  } else {
    mkdirSync(join(STORE_PATH, ".."), { recursive: true });
    writeFileSync(STORE_PATH, priorStoreContent);
  }
}

beforeEach(() => {
  saveStoreSnapshot();
});

afterEach(() => {
  __setHttpForTesting(null);
  restoreStoreSnapshot();
});

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const VALID_TIER_A_RULE = {
  id: "rule-001",
  category: "deployment",
  rule: "Always restart Flask after model changes — stale to_dict() cache",
  context: "FastAPI / Flask hot-reload doesn't re-import jsonifiers",
  tags: ["flask", "deployment"],
};

const VALID_TIER_A_RULE_2 = {
  id: "rule-002",
  category: "security",
  rule: "Never log Authorization headers even in development",
  context: "Devs share logs in Slack; tokens leak",
  tags: ["security", "logging"],
};

function makeHttpMock(
  response: HttpResponse,
): typeof __setHttpForTesting extends (fn: infer F | null) => void ? F : never {
  return (async () => response) as never;
}

// ---------------------------------------------------------------------------
// syncTierA
// ---------------------------------------------------------------------------

describe("syncTierA", () => {
  it("200 with rules: writes store, fetched > 0", async () => {
    const payload = JSON.stringify({
      rules: [VALID_TIER_A_RULE, VALID_TIER_A_RULE_2],
    });
    __setHttpForTesting(
      makeHttpMock({
        statusCode: 200,
        headers: { etag: '"abc123"' },
        body: payload,
      }),
    );

    const result = await syncTierA();
    expect(result.cached).toBe(false);
    expect(result.fetched).toBe(2);

    const store = loadCommunityStore();
    expect(store.rules.length).toBe(2);
    expect(store.rules.every((r) => r.source === "tier-A-public")).toBe(true);
    expect(store.source_tier_a_etag).toBe('"abc123"');
  });

  it("304 with cached etag: returns cached:true, does not overwrite", async () => {
    // Seed store with prior content
    const seeded: CommunityStore = {
      version: 1,
      fetched_at: new Date().toISOString(),
      source_tier_a_etag: '"old-etag"',
      rules: [
        {
          ...VALID_TIER_A_RULE,
          source: "tier-A-public",
          fetched_at: new Date().toISOString(),
        } as CommunityRule,
      ],
    };
    mkdirSync(join(STORE_PATH, ".."), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(seeded, null, 2));

    __setHttpForTesting(
      makeHttpMock({
        statusCode: 304,
        headers: {},
        body: "",
      }),
    );

    const result = await syncTierA();
    expect(result.cached).toBe(true);
    expect(result.fetched).toBe(0);

    const store = loadCommunityStore();
    expect(store.rules.length).toBe(1);
    expect(store.source_tier_a_etag).toBe('"old-etag"');
  });

  it("network failure: returns cached, logs to stderr, doesn't throw", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    __setHttpForTesting(async () => {
      throw new Error("ECONNREFUSED");
    });

    const result = await syncTierA();
    expect(result.cached).toBe(true);
    expect(result.fetched).toBe(0);
    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("malformed JSON response: returns cached, logs, doesn't throw", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    __setHttpForTesting(
      makeHttpMock({
        statusCode: 200,
        headers: { etag: '"foo"' },
        body: "this is not json {{",
      }),
    );

    const result = await syncTierA();
    expect(result.fetched).toBe(0);
    expect(result.cached).toBe(true);
    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("accepts a bare JSON array (no rules wrapper)", async () => {
    __setHttpForTesting(
      makeHttpMock({
        statusCode: 200,
        headers: {},
        body: JSON.stringify([VALID_TIER_A_RULE]),
      }),
    );
    const result = await syncTierA();
    expect(result.fetched).toBe(1);
  });

  it("force=true skips the If-None-Match etag header (refetches)", async () => {
    // Seed with prior etag
    const seeded: CommunityStore = {
      version: 1,
      fetched_at: new Date().toISOString(),
      source_tier_a_etag: '"stale"',
      rules: [],
    };
    mkdirSync(join(STORE_PATH, ".."), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(seeded));

    let receivedHeaders: Record<string, string> | undefined;
    __setHttpForTesting(async (_url, opts) => {
      receivedHeaders = opts?.headers as Record<string, string>;
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ rules: [VALID_TIER_A_RULE] }),
      };
    });

    await syncTierA({ force: true });
    expect(receivedHeaders).toBeDefined();
    expect(receivedHeaders!["If-None-Match"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// syncTierB
// ---------------------------------------------------------------------------

/**
 * Build a Tier B response signed by a TEST keypair (NOT production).
 * Uses CE_LICENSE_PUBLIC_KEY env override so verifyLicenseSignature() picks
 * up our test public key.
 */
function buildSignedTierBPayload(
  rules: unknown[],
  overrides: Partial<SignableLicensePayload> = {},
): {
  payload: string;
  publicKeyPem: string;
  signaturePayload: SignableLicensePayload;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Defaults that PASS the new [COMMUNITY-SYNC-REPLAY-GUARD] checks:
  //   key + machineId bind to the actual fetch call's licenseToken + the
  //   real machine, and expiresAt is 24h in the future (within the 36h
  //   freshness ceiling).
  const signaturePayload: SignableLicensePayload = {
    key: "CE-TEST-TIERB-FETCH",
    email: "tierb@example.com",
    plan: "pro",
    machineId: getMachineId(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    deltaVersion: "test-delta",
    ...overrides,
  };
  const canon = Buffer.from(canonicalPayload(signaturePayload));
  const signature = sign(null, canon, privateKey).toString("base64");
  const payload = JSON.stringify({
    rules,
    signature_payload: signaturePayload,
    signature,
  });
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  return { payload, publicKeyPem, signaturePayload };
}

describe("syncTierB", () => {
  it("200 with valid signature: writes store", async () => {
    // Bind the signature_payload to the SAME license token the test sends
    // (the new [COMMUNITY-SYNC-REPLAY-GUARD] rejects otherwise).
    const LICENSE = "CE-TEST-TIERB-FETCH";
    const { payload, publicKeyPem } = buildSignedTierBPayload(
      [VALID_TIER_A_RULE],
      { key: LICENSE },
    );
    process.env.CE_LICENSE_PUBLIC_KEY = publicKeyPem;
    try {
      __setHttpForTesting(
        makeHttpMock({
          statusCode: 200,
          headers: { etag: '"v1"' },
          body: payload,
        }),
      );
      const result = await syncTierB(LICENSE);
      expect(result.cached).toBe(false);
      expect(result.fetched).toBe(1);

      const store = loadCommunityStore();
      expect(store.rules.length).toBe(1);
      expect(store.rules[0].source).toBe("tier-B-pro");
    } finally {
      delete process.env.CE_LICENSE_PUBLIC_KEY;
    }
  });

  it("REPLAY-GUARD: rejects valid signature whose payload.key doesn't match the requesting license", async () => {
    // Attacker captures a signed response for license A, replays against
    // license B. The signature verifies (it really was signed by the
    // server), but key mismatch means it was for someone else.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { payload, publicKeyPem } = buildSignedTierBPayload(
      [VALID_TIER_A_RULE],
      { key: "CE-ATTACKER-CAPTURED-LICENSE" },
    );
    process.env.CE_LICENSE_PUBLIC_KEY = publicKeyPem;
    try {
      __setHttpForTesting(
        makeHttpMock({ statusCode: 200, headers: {}, body: payload }),
      );
      const result = await syncTierB("CE-VICTIM-LICENSE-KEY");
      expect(result.fetched).toBe(0);
      expect(result.cached).toBe(true);
      expect(stderrSpy).toHaveBeenCalled();
      expect(
        stderrSpy.mock.calls.some((c) =>
          String(c[0]).includes("license-token mismatch"),
        ),
      ).toBe(true);
    } finally {
      delete process.env.CE_LICENSE_PUBLIC_KEY;
      stderrSpy.mockRestore();
    }
  });

  it("REPLAY-GUARD: rejects valid signature whose payload.machineId doesn't match this machine", async () => {
    const LICENSE = "CE-TEST-TIERB-FETCH";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { payload, publicKeyPem } = buildSignedTierBPayload(
      [VALID_TIER_A_RULE],
      { key: LICENSE, machineId: "SOMEONE-ELSES-MACHINE-ID" },
    );
    process.env.CE_LICENSE_PUBLIC_KEY = publicKeyPem;
    try {
      __setHttpForTesting(
        makeHttpMock({ statusCode: 200, headers: {}, body: payload }),
      );
      const result = await syncTierB(LICENSE);
      expect(result.fetched).toBe(0);
      expect(result.cached).toBe(true);
      expect(
        stderrSpy.mock.calls.some((c) =>
          String(c[0]).includes("machine-id mismatch"),
        ),
      ).toBe(true);
    } finally {
      delete process.env.CE_LICENSE_PUBLIC_KEY;
      stderrSpy.mockRestore();
    }
  });

  it("REPLAY-GUARD: rejects expired signed payload", async () => {
    const LICENSE = "CE-TEST-TIERB-FETCH";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { payload, publicKeyPem } = buildSignedTierBPayload(
      [VALID_TIER_A_RULE],
      { key: LICENSE, expiresAt: new Date(Date.now() - 1000).toISOString() },
    );
    process.env.CE_LICENSE_PUBLIC_KEY = publicKeyPem;
    try {
      __setHttpForTesting(
        makeHttpMock({ statusCode: 200, headers: {}, body: payload }),
      );
      const result = await syncTierB(LICENSE);
      expect(result.fetched).toBe(0);
      expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes("expired"))).toBe(
        true,
      );
    } finally {
      delete process.env.CE_LICENSE_PUBLIC_KEY;
      stderrSpy.mockRestore();
    }
  });

  it("REPLAY-GUARD: rejects signed payload with expiresAt > 36h in the future (server over-issuing)", async () => {
    const LICENSE = "CE-TEST-TIERB-FETCH";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { payload, publicKeyPem } = buildSignedTierBPayload(
      [VALID_TIER_A_RULE],
      {
        key: LICENSE,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      },
    );
    process.env.CE_LICENSE_PUBLIC_KEY = publicKeyPem;
    try {
      __setHttpForTesting(
        makeHttpMock({ statusCode: 200, headers: {}, body: payload }),
      );
      const result = await syncTierB(LICENSE);
      expect(result.fetched).toBe(0);
      expect(
        stderrSpy.mock.calls.some((c) =>
          String(c[0]).includes("freshness") || String(c[0]).includes("expires too far"),
        ),
      ).toBe(true);
    } finally {
      delete process.env.CE_LICENSE_PUBLIC_KEY;
      stderrSpy.mockRestore();
    }
  });

  it("401: no crash, returns fetched=0, cached=false, stderr logged", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    __setHttpForTesting(
      makeHttpMock({
        statusCode: 401,
        headers: {},
        body: "Unauthorized",
      }),
    );
    const result = await syncTierB("expired-key");
    expect(result.fetched).toBe(0);
    expect(result.cached).toBe(false);
    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("invalid signature: rejects (no rules written), logs", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Build a payload with a signature from a DIFFERENT keypair than the one
    // we install as CE_LICENSE_PUBLIC_KEY.
    const { payload } = buildSignedTierBPayload([VALID_TIER_A_RULE]);
    // Install a DIFFERENT public key so verification fails
    const decoy = generateKeyPairSync("ed25519").publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    process.env.CE_LICENSE_PUBLIC_KEY = decoy;
    try {
      __setHttpForTesting(
        makeHttpMock({
          statusCode: 200,
          headers: {},
          body: payload,
        }),
      );
      const result = await syncTierB("any-key");
      expect(result.fetched).toBe(0);
      // Store untouched, treat as cached fallback
      const store = loadCommunityStore();
      expect(store.rules.length).toBe(0);
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      delete process.env.CE_LICENSE_PUBLIC_KEY;
      stderrSpy.mockRestore();
    }
  });

  it("payload missing rules array: rejects", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    __setHttpForTesting(
      makeHttpMock({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ signature: "abc" }), // no rules, no signature_payload
      }),
    );
    const result = await syncTierB("any-key");
    expect(result.fetched).toBe(0);
    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("empty license token: returns 0 fetched, doesn't hit network", async () => {
    let httpCalled = false;
    __setHttpForTesting(async () => {
      httpCalled = true;
      return { statusCode: 200, headers: {}, body: "{}" };
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await syncTierB("");
    expect(result.fetched).toBe(0);
    expect(httpCalled).toBe(false);
    stderrSpy.mockRestore();
  });

  it("network failure: returns cached, doesn't throw", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    __setHttpForTesting(async () => {
      throw new Error("ETIMEDOUT");
    });
    const result = await syncTierB("any-key");
    expect(result.cached).toBe(true);
    expect(result.fetched).toBe(0);
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// loadCommunityStore
// ---------------------------------------------------------------------------

describe("loadCommunityStore", () => {
  it("returns empty store when file missing", () => {
    if (existsSync(STORE_PATH)) rmSync(STORE_PATH, { force: true });
    const store = loadCommunityStore();
    expect(store.version).toBe(1);
    expect(store.rules).toEqual([]);
  });

  it("parses correctly when file present", () => {
    const seeded: CommunityStore = {
      version: 1,
      fetched_at: "2026-06-23T10:00:00.000Z",
      rules: [
        {
          id: "x",
          source: "tier-A-public",
          category: "deployment",
          rule: "Test rule from disk",
          context: "ctx",
          tags: ["a"],
          fetched_at: "2026-06-23T10:00:00.000Z",
        },
      ],
    };
    mkdirSync(join(STORE_PATH, ".."), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(seeded));
    const store = loadCommunityStore();
    expect(store.rules.length).toBe(1);
    expect(store.rules[0].rule).toBe("Test rule from disk");
  });

  it("returns empty store for corrupted JSON", () => {
    mkdirSync(join(STORE_PATH, ".."), { recursive: true });
    writeFileSync(STORE_PATH, "{{this is not json");
    const store = loadCommunityStore();
    expect(store.rules).toEqual([]);
  });

  it("returns empty store for wrong version", () => {
    mkdirSync(join(STORE_PATH, ".."), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify({ version: 999, rules: [] }));
    const store = loadCommunityStore();
    expect(store.version).toBe(1);
    expect(store.rules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// communityRulesToChunks
// ---------------------------------------------------------------------------

describe("communityRulesToChunks", () => {
  it("produces chunks with source field reflecting the tier", () => {
    const seeded: CommunityStore = {
      version: 1,
      fetched_at: new Date().toISOString(),
      rules: [
        {
          id: "a",
          source: "tier-A-public",
          category: "deployment",
          rule: "Tier A rule example for chunk emit",
          context: "ctx",
          tags: ["a"],
          fetched_at: new Date().toISOString(),
        },
        {
          id: "b",
          source: "tier-B-pro",
          category: "security",
          rule: "Tier B pro rule example for chunk emit",
          context: "ctx",
          tags: ["s"],
          fetched_at: new Date().toISOString(),
        },
      ],
    };
    mkdirSync(join(STORE_PATH, ".."), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(seeded));

    const chunks = communityRulesToChunks();
    expect(chunks.length).toBe(2);

    const tierA = chunks.find((c) => c.source.includes("tier-A"));
    const tierB = chunks.find((c) => c.source.includes("tier-B"));
    expect(tierA).toBeDefined();
    expect(tierB).toBeDefined();

    // The section prefix is what the UI uses to render the "(community)" badge
    expect(tierA!.section).toMatch(/\[community:tier-A\]/);
    expect(tierB!.section).toMatch(/\[community:tier-B\]/);
  });

  it("doesn't lose any rule", () => {
    const N = 7;
    const rules: CommunityRule[] = [];
    for (let i = 0; i < N; i++) {
      rules.push({
        id: `r${i}`,
        source: i % 2 === 0 ? "tier-A-public" : "tier-B-pro",
        category: "deployment",
        rule: `Rule number ${i} with enough length to pass`,
        context: "ctx",
        tags: [],
        fetched_at: new Date().toISOString(),
      });
    }
    const seeded: CommunityStore = {
      version: 1,
      fetched_at: new Date().toISOString(),
      rules,
    };
    mkdirSync(join(STORE_PATH, ".."), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(seeded));
    const chunks = communityRulesToChunks();
    expect(chunks.length).toBe(N);
  });

  it("returns empty array when no community rules cached", () => {
    if (existsSync(STORE_PATH)) rmSync(STORE_PATH, { force: true });
    expect(communityRulesToChunks()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Search merge / dedup
// ---------------------------------------------------------------------------

describe("mergeWithDedup", () => {
  function makeLocalLearningChunk(rule: string): Chunk {
    // Mirrors the shape that learningsToChunks() produces — see
    // learnings.ts:learningsToChunks() for the canonical version.
    return {
      source: "💡 Learnings Store",
      section: `[deployment] ${rule}`,
      content: [
        `**Rule:** ${rule}`,
        `**Category:** deployment`,
        `**Context:** local-defined`,
      ].join("\n"),
      lineStart: 0,
      lineEnd: 0,
    };
  }

  function makeCommunityChunkForRule(rule: string): Chunk {
    return {
      source: "🌐 Community Rules (tier-A)",
      section: `[community:tier-A] [deployment] ${rule}`,
      content: [
        `**Rule:** ${rule}`,
        `**Category:** deployment`,
        `**Source:** community / tier-A-public`,
      ].join("\n"),
      lineStart: 0,
      lineEnd: 0,
    };
  }

  it("identical rule from local + community is emitted only once (local wins)", () => {
    const sharedRule = "Always restart Flask after model changes (shared)";
    const local = [makeLocalLearningChunk(sharedRule)];
    const community = [makeCommunityChunkForRule(sharedRule)];
    const merged = mergeWithDedup(local, community);
    // Only the local one survives — community duplicate is dropped.
    expect(merged.length).toBe(1);
    expect(merged[0].source).toContain("Learnings Store");
  });

  it("distinct rules from each side are both kept", () => {
    const local = [makeLocalLearningChunk("Local-only rule about pm2 restart")];
    const community = [
      makeCommunityChunkForRule("Community-only rule about kubectl drain"),
    ];
    const merged = mergeWithDedup(local, community);
    expect(merged.length).toBe(2);
  });

  it("case-insensitive matching catches near-duplicates", () => {
    const local = [makeLocalLearningChunk("Always Restart Flask After Model Changes")];
    const community = [
      makeCommunityChunkForRule("always restart flask after model changes"),
    ];
    const merged = mergeWithDedup(local, community);
    expect(merged.length).toBe(1);
  });

  it("empty community list returns local unchanged", () => {
    const local = [makeLocalLearningChunk("Some local rule for the test suite")];
    const merged = mergeWithDedup(local, []);
    expect(merged).toBe(local);
  });

  it("empty local list returns all community chunks", () => {
    const community = [
      makeCommunityChunkForRule("Community rule one of many in test"),
      makeCommunityChunkForRule("Community rule two of many in test"),
    ];
    const merged = mergeWithDedup([], community);
    expect(merged.length).toBe(2);
  });
});

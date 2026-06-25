/**
 * community-sync.ts — fetch & cache community-contributed learnings.
 *
 * Two tiers:
 *   A) Public  — raw.githubusercontent.com (no auth, ETag cached)
 *   B) Pro     — api.compr.ch (license-token auth, server-signed payload)
 *
 * Both tiers produce CommunityRule records that share the local store at
 * ~/.contextengine/community-learnings.json. At search-init time the
 * MCP server merges these into the same chunk pipeline as the local
 * Learnings Store so they surface inside search_context with a
 * "(community)" badge.
 *
 * Auth shape for Tier B matches /heartbeat exactly (see activation.ts):
 *   POST { license_token, machine_id }
 *
 * Design constraints:
 *   - Node built-in `https` only (no fetch wrapper deps)
 *   - Network failures NEVER crash search — fall back to cached store
 *   - Tier B is best-effort; on 401 we log + return zero, don't throw
 *   - The signed payload from Tier B is verified before merge using the
 *     existing Ed25519 verifyLicenseSignature() helper
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import * as https from "https";
import { URL } from "url";
import { safeAppend } from "./audit.js";
import { Chunk } from "./ingest.js";
import {
  verifyLicenseSignature,
  type SignableLicensePayload,
} from "./license-sig.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TIER_A_URL =
  "https://raw.githubusercontent.com/FASTPROD/opscontext-community-rules/main/rules.json";

export const TIER_B_URL =
  "https://api.compr.ch/contextengine/community-rules/fetch";

export const STORE_PATH = join(
  homedir(),
  ".contextengine",
  "community-learnings.json",
);

const STORE_DIR = join(homedir(), ".contextengine");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommunitySource = "tier-A-public" | "tier-B-pro";

export interface CommunityRule {
  id: string;
  source: CommunitySource;
  category: string;
  rule: string;
  context: string;
  tags: string[];
  /** Hashed project cluster identifier (Tier B emits this; Tier A omits). */
  project_cluster?: string;
  fetched_at: string;
}

export interface CommunityStore {
  version: 1;
  fetched_at: string;
  source_tier_a_etag?: string;
  source_tier_b_etag?: string;
  rules: CommunityRule[];
}

export interface SyncResult {
  fetched: number;
  cached: boolean;
}

// ---------------------------------------------------------------------------
// Machine fingerprint — duplicated from activation.ts so this module has
// zero internal coupling. Both must produce identical output; if you
// change one, change both.
// ---------------------------------------------------------------------------

export function getMachineId(): string {
  const components = [
    process.platform,
    process.arch,
    homedir().split("/").slice(0, 3).join("/"),
    process.env.USER || process.env.USERNAME || "unknown",
  ];
  return createHash("sha256")
    .update(components.join("|"))
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

function ensureDir(): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true });
  }
}

function emptyStore(): CommunityStore {
  return {
    version: 1,
    fetched_at: new Date(0).toISOString(),
    rules: [],
  };
}

export function loadCommunityStore(): CommunityStore {
  if (!existsSync(STORE_PATH)) return emptyStore();
  try {
    const raw = readFileSync(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.rules)
    ) {
      return emptyStore();
    }
    return parsed as CommunityStore;
  } catch {
    return emptyStore();
  }
}

function saveCommunityStore(store: CommunityStore): void {
  ensureDir();
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// ---------------------------------------------------------------------------
// HTTP helpers — Node built-in https only
// ---------------------------------------------------------------------------

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface HttpOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Override the underlying request function — used in tests. */
  requestFn?: typeof https.request;
}

export function httpRequest(
  url: string,
  opts: HttpOptions = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }

    const requestFn = opts.requestFn || https.request;

    const reqOpts = {
      method: opts.method || "GET",
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers: opts.headers || {},
    };

    const req = requestFn(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
      res.on("error", reject);
    });

    req.on("error", reject);

    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Test seam — community-sync.test.ts sets these to intercept network I/O
// without monkey-patching globals.
let _httpForTest: typeof httpRequest | null = null;
export function __setHttpForTesting(fn: typeof httpRequest | null): void {
  _httpForTest = fn;
}

function http(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
  if (_httpForTest) return _httpForTest(url, opts);
  return httpRequest(url, opts);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isValidRuleShape(r: unknown): r is Omit<CommunityRule, "source" | "fetched_at"> {
  if (!r || typeof r !== "object") return false;
  const rec = r as Record<string, unknown>;
  return (
    typeof rec.id === "string" &&
    typeof rec.category === "string" &&
    typeof rec.rule === "string" &&
    rec.rule.length >= 10 &&
    typeof rec.context === "string" &&
    Array.isArray(rec.tags) &&
    rec.tags.every((t) => typeof t === "string")
  );
}

function normalizeIncoming(
  source: CommunitySource,
  rawRules: unknown[],
): CommunityRule[] {
  const now = new Date().toISOString();
  const out: CommunityRule[] = [];
  for (const r of rawRules) {
    if (!isValidRuleShape(r)) continue;
    const rec = r as Record<string, unknown>;
    out.push({
      id: rec.id as string,
      source,
      category: rec.category as string,
      rule: rec.rule as string,
      context: rec.context as string,
      tags: rec.tags as string[],
      project_cluster:
        typeof rec.project_cluster === "string"
          ? (rec.project_cluster as string)
          : undefined,
      fetched_at: now,
    });
  }
  return out;
}

/**
 * Replace all rules from a given source with the freshly-fetched set.
 * (Rules from the *other* source are preserved.)
 */
function mergeRules(
  store: CommunityStore,
  source: CommunitySource,
  freshRules: CommunityRule[],
): CommunityStore {
  const keep = store.rules.filter((r) => r.source !== source);
  return {
    ...store,
    fetched_at: new Date().toISOString(),
    rules: [...keep, ...freshRules],
  };
}

// ---------------------------------------------------------------------------
// Tier A — public GitHub-hosted rules
// ---------------------------------------------------------------------------

export async function syncTierA(
  opts: { force?: boolean } = {},
): Promise<SyncResult> {
  const store = loadCommunityStore();
  const headers: Record<string, string> = {
    "User-Agent": "opscontext-community-sync/1",
    Accept: "application/json",
  };
  if (!opts.force && store.source_tier_a_etag) {
    headers["If-None-Match"] = store.source_tier_a_etag;
  }

  let res: HttpResponse;
  try {
    res = await http(TIER_A_URL, { method: "GET", headers });
  } catch (e) {
    // Network failure — fall back to cache, don't crash.
    process.stderr.write(
      `[community-sync] Tier A fetch failed (${
        e instanceof Error ? e.message : String(e)
      }); using cached store.\n`,
    );
    safeAppend("community.sync_error", {
      tier: "A",
      reason: e instanceof Error ? e.message : String(e),
    });
    return { fetched: 0, cached: true };
  }

  if (res.statusCode === 304) {
    return { fetched: 0, cached: true };
  }

  if (res.statusCode !== 200) {
    process.stderr.write(
      `[community-sync] Tier A unexpected status ${res.statusCode}; using cached store.\n`,
    );
    safeAppend("community.sync_error", {
      tier: "A",
      status: res.statusCode,
    });
    return { fetched: 0, cached: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    process.stderr.write(`[community-sync] Tier A JSON parse failed; using cache.\n`);
    safeAppend("community.sync_error", { tier: "A", reason: "json_parse" });
    return { fetched: 0, cached: true };
  }

  const rawRules = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.rules)
      ? ((parsed as Record<string, unknown>).rules as unknown[])
      : [];

  const fresh = normalizeIncoming("tier-A-public", rawRules);
  const merged = mergeRules(store, "tier-A-public", fresh);

  const etag = readEtag(res.headers);
  if (etag) merged.source_tier_a_etag = etag;

  saveCommunityStore(merged);
  safeAppend("community.sync_ok", { tier: "A", fetched: fresh.length });
  return { fetched: fresh.length, cached: false };
}

function readEtag(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const v = headers["etag"] || headers["ETag"] || headers["Etag"];
  if (!v) return null;
  if (Array.isArray(v)) return v[0];
  return v;
}

// ---------------------------------------------------------------------------
// Tier B — license-gated, server-signed
// ---------------------------------------------------------------------------

interface TierBSignedPayload {
  rules: unknown[];
  /** Signable license-shape echo back from the server. */
  signature_payload: SignableLicensePayload;
  signature: string;
}

export async function syncTierB(
  licenseToken: string,
  opts: { force?: boolean } = {},
): Promise<SyncResult> {
  if (!licenseToken) {
    process.stderr.write(
      `[community-sync] Tier B skipped: no license token provided.\n`,
    );
    return { fetched: 0, cached: false };
  }

  const store = loadCommunityStore();
  const headers: Record<string, string> = {
    "User-Agent": "opscontext-community-sync/1",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (!opts.force && store.source_tier_b_etag) {
    headers["If-None-Match"] = store.source_tier_b_etag;
  }

  const body = JSON.stringify({
    license_token: licenseToken,
    machine_id: getMachineId(),
  });

  let res: HttpResponse;
  try {
    res = await http(TIER_B_URL, { method: "POST", headers, body });
  } catch (e) {
    process.stderr.write(
      `[community-sync] Tier B fetch failed (${
        e instanceof Error ? e.message : String(e)
      }); using cached store.\n`,
    );
    safeAppend("community.sync_error", {
      tier: "B",
      reason: e instanceof Error ? e.message : String(e),
    });
    return { fetched: 0, cached: true };
  }

  if (res.statusCode === 304) {
    return { fetched: 0, cached: true };
  }

  if (res.statusCode === 401 || res.statusCode === 403) {
    process.stderr.write(
      `[community-sync] Tier B auth rejected (HTTP ${res.statusCode}). ` +
        `Subscription may have expired — visit https://api.compr.ch/contextengine/pricing to renew. ` +
        `Continuing with cached community store.\n`,
    );
    safeAppend("community.sync_error", {
      tier: "B",
      status: res.statusCode,
      reason: "auth_rejected",
    });
    return { fetched: 0, cached: false };
  }

  if (res.statusCode !== 200) {
    process.stderr.write(
      `[community-sync] Tier B unexpected status ${res.statusCode}; using cached store.\n`,
    );
    safeAppend("community.sync_error", {
      tier: "B",
      status: res.statusCode,
    });
    return { fetched: 0, cached: true };
  }

  let parsed: TierBSignedPayload;
  try {
    parsed = JSON.parse(res.body) as TierBSignedPayload;
  } catch {
    process.stderr.write(`[community-sync] Tier B JSON parse failed; using cache.\n`);
    safeAppend("community.sync_error", { tier: "B", reason: "json_parse" });
    return { fetched: 0, cached: true };
  }

  if (!parsed || !Array.isArray(parsed.rules) || !parsed.signature) {
    process.stderr.write(
      `[community-sync] Tier B payload missing rules or signature; rejecting.\n`,
    );
    safeAppend("community.sync_error", { tier: "B", reason: "shape_invalid" });
    return { fetched: 0, cached: true };
  }

  // Verify the server's signature on its signable-payload field. We reuse
  // verifyLicenseSignature() rather than inventing a new envelope — the
  // server signs the same SignableLicensePayload shape it already signs
  // for /activate, so the public key + canonicalPayload are byte-identical.
  const verify = verifyLicenseSignature({
    ...parsed.signature_payload,
    signature: parsed.signature,
  });
  if (!verify.ok) {
    process.stderr.write(
      `[community-sync] Tier B signature rejected (${verify.reason}); discarding fetched rules.\n`,
    );
    safeAppend("community.sync_error", {
      tier: "B",
      reason: "signature_invalid",
      detail: verify.reason,
    });
    return { fetched: 0, cached: true };
  }

  // 🔒 LOCKED [COMMUNITY-SYNC-REPLAY-GUARD] — 2026-06-25
  // ⛔ NEVER trust a valid signature alone — also bind it to THIS request.
  //   The signed payload must reference OUR license token + OUR machine_id +
  //   a fresh timestamp. Without these checks, a Tier B response captured
  //   by any past PRO subscriber could be replayed against any other
  //   subscriber's machine indefinitely.
  // WHY: Round-1 verifier of workflow wy5qwwp1q flagged "no signature_payload
  //   binding — signed Tier-B blobs are replayable forever" as a blocking
  //   safety gap. This guard closes it.
  // FIX: If the server's payload schema changes (e.g. binds something other
  //   than license-token to signed responses), update BOTH the server's
  //   signResponsePayload AND this client guard in the same commit.
  const machineId = getMachineId();
  const sigP = parsed.signature_payload;
  if (sigP.key !== licenseToken) {
    process.stderr.write(
      `[community-sync] Tier B signature payload license-token mismatch; replay or wrong-customer response. Rejecting.\n`,
    );
    safeAppend("community.sync_error", {
      tier: "B",
      reason: "replay_license_mismatch",
    });
    return { fetched: 0, cached: true };
  }
  if (sigP.machineId !== machineId) {
    process.stderr.write(
      `[community-sync] Tier B signature payload machine-id mismatch; cross-machine replay attempt. Rejecting.\n`,
    );
    safeAppend("community.sync_error", {
      tier: "B",
      reason: "replay_machine_mismatch",
    });
    return { fetched: 0, cached: true };
  }
  // expiresAt must be in the future, AND within a 24h freshness window so
  // long-lived signed blobs can't be replayed weeks later. The server's
  // signResponsePayload should set expiresAt = now + 24h; we enforce that
  // ceiling here.
  const now = Date.now();
  const expiresAtMs = Date.parse(sigP.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < now) {
    process.stderr.write(
      `[community-sync] Tier B signature expired (${sigP.expiresAt}); discarding fetched rules.\n`,
    );
    safeAppend("community.sync_error", {
      tier: "B",
      reason: "signature_expired",
    });
    return { fetched: 0, cached: true };
  }
  if (expiresAtMs - now > 36 * 60 * 60 * 1000) {
    // > 36h ahead = server is over-issuing or the response is a replay
    // from a past server config. Reject — keeps the replay window small.
    process.stderr.write(
      `[community-sync] Tier B signature expires too far in the future (${sigP.expiresAt}); rejecting.\n`,
    );
    safeAppend("community.sync_error", {
      tier: "B",
      reason: "signature_freshness_violation",
    });
    return { fetched: 0, cached: true };
  }

  const fresh = normalizeIncoming("tier-B-pro", parsed.rules);
  const merged = mergeRules(store, "tier-B-pro", fresh);

  const etag = readEtag(res.headers);
  if (etag) merged.source_tier_b_etag = etag;

  saveCommunityStore(merged);
  safeAppend("community.sync_ok", { tier: "B", fetched: fresh.length });
  return { fetched: fresh.length, cached: false };
}

// ---------------------------------------------------------------------------
// Combined sync
// ---------------------------------------------------------------------------

export interface SyncAllResult {
  tierA: SyncResult;
  tierB: SyncResult | null;
}

/**
 * Resolve a license token from the activation store. Returns null if the
 * user has no license loaded (free user). We deliberately avoid throwing
 * here so the caller can skip Tier B gracefully.
 */
function resolveLicenseToken(): string | null {
  try {
    // Lazy import — keeps community-sync.ts importable in tests without
    // dragging the full activation surface.
    const licenseFile = join(homedir(), ".contextengine", "license.json");
    if (!existsSync(licenseFile)) return null;
    const data = JSON.parse(readFileSync(licenseFile, "utf-8"));
    return typeof data.key === "string" && data.key.length > 0
      ? data.key
      : null;
  } catch {
    return null;
  }
}

export async function syncAll(
  opts: { force?: boolean } = {},
): Promise<SyncAllResult> {
  const tierA = await syncTierA(opts);

  const token = resolveLicenseToken();
  if (!token) {
    process.stderr.write(
      `[community-sync] Tier B skipped: no license loaded (free tier). ` +
        `Activate Pro to receive curated community rules: ` +
        `https://api.compr.ch/contextengine/pricing\n`,
    );
    return { tierA, tierB: null };
  }

  const tierB = await syncTierB(token, opts);
  return { tierA, tierB };
}

// ---------------------------------------------------------------------------
// Chunk integration — feed the search pipeline
// ---------------------------------------------------------------------------

/**
 * Convert the community store into Chunks shaped exactly like
 * learningsToChunks() so search.ts can index them through the same
 * BM25 / vector pipeline.
 *
 * Each chunk's `section` is prefixed with "[community:tier-A]" /
 * "[community:tier-B]" so the UI can render a "(community)" badge by
 * pattern-matching the section, and so duplicate detection against the
 * local Learnings Store doesn't merge identical-looking content.
 */
export function communityRulesToChunks(): Chunk[] {
  const store = loadCommunityStore();
  return store.rules.map((r) => {
    const tierBadge = r.source === "tier-A-public" ? "tier-A" : "tier-B";
    return {
      source: `🌐 Community Rules (${tierBadge})`,
      section: `[community:${tierBadge}] [${r.category}] ${r.rule}`,
      content: [
        `**Rule:** ${r.rule}`,
        `**Category:** ${r.category}`,
        `**Source:** community / ${r.source}`,
        r.context ? `**Context:** ${r.context}` : "",
        r.tags?.length ? `**Tags:** ${r.tags.join(", ")}` : "",
        r.project_cluster ? `**Project cluster:** ${r.project_cluster}` : "",
        `_Fetched: ${r.fetched_at.split("T")[0]}_`,
      ]
        .filter(Boolean)
        .join("\n"),
      lineStart: 0,
      lineEnd: 0,
      indexedAt: r.fetched_at,
    };
  });
}

/**
 * Deduplicate a chunk list against the community chunks by SHA-256 of
 * the rule content. The local Learnings Store wins (we drop the
 * community chunk that matches). Use this where the engine combines
 * local + community chunks into one search corpus.
 */
export function mergeWithDedup(localChunks: Chunk[], communityChunks: Chunk[]): Chunk[] {
  if (communityChunks.length === 0) return localChunks;

  const localHashes = new Set<string>();
  for (const c of localChunks) {
    const ruleLine = extractRuleLine(c.content);
    if (ruleLine) localHashes.add(hashContent(ruleLine));
  }

  const filtered: Chunk[] = [];
  for (const c of communityChunks) {
    const ruleLine = extractRuleLine(c.content);
    if (ruleLine && localHashes.has(hashContent(ruleLine))) continue;
    filtered.push(c);
  }

  return [...localChunks, ...filtered];
}

function extractRuleLine(content: string): string | null {
  // Both learningsToChunks and communityRulesToChunks render "**Rule:** ..."
  const m = content.match(/\*\*Rule:\*\*\s*(.+)/);
  if (!m) return null;
  return m[1].trim().toLowerCase();
}

function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

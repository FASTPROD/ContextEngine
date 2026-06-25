// 🔒 LOCKED [COMMUNITY-RULES-SERVER] — 2026-06-24
// ⛔ NEVER change canonicalSerialize() without making the IDENTICAL change
//    on the client-side verifier in src/community-sync.ts. The signature
//    covers exactly the bytes this function produces; any drift breaks
//    every signed response.
// ⛔ NEVER return community-rules data without a signature. Free-tier
//    licenses MUST receive 403, not a stripped-down corpus — silently
//    degrading entitlement leaks revenue.
// ⛔ NEVER widen the auth contract beyond what /heartbeat already enforces
//    (license-token lookup + active activation). Reusing that one helper
//    set is the WHOLE point — divergence is how forged-license bugs are
//    born. See LICENSE-SIG-SERVER LOCK in license-sig.ts.
// WHY: PRO-tier "shared learnings" benefit. Tier B = the curated corpus
//    we ship to paying subscribers. Server signs every response so the
//    client can detect corpus tampering in transit / on disk.
//
// Tier B community rules server — handler + helpers.
//
// Pairs with the client-side shape in src/community-sync.ts (sync side).
// Schema:
//   {
//     version: 1,
//     generated_at: ISO string,
//     count: number,
//     rules: ExportedRule[],
//     signature: base64 Ed25519 sig over canonicalSerialize(envelope)
//   }

import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import Database from "better-sqlite3";
import { existsSync, readFileSync, statSync } from "fs";
import { sign, KeyObject } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types — kept byte-identical (modulo the signature wrapper) to the client
// CommunityStore shape consumed by src/community-sync.ts.
// ---------------------------------------------------------------------------

export interface ExportedRule {
  id: string;
  category: string;
  rule: string;
  context: string;
  tags: string[];
  project_cluster: string | null;
}

export interface CommunityRulesEnvelope {
  version: 1;
  generated_at: string; // ISO-8601
  count: number;
  rules: ExportedRule[];
}

export interface SignedCommunityRulesResponse extends CommunityRulesEnvelope {
  signature: string; // base64 Ed25519 over canonicalSerialize(envelope)
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_DATA_PATH = join(__dirname, "..", "data", "community-rules-tier-b.json");

function currentDataPath(): string {
  // Read lazily on every call so test fixtures (and ops swaps) can change
  // the path without restarting the process. Cache invalidation keys off
  // the file's mtime (below), so swapping paths is also caught.
  return process.env.COMMUNITY_RULES_TIER_B_PATH || DEFAULT_DATA_PATH;
}

// In-memory cache. Re-read when the file mtime OR path changes (cheap stat)
// so maintainers can edit the JSON without restarting the server, but the
// hot path doesn't touch the filesystem on every request. Path is part of
// the key so swapping the env var (e.g. in tests / blue-green rotation)
// invalidates immediately.
let _cache: { path: string; mtimeMs: number; rules: ExportedRule[] } | null = null;

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function validateRule(r: unknown, idx: number): ExportedRule {
  if (!r || typeof r !== "object") {
    throw new Error(`rules[${idx}] is not an object`);
  }
  const obj = r as Record<string, unknown>;
  const requireString = (field: string): string => {
    const v = obj[field];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`rules[${idx}].${field} must be a non-empty string`);
    }
    return v;
  };
  const id = requireString("id");
  const category = requireString("category");
  const rule = requireString("rule");
  const context = requireString("context");
  if (rule.length < 15) {
    throw new Error(`rules[${idx}].rule too short (min 15 chars): ${id}`);
  }
  if (!Array.isArray(obj.tags) || !obj.tags.every((t) => typeof t === "string")) {
    throw new Error(`rules[${idx}].tags must be an array of strings`);
  }
  const project_cluster = obj.project_cluster;
  if (project_cluster !== null && typeof project_cluster !== "string") {
    throw new Error(`rules[${idx}].project_cluster must be string or null`);
  }
  return {
    id,
    category,
    rule,
    context,
    tags: obj.tags as string[],
    project_cluster: (project_cluster as string | null) ?? null,
  };
}

/**
 * Read + validate the Tier B JSON file. Throws clearly on corruption so the
 * route handler can log + return 500 (without echoing detail to the client).
 */
export function loadCommunityRules(): ExportedRule[] {
  const dataPath = currentDataPath();
  if (!existsSync(dataPath)) {
    throw new Error(`community-rules data file not found: ${dataPath}`);
  }
  const stat = statSync(dataPath);
  if (_cache && _cache.path === dataPath && _cache.mtimeMs === stat.mtimeMs) {
    return _cache.rules;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(dataPath, "utf-8"));
  } catch (e) {
    throw new Error(
      `community-rules JSON parse error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("community-rules JSON root is not an object");
  }
  const root = parsed as Record<string, unknown>;
  if (root.version !== 1) {
    throw new Error(`community-rules unsupported version: ${String(root.version)} (expected 1)`);
  }
  if (!Array.isArray(root.rules)) {
    throw new Error("community-rules .rules must be an array");
  }
  const rules = root.rules.map((r, i) => validateRule(r, i));
  if (typeof root.count === "number" && root.count !== rules.length) {
    throw new Error(`community-rules .count (${root.count}) != rules.length (${rules.length})`);
  }
  // Dedupe id check — id collisions would corrupt client-side dedup.
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) throw new Error(`community-rules duplicate id: ${r.id}`);
    seen.add(r.id);
  }

  _cache = { path: dataPath, mtimeMs: stat.mtimeMs, rules };
  return rules;
}

/** Test-only: clear the cache so tests can swap fixtures without process restart. */
export function _resetCommunityRulesCache(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// Canonical serialization — MUST stay byte-identical to the client verifier.
//
// JSON.stringify in V8 is order-preserving for plain objects, so the order
// we WRITE keys here is the order they SERIALIZE in. Locked: version,
// generated_at, count, rules. Inside each rule: id, category, rule, context,
// tags, project_cluster.
// ---------------------------------------------------------------------------

export function canonicalSerialize(env: CommunityRulesEnvelope): string {
  return JSON.stringify({
    version: env.version,
    generated_at: env.generated_at,
    count: env.count,
    rules: env.rules.map((r) => ({
      id: r.id,
      category: r.category,
      rule: r.rule,
      context: r.context,
      tags: r.tags,
      project_cluster: r.project_cluster,
    })),
  });
}

/**
 * Sign the envelope with the SAME Ed25519 private key used for license
 * signatures. Reusing one key keeps the trust root small — the client
 * only ever has to pin one public key.
 */
export function signResponsePayload(
  payload: CommunityRulesEnvelope,
  privateKey: KeyObject,
): string {
  const bytes = Buffer.from(canonicalSerialize(payload));
  return sign(null, bytes, privateKey).toString("base64");
}

// ---------------------------------------------------------------------------
// Auth helpers — MUST mirror /heartbeat. Do not invent a new flow.
// ---------------------------------------------------------------------------

interface LicenseRow {
  id: number;
  key: string;
  email: string;
  plan: string;
  max_machines: number;
  expires_at: string;
  is_active: number;
}

interface ActivationRow {
  id: number;
  license_id: number;
  machine_id: string;
  is_revoked: number;
}

/** Plans entitled to the Tier B community-rules feed. */
const PRO_OR_HIGHER_PLANS = new Set(["pro", "team", "enterprise"]);

function isEntitled(plan: string): boolean {
  return PRO_OR_HIGHER_PLANS.has(plan.toLowerCase());
}

// ---------------------------------------------------------------------------
// Route mounting
// ---------------------------------------------------------------------------

export interface MountOptions {
  db: Database.Database;
  privateKey: KeyObject;
  /** Optional audit logger from the parent server. */
  logAudit?: (
    event: string,
    licenseKey: string | null,
    machineId: string | null,
    ip: string,
    details: string,
  ) => void;
  /** Override rate limiter for tests. */
  rateLimiter?: ReturnType<typeof rateLimit>;
}

/**
 * Returns an Express Router with POST /contextengine/community-rules/fetch
 * mounted. Mount it on the main app AFTER /heartbeat and BEFORE any 404
 * catch-all (see server.ts comment at the import site).
 */
export function createCommunityRulesRouter(opts: MountOptions): Router {
  const { db, privateKey, logAudit } = opts;
  const router = Router();

  const findLicense = db.prepare(
    "SELECT * FROM licenses WHERE key = ? AND is_active = 1",
  );
  const findActivation = db.prepare(
    "SELECT * FROM activations WHERE license_id = ? AND machine_id = ?",
  );

  // Default: 10 fetches / machine_id / day. Client respects ETag/304 so this
  // should never bite a well-behaved client. Keyed on machine_id (from the
  // body) rather than IP because PRO users behind a corporate NAT would
  // otherwise share quota.
  const defaultLimiter =
    opts.rateLimiter ||
    rateLimit({
      windowMs: 24 * 60 * 60 * 1000, // 1 day
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => {
        const mid = (req.body && typeof req.body.machine_id === "string"
          ? req.body.machine_id
          : "") as string;
        return mid || req.ip || "unknown";
      },
      message: {
        error: "Too many community-rules fetches. Try again tomorrow (limit: 10/day).",
      },
    });

  router.post(
    "/contextengine/community-rules/fetch",
    defaultLimiter,
    (req: Request, res: Response) => {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const audit = (event: string, key: string | null, mid: string | null, detail: string) => {
        if (logAudit) logAudit(event, key, mid, ip, detail);
      };

      try {
        const license_token =
          req.body && typeof req.body.license_token === "string"
            ? req.body.license_token
            : "";
        const machine_id =
          req.body && typeof req.body.machine_id === "string"
            ? req.body.machine_id
            : "";

        if (!license_token || !machine_id) {
          audit("community_rules_bad_request", license_token || null, machine_id || null, "Missing license_token or machine_id");
          return res
            .status(400)
            .json({ error: "Missing required fields: license_token, machine_id" });
        }

        // (1) license_token lookup — SAME query as /heartbeat
        const license = findLicense.get(license_token) as LicenseRow | undefined;
        if (!license) {
          audit("community_rules_invalid_license", license_token, machine_id, "");
          return res.status(401).json({ error: "Invalid license" });
        }

        // Expiry check — also matches /heartbeat
        if (new Date(license.expires_at) < new Date()) {
          audit("community_rules_expired", license_token, machine_id, "");
          return res.status(401).json({ error: "License expired" });
        }

        // (2) machine_id must match an ACTIVE activation for this license
        const activation = findActivation.get(license.id, machine_id) as
          | ActivationRow
          | undefined;
        if (!activation || activation.is_revoked) {
          audit("community_rules_no_activation", license_token, machine_id, "");
          return res.status(401).json({ error: "Machine not activated" });
        }

        // (3) entitlement: PRO or higher. Free / community tier → 403.
        if (!isEntitled(license.plan)) {
          audit(
            "community_rules_not_entitled",
            license_token,
            machine_id,
            `Plan: ${license.plan}`,
          );
          return res.status(403).json({
            error:
              "Tier B community rules require a PRO (or higher) plan. See https://api.compr.ch/contextengine/pricing.",
          });
        }

        // (4) Load + sign + return
        let rules: ExportedRule[];
        try {
          rules = loadCommunityRules();
        } catch (e) {
          console.error(
            "[community-rules] corpus load failed:",
            e instanceof Error ? e.message : String(e),
          );
          audit("community_rules_corpus_error", license_token, machine_id, "");
          return res.status(500).json({ error: "Internal server error" });
        }

        const envelope: CommunityRulesEnvelope = {
          version: 1,
          generated_at: new Date().toISOString(),
          count: rules.length,
          rules,
        };
        const signature = signResponsePayload(envelope, privateKey);
        const response: SignedCommunityRulesResponse = { ...envelope, signature };

        audit(
          "community_rules_fetch_ok",
          license_token,
          machine_id,
          `Plan: ${license.plan}, count: ${envelope.count}`,
        );
        return res.json(response);
      } catch (err) {
        console.error("[community-rules] handler error:", err);
        // Best-effort audit — don't let audit failures mask the 500.
        try {
          audit(
            "community_rules_error",
            req.body?.license_token || null,
            req.body?.machine_id || null,
            err instanceof Error ? err.message : String(err),
          );
        } catch {
          /* swallow */
        }
        return res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  return router;
}

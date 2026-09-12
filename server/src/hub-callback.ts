/**
 * Stripe Hub callback receiver for the ContextEngine activation server.
 *
 * The fleet's Stripe Hub (api.compr.ch/stripe-hub, repo `STRIPE backend`) owns the
 * Stripe integration. After a paid event it POSTs to the project's callback URL:
 *
 *   Stripe events:  { event_type, project_slug, data: <stripe object> }
 *   Crypto events:  { event: "crypto_payment.succeeded", project_slug, plan_slug,
 *                     customer_email, payment_method, crypto_*, fiat_* }
 *
 * The hub posts unsigned today (a bare fetch with a JSON body, hub finding 1).
 * The only proof of origin is the shared key in the callback URL. The
 * X-Hub-Signature path below is ready for the day the hub signs its callbacks
 * (hub decision 6); until then it is dormant unless HUB_CALLBACK_SECRET is set.
 *
 * Plan: docs/STRIPE_HUB_INTEGRATION_PLAN.md (section 4 step 2).
 * References: FC_project FC/routes/subscription.py [HUB_CALLBACK_ACTIVATES_TIER],
 *             admin.CROWLR StripeHubCallbackController [HUB_CALLBACK_ACTIVATES_PACKAGE].
 */

import express, { type Router, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createHmac, createHash, timingSafeEqual } from "crypto";
import type Database from "better-sqlite3";
import { provisionLicense, deactivateLicenseByStripe, sendLicenseEmail } from "./stripe.js";

export const HUB_PROJECT_SLUG = "contextengine";
const SIGNATURE_MAX_AGE_S = 5 * 60;

export interface HubCallbackOptions {
  db: Database.Database;
  logAudit: (event: string, licenseKey: string | null, machineId: string | null, ip: string, details: string) => void;
  /** Shared key expected as the `key` query parameter. Empty = not configured. */
  callbackKey?: string;
  /** HMAC secret for X-Hub-Signature. Empty = signature path disabled. */
  callbackSecret?: string;
  /** Injectable for tests. Defaults to the real SMTP sender. */
  sendEmail?: typeof sendLicenseEmail;
  /** Injectable clock for the signature timestamp window (unix seconds). */
  now?: () => number;
  rateLimiter?: express.RequestHandler;
}

export function ensureHubCallbackTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_callback_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      result TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(event_type, object_id)
    );
  `);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` */
export function verifyHubSignature(
  header: string,
  rawBody: Buffer,
  hmacKey: string,
  nowSeconds: number,
): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return i < 0 ? [kv.trim(), ""] : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  ) as Record<string, string>;
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1 || !/^\d+$/.test(t)) return false;
  if (Math.abs(nowSeconds - Number(t)) > SIGNATURE_MAX_AGE_S) return false;
  const expected = createHmac("sha256", hmacKey)
    .update(`${t}.`)
    .update(rawBody)
    .digest("hex");
  return safeEqual(expected, v1.toLowerCase());
}

export function planKeyFromSlug(slug: unknown): string | null {
  if (typeof slug !== "string" || !slug) return null;
  return slug.replace(/-/g, "_");
}

export function createHubCallbackRouter(opts: HubCallbackOptions): Router {
  const { db, logAudit } = opts;
  const sendEmail = opts.sendEmail || sendLicenseEmail;
  const now = opts.now || (() => Math.floor(Date.now() / 1000));
  ensureHubCallbackTable(db);

  const seen = db.prepare("SELECT id FROM hub_callback_events WHERE event_type = ? AND object_id = ?");
  const record = db.prepare("INSERT OR IGNORE INTO hub_callback_events (event_type, object_id, result) VALUES (?, ?, ?)");

  const limiter =
    opts.rateLimiter ||
    rateLimit({
      windowMs: 60 * 1000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
      // [LOCK] [LIMITER-IPV6-KEY] same fix as community-rules-server.ts
      keyGenerator: (req) => (req.ip ? ipKeyGenerator(req.ip) : "unknown"),
      message: { ok: false, error: "Too many requests" },
    });

  const router = express.Router();

  // [LOCKED] [HUB_CALLBACK_ACTIVATES_LICENSE] 2026-09-12
  // [NEVER] mount this route after express.json(), accept it without key or signature,
  //         or widen it beyond the four event shapes below.
  // WHY: the hub posts paid events unsigned; the key in the callback URL (mirrored in
  //      HUB_CALLBACK_KEY on crowlr2) is the only proof of origin. express.raw here keeps
  //      the exact bytes for the HMAC path; a JSON parser upstream would consume them and
  //      every signed callback would fail forever. Without this receiver a hub checkout
  //      takes the money and provisions nothing (hub project callback URL was empty).
  // FIX: constant-time compares; 503 when nothing is configured so a misdeploy is loud;
  //      one row per (event_type, object id) so a hub resend cannot double-extend a licence;
  //      an unknown plan answers 200 and audits, because a 500 makes the hub retry a
  //      payload that can never succeed.
  router.post(
    "/contextengine/hub-callback",
    limiter,
    express.raw({ type: "*/*", limit: "256kb" }),
    (req: Request, res: Response) => {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const key = opts.callbackKey || "";
      const secret = opts.callbackSecret || "";

      if (!key && !secret) {
        logAudit("hub_callback_unconfigured", null, null, ip, "HUB_CALLBACK_KEY and HUB_CALLBACK_SECRET both empty");
        return res.status(503).json({ ok: false, error: "Callback not configured" });
      }

      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const givenKey = typeof req.query.key === "string" ? req.query.key : "";
      const sigHeader = req.headers["x-hub-signature"];
      const sig = typeof sigHeader === "string" ? sigHeader : "";

      const keyOk = !!key && !!givenKey && safeEqual(givenKey, key);
      const sigOk = !!secret && !!sig && verifyHubSignature(sig, rawBody, secret, now());
      if (!keyOk && !sigOk) {
        logAudit("hub_callback_forbidden", null, null, ip, `key=${givenKey ? "wrong" : "absent"} sig=${sig ? "invalid" : "absent"}`);
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      let payload: any;
      try {
        payload = JSON.parse(rawBody.toString("utf8") || "{}");
      } catch {
        logAudit("hub_callback_bad_json", null, null, ip, `${rawBody.length} bytes`);
        return res.status(400).json({ ok: false, error: "Invalid JSON" });
      }
      if (!payload || typeof payload !== "object") {
        return res.status(400).json({ ok: false, error: "Invalid JSON" });
      }

      const projectSlug = payload.project_slug;
      if (projectSlug !== undefined && projectSlug !== null && projectSlug !== HUB_PROJECT_SLUG) {
        logAudit("hub_callback_ignored", null, null, ip, `other project: ${String(projectSlug).slice(0, 64)}`);
        return res.json({ ok: true, ignored: "other project" });
      }

      const eventType: string = typeof payload.event_type === "string" ? payload.event_type
        : typeof payload.event === "string" ? payload.event : "";
      const data: any = payload.data && typeof payload.data === "object" ? payload.data : {};

      // Object id for idempotency. Crypto callbacks carry no id, so the raw body hash
      // stands in: a hub resend is byte-identical, a new payment differs (amounts, currency).
      let objectId: string | null = typeof data.id === "string" && data.id ? data.id : null;
      if (!objectId && eventType === "crypto_payment.succeeded") {
        objectId = "sha256:" + createHash("sha256").update(rawBody).digest("hex");
      }

      if (!eventType || !["checkout.session.completed", "customer.subscription.deleted",
        "invoice.payment_failed", "crypto_payment.succeeded"].includes(eventType)) {
        logAudit("hub_callback_ignored", null, null, ip, `unhandled event: ${eventType.slice(0, 64) || "(none)"}`);
        return res.json({ ok: true, ignored: "unhandled event" });
      }
      if (!objectId) {
        logAudit("hub_callback_ignored", null, null, ip, `${eventType}: no object id`);
        return res.json({ ok: true, ignored: "no object id" });
      }
      if (seen.get(eventType, objectId)) {
        logAudit("hub_callback_duplicate", null, null, ip, `${eventType} ${objectId}`);
        return res.json({ ok: true, duplicate: true });
      }

      let result: Record<string, unknown> = { ok: true };
      try {
        switch (eventType) {
          case "checkout.session.completed":
          case "crypto_payment.succeeded": {
            const isCrypto = eventType === "crypto_payment.succeeded";
            const planSlug = isCrypto ? payload.plan_slug : data.metadata?.plan_slug;
            const emailRaw = isCrypto
              ? payload.customer_email
              : (data.customer_details?.email || data.customer_email);
            const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
            const planKey = planKeyFromSlug(planSlug);
            const customerId = !isCrypto && typeof data.customer === "string" ? data.customer : undefined;
            const subscriptionId = !isCrypto && typeof data.subscription === "string" ? data.subscription : undefined;
            const clientRef = !isCrypto && typeof data.client_reference_id === "string" ? data.client_reference_id : "";

            if (!email || !planKey) {
              logAudit("hub_callback_missing_data", null, null, ip,
                `${eventType} ${objectId}: email=${email ? "ok" : "absent"} plan_slug=${String(planSlug ?? "absent")}`);
              result = { ok: true, ignored: "missing email or plan_slug" };
              break;
            }

            let provisioned;
            try {
              provisioned = provisionLicense(db, email, planKey, customerId, subscriptionId);
            } catch (err) {
              // Unknown plan slug: the hub catalogue and PLAN_CONFIG disagree. Answer 200,
              // never 500: the hub cannot fix this by retrying. The audit row is the alarm.
              logAudit("hub_callback_unknown_plan", null, null, ip,
                `${eventType} ${objectId}: ${(err as Error).message} (email ${email})`);
              result = { ok: true, ignored: "unknown plan" };
              break;
            }

            logAudit("hub_license_provisioned", provisioned.key, null, ip,
              `Plan: ${provisioned.plan}, Email: ${email}, Sub: ${subscriptionId || "n/a"}, ` +
              `Ref: ${clientRef || "n/a"}, Via: ${isCrypto ? "crypto" : "stripe"}, Event: ${objectId}`);
            sendEmail(email, provisioned.key, provisioned.plan, provisioned.expiresAt).catch((err) =>
              console.error("Failed to send license email:", err),
            );
            console.log(`✅ [hub] License provisioned: ${provisioned.key} → ${email} (${provisioned.plan})`);
            result = { ok: true, plan: provisioned.plan, expiresAt: provisioned.expiresAt };
            break;
          }

          case "customer.subscription.deleted": {
            const deactivated = deactivateLicenseByStripe(db, objectId);
            logAudit("hub_subscription_deleted", null, null, ip, `Sub: ${objectId}, Deactivated: ${deactivated}`);
            console.log(`🔴 [hub] Subscription canceled: ${objectId}, license deactivated: ${deactivated}`);
            result = deactivated ? { ok: true, deactivated: true } : { ok: true, ignored: "unknown subscription" };
            break;
          }

          case "invoice.payment_failed": {
            const sub = typeof data.subscription === "string" ? data.subscription : "n/a";
            const customer = typeof data.customer === "string" ? data.customer : "n/a";
            console.warn(`⚠ [hub] Payment failed: invoice ${objectId}, customer ${customer}, sub ${sub}`);
            logAudit("hub_payment_failed", null, null, ip, `Invoice: ${objectId}, Customer: ${customer}, Sub: ${sub}`);
            result = { ok: true, recorded: true };
            break;
          }
        }
      } catch (err) {
        logAudit("hub_callback_error", null, null, ip, `${eventType} ${objectId}: ${(err as Error).message}`);
        console.error("[hub] callback error:", err);
        return res.status(500).json({ ok: false, error: "Internal error" });
      }

      record.run(eventType, objectId, JSON.stringify(result));
      return res.json(result);
    },
  );

  return router;
}

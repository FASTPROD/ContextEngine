/**
 * Tests for the Stripe Hub callback receiver (POST /contextengine/hub-callback).
 *
 * In-memory SQLite, an in-process Express app with the router mounted the way
 * server.ts mounts it (before express.json), Node's fetch against the listener.
 * The licence email sender is stubbed; nothing leaves the process.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import Database from "better-sqlite3";
import { createHmac } from "crypto";
import { AddressInfo } from "net";
import { createHubCallbackRouter, verifyHubSignature, planKeyFromSlug } from "./hub-callback.js";

const KEY = "test-callback-key-0123456789abcdef";
const SIG_KEY = "hmac-key-for-tests";
const NOW = 1_800_000_000;

function buildDb(): Database.Database {
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
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      license_key TEXT,
      machine_id TEXT,
      ip TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

interface Harness {
  db: Database.Database;
  baseUrl: string;
  emails: Array<{ email: string; key: string; plan: string }>;
  close: () => Promise<void>;
}

async function startServer(opts: { key?: string; sig?: string }): Promise<Harness> {
  const db = buildDb();
  const emails: Harness["emails"] = [];
  const app = express();
  app.use(
    createHubCallbackRouter({
      db,
      callbackKey: opts.key,
      callbackSecret: opts.sig,
      now: () => NOW,
      logAudit: (event, key, machineId, ip, details) =>
        db.prepare("INSERT INTO audit_log (event, license_key, machine_id, ip, details) VALUES (?, ?, ?, ?, ?)")
          .run(event, key, machineId, ip, details),
      sendEmail: async (email, key, plan) => {
        emails.push({ email, key, plan });
        return true;
      },
    }),
  );
  // Mirrors server.ts: the JSON parser comes AFTER the raw-body route.
  app.use(express.json());
  const server = await new Promise<import("http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    db,
    emails,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => { db.close(); resolve(); })),
  };
}

function post(h: Harness, body: unknown, opts: { key?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const url = `${h.baseUrl}/contextengine/hub-callback${opts.key !== undefined ? `?key=${encodeURIComponent(opts.key)}` : ""}`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.raw ?? JSON.stringify(body),
  });
}

function sign(raw: string, t = NOW, sigKey = SIG_KEY): string {
  const v1 = createHmac("sha256", sigKey).update(`${t}.${raw}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

function checkoutEvent(over: Record<string, unknown> = {}) {
  return {
    event_type: "checkout.session.completed",
    project_slug: "contextengine",
    data: {
      id: "cs_test_001",
      customer: "cus_001",
      subscription: "sub_001",
      customer_details: { email: "Buyer@Example.com" },
      metadata: { project_slug: "contextengine", plan_slug: "pro-monthly" },
      ...over,
    },
  };
}

function audits(h: Harness, event: string) {
  return db(h).prepare("SELECT * FROM audit_log WHERE event = ?").all(event) as any[];
}
const db = (h: Harness) => h.db;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
describe("hub-callback auth", () => {
  let h: Harness;
  beforeAll(async () => { h = await startServer({ key: KEY, sig: SIG_KEY }); });
  afterAll(() => h.close());

  it("403 without a key", async () => {
    const res = await post(h, checkoutEvent());
    expect(res.status).toBe(403);
    expect(audits(h, "hub_callback_forbidden")).toHaveLength(1);
    expect(db(h).prepare("SELECT COUNT(*) c FROM licenses").get()).toEqual({ c: 0 });
  });

  it("403 with a wrong key, including a same-length one", async () => {
    expect((await post(h, checkoutEvent(), { key: "nope" })).status).toBe(403);
    expect((await post(h, checkoutEvent(), { key: KEY.slice(0, -1) + "X" })).status).toBe(403);
  });

  it("200 with the right key", async () => {
    const res = await post(h, checkoutEvent(), { key: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, plan: "pro" });
  });

  it("200 with a valid X-Hub-Signature and no key", async () => {
    const raw = JSON.stringify(checkoutEvent({ id: "cs_test_sig" }));
    const res = await post(h, null, { raw, headers: { "X-Hub-Signature": sign(raw) } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, plan: "pro" });
  });

  it("403 with a signature over a different body", async () => {
    const raw = JSON.stringify(checkoutEvent({ id: "cs_test_sig2" }));
    const res = await post(h, null, { raw, headers: { "X-Hub-Signature": sign(raw + " ") } });
    expect(res.status).toBe(403);
  });

  it("403 with a stale signature (older than 5 minutes)", async () => {
    const raw = JSON.stringify(checkoutEvent({ id: "cs_test_sig3" }));
    const res = await post(h, null, { raw, headers: { "X-Hub-Signature": sign(raw, NOW - 301) } });
    expect(res.status).toBe(403);
  });

  it("403 with a signature from the wrong secret", async () => {
    const raw = JSON.stringify(checkoutEvent({ id: "cs_test_sig4" }));
    const res = await post(h, null, { raw, headers: { "X-Hub-Signature": sign(raw, NOW, "other") } });
    expect(res.status).toBe(403);
  });
});

describe("hub-callback unconfigured", () => {
  it("503 when neither key nor secret is set, and nothing is written", async () => {
    const h = await startServer({});
    try {
      const res = await post(h, checkoutEvent(), { key: "anything" });
      expect(res.status).toBe(503);
      expect(audits(h, "hub_callback_unconfigured")).toHaveLength(1);
      expect(db(h).prepare("SELECT COUNT(*) c FROM licenses").get()).toEqual({ c: 0 });
    } finally {
      await h.close();
    }
  });

  it("key-only config refuses a signed request without key (signature path off)", async () => {
    const h = await startServer({ key: KEY });
    try {
      const raw = JSON.stringify(checkoutEvent());
      const res = await post(h, null, { raw, headers: { "X-Hub-Signature": sign(raw) } });
      expect(res.status).toBe(403);
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Event shapes
// ---------------------------------------------------------------------------
describe("hub-callback events", () => {
  let h: Harness;
  beforeEach(async () => { h = await startServer({ key: KEY }); });
  afterEach(async () => { await h.close(); });

  it("checkout.session.completed provisions a licence, maps the subscription, mails the key", async () => {
    const res = await post(h, checkoutEvent(), { key: KEY });
    expect(res.status).toBe(200);
    const lic = db(h).prepare("SELECT * FROM licenses").all() as any[];
    expect(lic).toHaveLength(1);
    expect(lic[0]).toMatchObject({ email: "buyer@example.com", plan: "pro", max_machines: 2, is_active: 1 });
    expect(lic[0].key).toMatch(/^CE-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    const map = db(h).prepare("SELECT * FROM stripe_mapping").all() as any[];
    expect(map).toHaveLength(1);
    expect(map[0]).toMatchObject({ license_id: lic[0].id, stripe_customer_id: "cus_001", stripe_subscription_id: "sub_001" });
    expect(h.emails).toEqual([{ email: "buyer@example.com", key: lic[0].key, plan: "pro" }]);
    const a = audits(h, "hub_license_provisioned");
    expect(a).toHaveLength(1);
    expect(a[0].license_key).toBe(lic[0].key);
    expect(db(h).prepare("SELECT event_type, object_id FROM hub_callback_events").all())
      .toEqual([{ event_type: "checkout.session.completed", object_id: "cs_test_001" }]);
  });

  it("annual and team slugs map to PLAN_CONFIG (machines and months)", async () => {
    await post(h, checkoutEvent({ id: "cs_a", metadata: { plan_slug: "team-annual" }, customer_details: { email: "t@x.ch" } }), { key: KEY });
    const lic = db(h).prepare("SELECT * FROM licenses WHERE email = 't@x.ch'").get() as any;
    expect(lic).toMatchObject({ plan: "team", max_machines: 5 });
    const months = (new Date(lic.expires_at).getTime() - Date.now()) / (30 * 24 * 3600 * 1000);
    expect(months).toBeGreaterThan(11);
    expect(months).toBeLessThan(13);
  });

  it("falls back to customer_email and records client_reference_id", async () => {
    const res = await post(h, checkoutEvent({
      id: "cs_b", customer_details: null, customer_email: "fallback@x.ch", client_reference_id: "ref-42",
    }), { key: KEY });
    expect(res.status).toBe(200);
    expect(db(h).prepare("SELECT email FROM licenses").get()).toEqual({ email: "fallback@x.ch" });
    expect(audits(h, "hub_license_provisioned")[0].details).toContain("Ref: ref-42");
  });

  it("a repeat of the same event answers 200 and does nothing", async () => {
    await post(h, checkoutEvent(), { key: KEY });
    const res = await post(h, checkoutEvent(), { key: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(db(h).prepare("SELECT COUNT(*) c FROM licenses").get()).toEqual({ c: 1 });
    expect(h.emails).toHaveLength(1);
    expect(audits(h, "hub_callback_duplicate")).toHaveLength(1);
  });

  it("an unknown plan slug answers 200, audits, provisions nothing", async () => {
    const res = await post(h, checkoutEvent({ id: "cs_u", metadata: { plan_slug: "gold-lifetime" } }), { key: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "unknown plan" });
    expect(db(h).prepare("SELECT COUNT(*) c FROM licenses").get()).toEqual({ c: 0 });
    expect(h.emails).toHaveLength(0);
    const a = audits(h, "hub_callback_unknown_plan");
    expect(a).toHaveLength(1);
    expect(a[0].details).toContain("gold_lifetime");
  });

  it("missing email answers 200 and audits", async () => {
    const res = await post(h, checkoutEvent({ id: "cs_m", customer_details: {}, customer_email: null }), { key: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "missing email or plan_slug" });
    expect(audits(h, "hub_callback_missing_data")).toHaveLength(1);
  });

  it("customer.subscription.deleted deactivates the mapped licence", async () => {
    await post(h, checkoutEvent(), { key: KEY });
    const res = await post(h, {
      event_type: "customer.subscription.deleted",
      project_slug: "contextengine",
      data: { id: "sub_001", customer: "cus_001", status: "canceled" },
    }, { key: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deactivated: true });
    expect(db(h).prepare("SELECT is_active FROM licenses").get()).toEqual({ is_active: 0 });
    expect(audits(h, "hub_subscription_deleted")).toHaveLength(1);
  });

  it("customer.subscription.deleted for an unknown subscription is a no-op 200", async () => {
    const res = await post(h, {
      event_type: "customer.subscription.deleted", project_slug: "contextengine", data: { id: "sub_ghost" },
    }, { key: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "unknown subscription" });
  });

  it("invoice.payment_failed writes an audit row only", async () => {
    const res = await post(h, {
      event_type: "invoice.payment_failed", project_slug: "contextengine",
      data: { id: "in_001", customer: "cus_001", subscription: "sub_001" },
    }, { key: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: true });
    const a = audits(h, "hub_payment_failed");
    expect(a).toHaveLength(1);
    expect(a[0].details).toBe("Invoice: in_001, Customer: cus_001, Sub: sub_001");
    expect(db(h).prepare("SELECT COUNT(*) c FROM licenses").get()).toEqual({ c: 0 });
  });

  it("crypto_payment.succeeded provisions from plan_slug and customer_email, dedups a resend", async () => {
    const body = {
      event: "crypto_payment.succeeded", project_slug: "contextengine", plan_slug: "enterprise-annual",
      customer_email: "crypto@x.ch", payment_method: "crypto", crypto_currency: "btc",
      crypto_amount: 0.001, fiat_amount: 360, fiat_currency: "chf",
    };
    const res = await post(h, body, { key: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, plan: "enterprise" });
    expect(db(h).prepare("SELECT plan, max_machines FROM licenses").get()).toEqual({ plan: "enterprise", max_machines: 10 });
    expect(h.emails).toHaveLength(1);
    expect(db(h).prepare("SELECT COUNT(*) c FROM stripe_mapping").get()).toEqual({ c: 1 });
    const again = await post(h, body, { key: KEY });
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(h.emails).toHaveLength(1);
  });

  it("another project's event is ignored", async () => {
    const res = await post(h, { ...checkoutEvent(), project_slug: "invocme" }, { key: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "other project" });
    expect(db(h).prepare("SELECT COUNT(*) c FROM licenses").get()).toEqual({ c: 0 });
  });

  it("an unhandled event type is ignored with 200", async () => {
    const res = await post(h, { event_type: "customer.subscription.updated", project_slug: "contextengine", data: { id: "sub_001" } }, { key: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "unhandled event" });
  });

  it("invalid JSON is a 400 (after auth)", async () => {
    const res = await post(h, null, { key: KEY, raw: "{not json" });
    expect(res.status).toBe(400);
    expect(audits(h, "hub_callback_bad_json")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe("hub-callback helpers", () => {
  it("planKeyFromSlug maps hub slugs to PLAN_CONFIG keys", () => {
    expect(planKeyFromSlug("pro-monthly")).toBe("pro_monthly");
    expect(planKeyFromSlug("enterprise-annual")).toBe("enterprise_annual");
    expect(planKeyFromSlug("")).toBeNull();
    expect(planKeyFromSlug(undefined)).toBeNull();
    expect(planKeyFromSlug(42)).toBeNull();
  });

  it("verifyHubSignature rejects malformed headers", () => {
    const raw = Buffer.from("{}");
    expect(verifyHubSignature("", raw, SIG_KEY, NOW)).toBe(false);
    expect(verifyHubSignature("v1=abc", raw, SIG_KEY, NOW)).toBe(false);
    expect(verifyHubSignature("t=abc,v1=abc", raw, SIG_KEY, NOW)).toBe(false);
    expect(verifyHubSignature(`t=${NOW}`, raw, SIG_KEY, NOW)).toBe(false);
    expect(verifyHubSignature(sign("{}"), raw, SIG_KEY, NOW)).toBe(true);
    expect(verifyHubSignature(sign("{}").toUpperCase().replace("T=", "t=").replace("V1=", "v1="), raw, SIG_KEY, NOW)).toBe(true);
  });
});

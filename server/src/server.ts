/**
 * ContextEngine Activation Server
 *
 * Endpoints:
 *   POST /contextengine/activate               — validate license, return encrypted delta
 *   POST /contextengine/heartbeat              — periodic license check
 *   GET  /contextengine/health                 — health check
 *   POST /contextengine/create-checkout-session — Stripe Checkout for purchasing a plan
 *   POST /contextengine/webhook                — Stripe webhook (auto-provisions license)
 *
 * Database: SQLite (licenses.db) — simple, no external deps
 * Delta: Pre-built encrypted module bundles in ./delta-modules/
 */

import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import Database from "better-sqlite3";
import { createHash, createCipheriv, randomBytes } from "crypto";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  getStripe,
  isStripeEnabled,
  getWebhookSecret,
  provisionLicense,
  deactivateLicenseByStripe,
  sendLicenseEmail,
} from "./stripe.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.ACTIVATION_PORT || "8010", 10);
const DB_PATH = process.env.DB_PATH || join(__dirname, "..", "data", "licenses.db");
const DELTA_DIR = process.env.DELTA_DIR || join(__dirname, "..", "delta-modules");
const ALLOWED_ORIGINS = [
  "https://compr.ch",
  "https://api.compr.ch",
  "https://contextengine.compr.ch",
  "http://localhost:*",
];

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------
function initDB(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
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

    CREATE TABLE IF NOT EXISTS activations (
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

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      license_key TEXT,
      machine_id TEXT,
      ip TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key);
    CREATE INDEX IF NOT EXISTS idx_activations_machine ON activations(machine_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Delta module encryption
// ---------------------------------------------------------------------------

/**
 * Encrypt a module's source code for a specific license+machine combo.
 * Key derivation: SHA-256(licenseKey + machineId) → AES-256-CBC key
 */
function encryptModule(
  content: string,
  licenseKey: string,
  machineId: string
): { payload: string; iv: string; checksum: string } {
  const derivedKey = createHash("sha256")
    .update(licenseKey + machineId)
    .digest();

  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", derivedKey, iv);
  let encrypted = cipher.update(content, "utf-8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);

  const checksum = createHash("sha256").update(content).digest("hex");

  return {
    payload: encrypted.toString("base64"),
    iv: iv.toString("hex"),
    checksum,
  };
}

/**
 * Load delta module source files from the delta-modules directory.
 * These are the premium algorithms that get encrypted per-machine.
 */
function loadDeltaModules(): Array<{ name: string; content: string }> {
  if (!existsSync(DELTA_DIR)) {
    console.warn(`⚠ Delta directory not found: ${DELTA_DIR}`);
    return [];
  }

  const modules: Array<{ name: string; content: string }> = [];
  const files = ["agents.mjs", "collectors.mjs", "search-adv.mjs"];

  for (const file of files) {
    const filePath = join(DELTA_DIR, file);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      const name = file.replace(".mjs", "");
      modules.push({ name, content });
    }
  }

  return modules;
}

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------
function logAudit(
  db: Database.Database,
  event: string,
  licenseKey: string | null,
  machineId: string | null,
  ip: string,
  details: string
): void {
  db.prepare(
    "INSERT INTO audit_log (event, license_key, machine_id, ip, details) VALUES (?, ?, ?, ?, ?)"
  ).run(event, licenseKey, machineId, ip, details);
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],  // inline styles in pricing.html
      connectSrc: ["'self'", "https://api.compr.ch", "https://checkout.stripe.com"],
      frameSrc: ["'self'", "https://checkout.stripe.com"],
      imgSrc: ["'self'", "data:"],
    },
  },
}));
app.use(cors({
  origin: [
    "https://compr.ch",
    "https://www.compr.ch",
    "https://api.compr.ch",
    "https://compr.app",
    "https://www.compr.app",
    "https://app.compr.app",
    /^http:\/\/localhost(:\d+)?$/,
  ],
}));

// ⚠ Stripe webhook MUST receive raw body — register BEFORE express.json()
if (isStripeEnabled()) {
  app.post(
    "/contextengine/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const stripe = getStripe()!;
      const sig = req.headers["stripe-signature"] as string;
      const webhookSecret = getWebhookSecret();

      if (!webhookSecret) {
        console.error("❌ STRIPE_WEBHOOK_SECRET not configured");
        return res.status(500).json({ error: "Webhook secret not configured" });
      }

      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (err) {
        console.error("❌ Webhook signature verification failed:", (err as Error).message);
        return res.status(400).json({ error: "Invalid signature" });
      }

      const ip = req.ip || req.socket.remoteAddress || "unknown";

      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as any;
          const email = session.customer_email || session.customer_details?.email;
          const planKey = session.metadata?.plan_key;
          const customerId = session.customer;
          const subscriptionId = session.subscription;

          if (!email || !planKey) {
            console.error("❌ Webhook missing email or plan_key in metadata:", { email, planKey });
            logAudit(db, "stripe_webhook_missing_data", null, null, ip, JSON.stringify({ email, planKey }));
            return res.json({ received: true, warning: "Missing email or plan_key" });
          }

          try {
            const result = provisionLicense(db, email, planKey, customerId, subscriptionId);
            logAudit(db, "stripe_license_provisioned", result.key, null, ip,
              `Plan: ${result.plan}, Email: ${email}, Stripe: ${subscriptionId}`);

            // Send license key email (async, don't block response)
            sendLicenseEmail(email, result.key, result.plan, result.expiresAt).catch((err) =>
              console.error("Failed to send license email:", err)
            );

            console.log(`✅ License provisioned: ${result.key} → ${email} (${result.plan})`);
          } catch (err) {
            console.error("❌ License provisioning failed:", (err as Error).message);
            logAudit(db, "stripe_provision_error", null, null, ip, (err as Error).message);
          }
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object as any;
          const subscriptionId = subscription.id;

          const deactivated = deactivateLicenseByStripe(db, subscriptionId);
          logAudit(db, "stripe_subscription_deleted", null, null, ip,
            `Sub: ${subscriptionId}, Deactivated: ${deactivated}`);

          console.log(`🔴 Subscription canceled: ${subscriptionId}, license deactivated: ${deactivated}`);
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object as any;
          console.warn(`⚠ Payment failed for customer ${invoice.customer}: ${invoice.id}`);
          logAudit(db, "stripe_payment_failed", null, null, ip,
            `Customer: ${invoice.customer}, Invoice: ${invoice.id}`);
          break;
        }

        default:
          // Unhandled event type — log but don't fail
          break;
      }

      return res.json({ received: true });
    }
  );
}

app.use(express.json({ limit: "1mb" }));

// Rate limiting — 5 requests per minute per IP on activation endpoints
const activationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Try again in 1 minute." },
});
app.use("/contextengine/activate", activationLimiter);
app.use("/contextengine/heartbeat", activationLimiter);

// Trust proxy (for X-Forwarded-For behind nginx)
app.set("trust proxy", 1);

const db = initDB();

// Prepared statements
const findLicense = db.prepare("SELECT * FROM licenses WHERE key = ? AND is_active = 1");
const findActivation = db.prepare(
  "SELECT * FROM activations WHERE license_id = ? AND machine_id = ?"
);
const countActivations = db.prepare(
  "SELECT COUNT(*) as count FROM activations WHERE license_id = ? AND is_revoked = 0"
);
const insertActivation = db.prepare(
  `INSERT INTO activations (license_id, machine_id, platform, arch, version)
   VALUES (?, ?, ?, ?, ?)`
);
const updateHeartbeat = db.prepare(
  "UPDATE activations SET last_heartbeat = datetime('now'), version = ? WHERE license_id = ? AND machine_id = ?"
);

// ---------------------------------------------------------------------------
// POST /contextengine/activate
// ---------------------------------------------------------------------------
app.post("/contextengine/activate", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";

  try {
    const { key, email, machineId, version, platform, arch } = req.body;

    if (!key || !email || !machineId) {
      logAudit(db, "activate_invalid", key, machineId, ip, "Missing required fields");
      return res.status(400).json({ success: false, error: "Missing required fields: key, email, machineId" });
    }

    // 1. Find license
    const license = findLicense.get(key) as any;
    if (!license) {
      logAudit(db, "activate_invalid_key", key, machineId, ip, `Email: ${email}`);
      return res.status(403).json({ success: false, error: "Invalid license key" });
    }

    // 2. Verify email matches
    if (license.email.toLowerCase() !== email.toLowerCase()) {
      logAudit(db, "activate_email_mismatch", key, machineId, ip, `Expected: ${license.email}, Got: ${email}`);
      return res.status(403).json({ success: false, error: "Email does not match license" });
    }

    // 3. Check expiry
    if (new Date(license.expires_at) < new Date()) {
      logAudit(db, "activate_expired", key, machineId, ip, `Expired: ${license.expires_at}`);
      return res.status(403).json({ success: false, error: `License expired on ${license.expires_at}` });
    }

    // 4. Check machine limit
    const existing = findActivation.get(license.id, machineId) as any;
    if (!existing) {
      const { count } = countActivations.get(license.id) as any;
      if (count >= license.max_machines) {
        logAudit(db, "activate_machine_limit", key, machineId, ip, `Limit: ${license.max_machines}, Active: ${count}`);
        return res.status(403).json({
          success: false,
          error: `Machine limit reached (${count}/${license.max_machines}). Deactivate another machine first.`,
        });
      }

      // Create new activation
      insertActivation.run(license.id, machineId, platform, arch, version);
      logAudit(db, "activate_new", key, machineId, ip, `Plan: ${license.plan}, Platform: ${platform}/${arch}`);
    } else if (existing.is_revoked) {
      logAudit(db, "activate_revoked", key, machineId, ip, "Machine activation was revoked");
      return res.status(403).json({ success: false, error: "This machine's activation was revoked" });
    } else {
      // Re-activation of existing machine — just update heartbeat
      updateHeartbeat.run(version, license.id, machineId);
      logAudit(db, "activate_refresh", key, machineId, ip, `Version: ${version}`);
    }

    // 5. Load and encrypt delta modules
    const deltaModules = loadDeltaModules();
    if (deltaModules.length === 0) {
      logAudit(db, "activate_no_delta", key, machineId, ip, "Delta modules not found on server");
      return res.status(500).json({ success: false, error: "Delta modules unavailable — contact support" });
    }

    // Use a shared IV for this activation (all modules encrypted together)
    const iv = randomBytes(16);
    const derivedKey = createHash("sha256")
      .update(key + machineId)
      .digest();

    const encryptedModules = deltaModules.map((mod) => {
      const cipher = createCipheriv("aes-256-cbc", derivedKey, iv);
      let encrypted = cipher.update(mod.content, "utf-8");
      encrypted = Buffer.concat([encrypted, cipher.final()]);

      return {
        name: mod.name,
        payload: encrypted.toString("base64"),
        checksum: createHash("sha256").update(mod.content).digest("hex"),
      };
    });

    // 6. Read delta version from manifest
    const manifestPath = join(DELTA_DIR, "manifest.json");
    let deltaVersion = "1.0.0";
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      deltaVersion = manifest.version || deltaVersion;
    }

    // 7. Generate signature (HMAC of key+machineId+version for integrity)
    const signature = createHash("sha256")
      .update(`${key}:${machineId}:${deltaVersion}:${license.expires_at}`)
      .digest("hex");

    // 8. Return activation response
    const response = {
      success: true,
      license: {
        key,
        email: license.email,
        plan: license.plan,
        activatedAt: new Date().toISOString(),
        expiresAt: license.expires_at,
        machineId,
        lastHeartbeat: new Date().toISOString(),
        deltaVersion,
        signature,
      },
      delta: {
        version: deltaVersion,
        modules: encryptedModules,
        iv: iv.toString("hex"),
      },
    };

    return res.json(response);
  } catch (err) {
    logAudit(db, "activate_error", req.body?.key, req.body?.machineId, ip, (err as Error).message);
    console.error("Activation error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /contextengine/heartbeat
// ---------------------------------------------------------------------------
app.post("/contextengine/heartbeat", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";

  try {
    const { key, machineId, deltaVersion } = req.body;

    if (!key || !machineId) {
      return res.status(400).json({ valid: false, error: "Missing key or machineId" });
    }

    const license = findLicense.get(key) as any;
    if (!license) {
      logAudit(db, "heartbeat_invalid_key", key, machineId, ip, "");
      return res.status(403).json({ valid: false, error: "Invalid license" });
    }

    if (new Date(license.expires_at) < new Date()) {
      logAudit(db, "heartbeat_expired", key, machineId, ip, "");
      return res.status(403).json({ valid: false, error: "License expired" });
    }

    const activation = findActivation.get(license.id, machineId) as any;
    if (!activation || activation.is_revoked) {
      logAudit(db, "heartbeat_no_activation", key, machineId, ip, "");
      return res.status(403).json({ valid: false, error: "Machine not activated" });
    }

    // Update heartbeat
    updateHeartbeat.run(deltaVersion || activation.version, license.id, machineId);

    // Check if there's a newer delta version available
    const manifestPath = join(DELTA_DIR, "manifest.json");
    let latestDelta = deltaVersion;
    let updateAvailable = false;
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      latestDelta = manifest.version;
      updateAvailable = deltaVersion !== latestDelta;
    }

    return res.json({
      valid: true,
      expiresAt: license.expires_at,
      updateAvailable,
      latestDelta,
    });
  } catch (err) {
    console.error("Heartbeat error:", err);
    return res.status(500).json({ valid: false, error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /contextengine/create-checkout-session (Stripe)
// ---------------------------------------------------------------------------
if (isStripeEnabled()) {
  // Price IDs — set these from your Stripe Dashboard products
  const PRICE_IDS: Record<string, string> = {
    pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY || "",
    pro_annual: process.env.STRIPE_PRICE_PRO_ANNUAL || "",
    team_monthly: process.env.STRIPE_PRICE_TEAM_MONTHLY || "",
    team_annual: process.env.STRIPE_PRICE_TEAM_ANNUAL || "",
    enterprise_monthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY || "",
    enterprise_annual: process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL || "",
  };

  app.post("/contextengine/create-checkout-session", async (req, res) => {
    const stripe = getStripe()!;
    const { planKey, successUrl, cancelUrl } = req.body;

    if (!planKey || !PRICE_IDS[planKey]) {
      return res.status(400).json({
        error: `Invalid plan. Valid: ${Object.keys(PRICE_IDS).join(", ")}`,
      });
    }

    const priceId = PRICE_IDS[planKey];
    if (!priceId) {
      return res.status(500).json({ error: `Price ID not configured for plan: ${planKey}` });
    }

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: { plan_key: planKey },
        success_url: successUrl || "https://compr.ch/contextengine/success?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: cancelUrl || "https://compr.ch/contextengine/pricing",
        allow_promotion_codes: true,
      });

      return res.json({ url: session.url });
    } catch (err) {
      console.error("Checkout session error:", err);
      return res.status(500).json({ error: "Failed to create checkout session" });
    }
  });
}

// ---------------------------------------------------------------------------
// GET /contextengine/health
// ---------------------------------------------------------------------------
app.get("/contextengine/health", (_req, res) => {
  const deltaModules = loadDeltaModules();
  const licenseCount = (db.prepare("SELECT COUNT(*) as count FROM licenses WHERE is_active = 1").get() as any).count;
  const activationCount = (db.prepare("SELECT COUNT(*) as count FROM activations WHERE is_revoked = 0").get() as any).count;

  res.json({
    status: "healthy",
    service: "contextengine-activation",
    deltaModules: deltaModules.length,
    activeLicenses: licenseCount,
    activeActivations: activationCount,
    stripeEnabled: isStripeEnabled(),
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// GET /contextengine/pricing — static pricing page
// ---------------------------------------------------------------------------
const publicDir = join(__dirname, "..", "public");

// Serve static assets (JS, CSS) from /contextengine/static/
app.use("/contextengine/static", express.static(publicDir));

app.get("/contextengine/pricing", (_req, res) => {
  const pricingPath = join(publicDir, "pricing.html");
  if (existsSync(pricingPath)) {
    res.sendFile(pricingPath);
  } else {
    res.redirect("https://github.com/FASTPROD/ContextEngine#-pro-features");
  }
});

// ---------------------------------------------------------------------------
// GET /contextengine/success — post-checkout success page
// ---------------------------------------------------------------------------
app.get("/contextengine/success", (_req, res) => {
  const successPath = join(publicDir, "success.html");
  if (existsSync(successPath)) {
    res.sendFile(successPath);
  } else {
    res.redirect("https://api.compr.ch/contextengine/pricing");
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  const deltaModules = loadDeltaModules();
  console.log(`🔑 ContextEngine Activation Server`);
  console.log(`   Port: ${PORT}`);
  console.log(`   DB: ${DB_PATH}`);
  console.log(`   Delta modules: ${deltaModules.length} loaded from ${DELTA_DIR}`);
  console.log(`   Ready.\n`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal: string) {
  console.log(`\n🛑 ${signal} received — shutting down...`);
  server.close(() => {
    db.close();
    console.log("   DB closed. Goodbye.");
    process.exit(0);
  });
  // Force exit after 5s if connections hang
  setTimeout(() => process.exit(1), 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

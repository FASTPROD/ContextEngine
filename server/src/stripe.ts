/**
 * Stripe + License Provisioning for ContextEngine Pro
 *
 * Flow:
 *   1. User visits pricing page → clicks plan → redirected to Stripe Checkout
 *   2. Stripe sends webhook (checkout.session.completed) → we auto-seed a license
 *   3. License key emailed to customer via Gandi SMTP
 *   4. On subscription.deleted → license deactivated
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY       — sk_live_... from Stripe Dashboard
 *   STRIPE_WEBHOOK_SECRET   — whsec_... from Stripe Webhook settings
 *   SMTP_HOST               — mail.gandi.net
 *   SMTP_PORT               — 465
 *   SMTP_USER               — noreply@compr.ch (or similar)
 *   SMTP_PASS               — SMTP password
 */

import Stripe from "stripe";
import { createTransport } from "nodemailer";
import { randomBytes } from "crypto";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

const SMTP_HOST = process.env.SMTP_HOST || "mail.gandi.net";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "465", 10);
const SMTP_USER = process.env.SMTP_USER || "noreply@compr.ch";
const SMTP_PASS = process.env.SMTP_PASS || "";

// Plan configuration — matches Stripe product metadata
const PLAN_CONFIG: Record<string, { maxMachines: number; months: number }> = {
  pro_monthly: { maxMachines: 2, months: 1 },
  pro_annual: { maxMachines: 2, months: 12 },
  team_monthly: { maxMachines: 5, months: 1 },
  team_annual: { maxMachines: 5, months: 12 },
  enterprise_monthly: { maxMachines: 10, months: 1 },
  enterprise_annual: { maxMachines: 10, months: 12 },
};

// ---------------------------------------------------------------------------
// Stripe client
// ---------------------------------------------------------------------------

let stripe: Stripe | null = null;

export function getStripe(): Stripe | null {
  if (!STRIPE_SECRET_KEY) {
    console.warn("⚠ STRIPE_SECRET_KEY not set — payment endpoints disabled");
    return null;
  }
  if (!stripe) {
    stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
  }
  return stripe;
}

export function isStripeEnabled(): boolean {
  return !!STRIPE_SECRET_KEY;
}

export function getWebhookSecret(): string {
  return STRIPE_WEBHOOK_SECRET;
}

// ---------------------------------------------------------------------------
// License key generation (same format as seed.ts)
// ---------------------------------------------------------------------------

function generateLicenseKey(): string {
  const bytes = randomBytes(16);
  const hex = bytes.toString("hex").toUpperCase();
  return `CE-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

// ---------------------------------------------------------------------------
// Auto-provision license after Stripe checkout
// ---------------------------------------------------------------------------

export function provisionLicense(
  db: Database.Database,
  email: string,
  planKey: string,
  stripeCustomerId?: string,
  stripeSubscriptionId?: string
): { key: string; plan: string; expiresAt: string; maxMachines: number } {
  const config = PLAN_CONFIG[planKey];
  if (!config) {
    throw new Error(`Unknown plan: ${planKey}. Valid: ${Object.keys(PLAN_CONFIG).join(", ")}`);
  }

  const plan = planKey.replace(/_monthly|_annual/, ""); // "pro", "team", "enterprise"
  const key = generateLicenseKey();
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + config.months);

  // Check if customer already has an active license — extend instead of creating new
  const existing = db
    .prepare("SELECT * FROM licenses WHERE email = ? AND plan = ? AND is_active = 1")
    .get(email.toLowerCase(), plan) as any;

  if (existing) {
    // Extend existing license
    const currentExpiry = new Date(existing.expires_at);
    const newExpiry = currentExpiry > new Date() ? currentExpiry : new Date();
    newExpiry.setMonth(newExpiry.getMonth() + config.months);

    db.prepare(
      "UPDATE licenses SET expires_at = ?, notes = ? WHERE id = ?"
    ).run(
      newExpiry.toISOString(),
      `Extended via Stripe ${stripeSubscriptionId || ""}. Previous expiry: ${existing.expires_at}`,
      existing.id
    );

    return {
      key: existing.key,
      plan,
      expiresAt: newExpiry.toISOString(),
      maxMachines: config.maxMachines,
    };
  }

  // Create new license
  db.prepare(
    `INSERT INTO licenses (key, email, plan, max_machines, expires_at, notes)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    key,
    email.toLowerCase(),
    plan,
    config.maxMachines,
    expiresAt.toISOString(),
    `Stripe checkout. Customer: ${stripeCustomerId || "N/A"}, Sub: ${stripeSubscriptionId || "N/A"}`
  );

  // Store Stripe mapping for subscription management
  db.exec(`
    CREATE TABLE IF NOT EXISTS stripe_mapping (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_id INTEGER NOT NULL REFERENCES licenses(id),
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const licenseRow = db.prepare("SELECT id FROM licenses WHERE key = ?").get(key) as any;
  if (licenseRow) {
    db.prepare(
      "INSERT INTO stripe_mapping (license_id, stripe_customer_id, stripe_subscription_id) VALUES (?, ?, ?)"
    ).run(licenseRow.id, stripeCustomerId, stripeSubscriptionId);
  }

  return { key, plan, expiresAt: expiresAt.toISOString(), maxMachines: config.maxMachines };
}

// ---------------------------------------------------------------------------
// Deactivate license (on subscription cancellation)
// ---------------------------------------------------------------------------

export function deactivateLicenseByStripe(
  db: Database.Database,
  stripeSubscriptionId: string
): boolean {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stripe_mapping (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_id INTEGER NOT NULL REFERENCES licenses(id),
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const mapping = db
    .prepare("SELECT license_id FROM stripe_mapping WHERE stripe_subscription_id = ?")
    .get(stripeSubscriptionId) as any;

  if (!mapping) return false;

  db.prepare("UPDATE licenses SET is_active = 0 WHERE id = ?").run(mapping.license_id);
  return true;
}

// ---------------------------------------------------------------------------
// Email license key to customer
// ---------------------------------------------------------------------------

export async function sendLicenseEmail(
  email: string,
  licenseKey: string,
  plan: string,
  expiresAt: string
): Promise<boolean> {
  if (!SMTP_PASS) {
    console.warn("⚠ SMTP_PASS not set — license email not sent. Key:", licenseKey);
    return false;
  }

  const transporter = createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const planName = plan.charAt(0).toUpperCase() + plan.slice(1);
  const expiryDate = new Date(expiresAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
      <div style="text-align: center; margin-bottom: 32px;">
        <h1 style="color: #1a1a2e; margin: 0;">🔑 ContextEngine Pro</h1>
        <p style="color: #666; margin: 8px 0 0;">Your license is ready</p>
      </div>
      
      <div style="background: #f8f9fa; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
        <p style="margin: 0 0 8px; color: #666; font-size: 14px;">Your License Key</p>
        <p style="margin: 0; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 24px; font-weight: bold; color: #1a1a2e; letter-spacing: 1px;">${licenseKey}</p>
      </div>

      <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
        <tr><td style="padding: 8px 0; color: #666;">Plan</td><td style="padding: 8px 0; text-align: right; font-weight: 600;">${planName}</td></tr>
        <tr><td style="padding: 8px 0; color: #666;">Valid Until</td><td style="padding: 8px 0; text-align: right; font-weight: 600;">${expiryDate}</td></tr>
      </table>

      <div style="background: #e8f4fd; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
        <p style="margin: 0 0 8px; font-weight: 600; color: #1a1a2e;">How to activate:</p>
        <p style="margin: 0; font-family: monospace; font-size: 13px; color: #333;">
          In your AI agent, run:<br><br>
          <code style="background: #fff; padding: 4px 8px; border-radius: 4px;">activate with key ${licenseKey} and email ${email}</code>
        </p>
      </div>

      <p style="color: #999; font-size: 12px; text-align: center;">
        Questions? Reply to this email or visit <a href="https://compr.ch/contextengine" style="color: #0066cc;">compr.ch/contextengine</a>
      </p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"ContextEngine" <${SMTP_USER}>`,
      to: email,
      subject: `Your ContextEngine ${planName} License Key`,
      html,
    });
    console.log(`📧 License email sent to ${email}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send license email to ${email}:`, (err as Error).message);
    return false;
  }
}

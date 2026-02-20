/**
 * Seed script — create license keys in the database.
 *
 * Usage:
 *   node dist/seed.js <email> [plan] [months]
 *
 * Examples:
 *   node dist/seed.js yannick@compr.ch enterprise 12
 *   node dist/seed.js client@example.com pro 3
 */

import Database from "better-sqlite3";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env.DB_PATH || join(__dirname, "..", "data", "licenses.db");

function generateLicenseKey(): string {
  // Format: CE-XXXX-XXXX-XXXX-XXXX (readable, 16 hex chars + prefix)
  const bytes = randomBytes(16);
  const hex = bytes.toString("hex").toUpperCase();
  return `CE-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

function main(): void {
  const email = process.argv[2];
  const plan = process.argv[3] || "pro";
  const months = parseInt(process.argv[4] || "12", 10);

  if (!email) {
    console.error("Usage: node dist/seed.js <email> [plan] [months]");
    console.error("Plans: community, pro, team, enterprise");
    console.error("Example: node dist/seed.js yannick@compr.ch enterprise 12");
    process.exit(1);
  }

  const validPlans = ["community", "pro", "team", "enterprise"];
  if (!validPlans.includes(plan)) {
    console.error(`Invalid plan: ${plan}. Valid: ${validPlans.join(", ")}`);
    process.exit(1);
  }

  const maxMachines = plan === "enterprise" ? 10 : plan === "team" ? 5 : 2;

  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);

  // Ensure table exists
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
  `);

  const key = generateLicenseKey();
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + months);

  db.prepare(
    "INSERT INTO licenses (key, email, plan, max_machines, expires_at, notes) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(key, email, plan, maxMachines, expiresAt.toISOString(), `Created via seed script`);

  console.log(`\n✅ License created!\n`);
  console.log(`  Key:          ${key}`);
  console.log(`  Email:        ${email}`);
  console.log(`  Plan:         ${plan}`);
  console.log(`  Machines:     ${maxMachines}`);
  console.log(`  Expires:      ${expiresAt.toISOString().split("T")[0]}`);
  console.log(`\nActivate with:`);
  console.log(`  npx contextengine activate ${key} ${email}\n`);

  db.close();
}

main();

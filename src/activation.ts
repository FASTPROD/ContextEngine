/**
 * Activation & Delta Module System
 * 
 * The npm package ships with core functionality (search, sessions, learnings).
 * Premium features (scoring, audit, collectors, HTML reports) require activation.
 * 
 * On activation:
 * 1. License key is validated against the ContextEngine API
 * 2. Server returns a signed delta bundle (encrypted JS modules)
 * 3. Delta is cached locally at ~/.contextengine/delta/
 * 4. Premium tools become available
 * 
 * Without activation: basic search, list-sources, sessions, learnings work.
 * With activation: score_project, run_audit, check_ports, list_projects,
 *                  HTML reports, 11 operational collectors, advanced BM25.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash, createDecipheriv } from "crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DELTA_DIR = join(homedir(), ".contextengine", "delta");
const LICENSE_FILE = join(homedir(), ".contextengine", "license.json");
const ACTIVATION_API = "https://api.compr.ch/contextengine/activate";
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily check

// Premium modules that require activation
export const PREMIUM_MODULES = [
  "agents",      // scorer, auditor, port checker, formatters (1653 lines)
  "collectors",  // 11 operational data collectors (705 lines) 
  "search-adv",  // advanced BM25 with tuned parameters
] as const;

// Tools that require activation
export const PREMIUM_TOOLS = [
  "score_project",
  "run_audit",
  "check_ports",
  "list_projects",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LicenseInfo {
  key: string;
  email: string;
  plan: "community" | "pro" | "team" | "enterprise";
  activatedAt: string;
  expiresAt: string;
  machineId: string;
  lastHeartbeat: string;
  deltaVersion: string;
  signature: string;
}

interface ActivationResponse {
  success: boolean;
  license: LicenseInfo;
  delta: {
    version: string;
    modules: Array<{
      name: string;
      payload: string;      // base64-encoded encrypted module
      checksum: string;     // SHA-256 of decrypted content
    }>;
    iv: string;             // AES initialization vector
  };
  error?: string;
}

// ---------------------------------------------------------------------------
// Machine fingerprint (non-PII)
// ---------------------------------------------------------------------------

function getMachineId(): string {
  const components = [
    process.platform,
    process.arch,
    homedir().split("/").slice(0, 3).join("/"), // just /Users/xxx level
    process.env.USER || process.env.USERNAME || "unknown",
  ];
  return createHash("sha256")
    .update(components.join("|"))
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// License management
// ---------------------------------------------------------------------------

export function loadLicense(): LicenseInfo | null {
  try {
    if (!existsSync(LICENSE_FILE)) return null;
    const data = JSON.parse(readFileSync(LICENSE_FILE, "utf-8"));
    
    // Check expiry
    if (new Date(data.expiresAt) < new Date()) {
      console.error("[ContextEngine] ⚠ License expired — premium features disabled");
      return null;
    }
    
    // Verify machine binding
    if (data.machineId !== getMachineId()) {
      console.error("[ContextEngine] ⚠ License bound to different machine");
      return null;
    }
    
    return data as LicenseInfo;
  } catch {
    return null;
  }
}

function saveLicense(license: LicenseInfo): void {
  const dir = join(homedir(), ".contextengine");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(LICENSE_FILE, JSON.stringify(license, null, 2));
}

// ---------------------------------------------------------------------------
// Activation flow
// ---------------------------------------------------------------------------

export async function activate(licenseKey: string, email: string): Promise<{
  success: boolean;
  message: string;
  plan?: string;
}> {
  try {
    const machineId = getMachineId();
    
    const response = await fetch(ACTIVATION_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: licenseKey,
        email,
        machineId,
        version: getPackageVersion(),
        platform: process.platform,
        arch: process.arch,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return { success: false, message: `Activation failed: ${response.status} ${text}` };
    }

    const data = (await response.json()) as ActivationResponse;

    if (!data.success) {
      return { success: false, message: data.error || "Activation rejected" };
    }

    // Save license
    saveLicense(data.license);

    // Decrypt and store delta modules
    await installDelta(data.delta, data.license.key);

    return {
      success: true,
      message: `✅ Activated! Plan: ${data.license.plan}, expires: ${data.license.expiresAt}`,
      plan: data.license.plan,
    };
  } catch (err) {
    return { success: false, message: `Activation error: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Delta module management
// ---------------------------------------------------------------------------

async function installDelta(
  delta: ActivationResponse["delta"],
  licenseKey: string
): Promise<void> {
  if (!existsSync(DELTA_DIR)) mkdirSync(DELTA_DIR, { recursive: true });

  // Derive decryption key from license key
  const derivedKey = createHash("sha256")
    .update(licenseKey + getMachineId())
    .digest();

  const iv = Buffer.from(delta.iv, "hex");

  for (const mod of delta.modules) {
    const encrypted = Buffer.from(mod.payload, "base64");
    
    // AES-256-CBC decrypt
    const decipher = createDecipheriv("aes-256-cbc", derivedKey, iv);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    const content = decrypted.toString("utf-8");
    
    // Verify checksum
    const checksum = createHash("sha256").update(content).digest("hex");
    if (checksum !== mod.checksum) {
      throw new Error(`Delta module ${mod.name} checksum mismatch — possible tampering`);
    }

    // Write to delta directory
    writeFileSync(join(DELTA_DIR, `${mod.name}.mjs`), content);
  }

  // Write version marker
  writeFileSync(
    join(DELTA_DIR, "manifest.json"),
    JSON.stringify({
      version: delta.version,
      installedAt: new Date().toISOString(),
      modules: delta.modules.map((m) => m.name),
    })
  );

  console.error(
    `[ContextEngine] 📦 Delta v${delta.version} installed (${delta.modules.length} modules)`
  );
}

/**
 * Check if delta modules are installed and valid.
 */
export function isDeltaInstalled(): boolean {
  const manifestPath = join(DELTA_DIR, "manifest.json");
  if (!existsSync(manifestPath)) return false;
  
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    // Verify all expected module files exist
    for (const modName of manifest.modules) {
      if (!existsSync(join(DELTA_DIR, `${modName}.mjs`))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Dynamically import a delta module.
 * Returns null if not activated or module not found.
 */
export async function loadDeltaModule(name: string): Promise<any | null> {
  if (!isDeltaInstalled()) return null;
  
  const modulePath = join(DELTA_DIR, `${name}.mjs`);
  if (!existsSync(modulePath)) return null;
  
  try {
    // Dynamic import of the decrypted module
    const moduleUrl = `file://${modulePath}`;
    return await import(moduleUrl);
  } catch (err) {
    console.error(`[ContextEngine] ⚠ Failed to load delta module ${name}:`, (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Heartbeat — periodic license validation
// ---------------------------------------------------------------------------

export async function heartbeat(): Promise<boolean> {
  const license = loadLicense();
  if (!license) return false;
  
  const lastBeat = new Date(license.lastHeartbeat).getTime();
  const now = Date.now();
  
  // Only check once per day
  if (now - lastBeat < HEARTBEAT_INTERVAL_MS) return true;
  
  try {
    const response = await fetch(`${ACTIVATION_API}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: license.key,
        machineId: getMachineId(),
        deltaVersion: license.deltaVersion,
      }),
    });
    
    if (response.ok) {
      license.lastHeartbeat = new Date().toISOString();
      saveLicense(license);
      return true;
    }
    
    // License revoked or expired server-side
    console.error("[ContextEngine] ⚠ License validation failed — premium features disabled");
    return false;
  } catch {
    // Network error — allow offline grace period (7 days)
    const daysSinceLastBeat = (now - lastBeat) / (1000 * 60 * 60 * 24);
    if (daysSinceLastBeat > 7) {
      console.error("[ContextEngine] ⚠ Offline too long — premium features disabled");
      return false;
    }
    return true; // grace period
  }
}

// ---------------------------------------------------------------------------
// Deactivation
// ---------------------------------------------------------------------------

export function deactivate(): void {
  // Remove license
  if (existsSync(LICENSE_FILE)) unlinkSync(LICENSE_FILE);
  
  // Remove delta modules
  if (existsSync(DELTA_DIR)) {
    for (const file of readdirSync(DELTA_DIR)) {
      unlinkSync(join(DELTA_DIR, file));
    }
  }
  
  console.error("[ContextEngine] 🔒 Deactivated — premium features removed");
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function getActivationStatus(): {
  activated: boolean;
  plan: string;
  expiresAt: string;
  deltaVersion: string;
  premiumTools: string[];
  machineId: string;
} {
  const license = loadLicense();
  const deltaInstalled = isDeltaInstalled();
  
  if (!license || !deltaInstalled) {
    return {
      activated: false,
      plan: "community",
      expiresAt: "n/a",
      deltaVersion: "n/a",
      premiumTools: [],
      machineId: getMachineId(),
    };
  }
  
  return {
    activated: true,
    plan: license.plan,
    expiresAt: license.expiresAt,
    deltaVersion: license.deltaVersion,
    premiumTools: [...PREMIUM_TOOLS],
    machineId: getMachineId(),
  };
}

/**
 * Check if a specific tool requires activation.
 */
export function requiresActivation(toolName: string): boolean {
  return (PREMIUM_TOOLS as readonly string[]).includes(toolName);
}

/**
 * Gate check — returns error message if tool requires activation but isn't activated.
 * Returns null if tool is available.
 */
export function gateCheck(toolName: string): string | null {
  if (!requiresActivation(toolName)) return null;
  
  const license = loadLicense();
  if (!license) {
    return `🔒 "${toolName}" requires a ContextEngine Pro license.\n\n` +
      `Activate with: npx contextengine activate <license-key> <email>\n` +
      `Get a license: https://compr.ch/contextengine/pricing\n\n` +
      `Free tools available: search_context, list_sources, read_source, reindex, ` +
      `save_session, load_session, list_sessions, end_session, save_learning, ` +
      `list_learnings, import_learnings`;
  }
  
  if (!isDeltaInstalled()) {
    return `🔒 Premium modules not installed. Re-activate:\n` +
      `npx contextengine activate ${license.key} ${license.email}`;
  }
  
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPackageVersion(): string {
  try {
    const pkgPath = join(import.meta.url.replace("file://", ""), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

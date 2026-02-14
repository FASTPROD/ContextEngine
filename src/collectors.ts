import { execSync } from "child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, join, basename, dirname } from "path";
import { homedir } from "os";
import type { Chunk } from "./ingest.js";

/**
 * Operational data collectors — the unique moat of ContextEngine.
 *
 * Each collector gathers data from a specific operational source
 * (git, package managers, environment, shell history, running services,
 * server configs, scheduled tasks) and returns Chunk[] in the same
 * format as the Markdown parser so they integrate seamlessly into
 * keyword + semantic search.
 *
 * Design principles:
 * - All collectors are **read-only** and **safe** — no writes, no side effects
 * - Failed commands produce empty arrays (never crash the server)
 * - Sensitive values (.env passwords, tokens) are **redacted**
 * - Each collector operates on a project directory path
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a shell command, return stdout or empty string on failure */
function exec(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

/** Check if a command exists */
function commandExists(cmd: string): boolean {
  return exec(`command -v ${cmd}`) !== "";
}

/** Redact sensitive values in .env content */
function redactSensitive(content: string): string {
  const sensitivePatterns =
    /^(.*(?:PASSWORD|SECRET|KEY|TOKEN|CREDENTIAL|AUTH|PRIVATE|API_KEY|DB_PASSWORD|MAIL_PASSWORD|JWT_SECRET|APP_KEY|ENCRYPT)[^=]*=\s*).+$/gim;
  return content.replace(sensitivePatterns, "$1[REDACTED]");
}

// ---------------------------------------------------------------------------
// 1. Git Log Collector
// ---------------------------------------------------------------------------

/**
 * Collect recent git history for a project directory.
 * Produces chunks with commit messages, authors, dates — gives AI
 * context about recent changes and development velocity.
 */
export function collectGitLog(projectDir: string, sourceName: string): Chunk[] {
  if (!existsSync(join(projectDir, ".git"))) return [];

  // Recent 50 commits, one-line format with hash, date, author, message
  const log = exec(
    `git --no-pager log --oneline --format="%h|%ai|%an|%s" -50`,
    projectDir
  );
  if (!log) return [];

  const lines = log.split("\n").filter(Boolean);
  if (lines.length === 0) return [];

  // Current branch + remote info
  const branch = exec("git branch --show-current", projectDir) || "unknown";
  const remotes = exec("git remote -v", projectDir);
  const status = exec("git --no-pager diff --stat HEAD~1..HEAD", projectDir);

  const chunks: Chunk[] = [];

  // Summary chunk
  chunks.push({
    source: `${sourceName} — git`,
    section: "## Git Overview",
    content: [
      `Branch: ${branch}`,
      `Commits shown: ${lines.length}`,
      remotes ? `\nRemotes:\n${remotes}` : "",
      status ? `\nLast commit changes:\n${status}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    lineStart: 1,
    lineEnd: 1,
  });

  // Batch commits into groups of 10 for searchable chunks
  for (let i = 0; i < lines.length; i += 10) {
    const batch = lines.slice(i, i + 10);
    const formatted = batch
      .map((line) => {
        const [hash, date, author, ...msgParts] = line.split("|");
        return `${hash} ${date?.split(" ")[0]} ${author}: ${msgParts.join("|")}`;
      })
      .join("\n");

    chunks.push({
      source: `${sourceName} — git`,
      section: `## Git Log (${i + 1}-${Math.min(i + 10, lines.length)})`,
      content: formatted,
      lineStart: i + 1,
      lineEnd: Math.min(i + 10, lines.length),
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// 2. Package.json Collector (Node.js projects)
// ---------------------------------------------------------------------------

/**
 * Collect dependency and script info from package.json.
 * Critical for version agent + understanding project capabilities.
 */
export function collectPackageJson(
  projectDir: string,
  sourceName: string
): Chunk[] {
  const pkgPath = join(projectDir, "package.json");
  if (!existsSync(pkgPath)) return [];

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const chunks: Chunk[] = [];

    // Project identity
    chunks.push({
      source: `${sourceName} — package.json`,
      section: "## Package Identity",
      content: [
        `Name: ${pkg.name || "unnamed"}`,
        `Version: ${pkg.version || "0.0.0"}`,
        pkg.description ? `Description: ${pkg.description}` : "",
        pkg.license ? `License: ${pkg.license}` : "",
        pkg.engines
          ? `Engines: ${JSON.stringify(pkg.engines)}`
          : "",
        pkg.type ? `Module type: ${pkg.type}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      lineStart: 1,
      lineEnd: 1,
    });

    // Scripts
    if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
      chunks.push({
        source: `${sourceName} — package.json`,
        section: "## npm Scripts",
        content: Object.entries(pkg.scripts)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
        lineStart: 1,
        lineEnd: 1,
      });
    }

    // Dependencies (names + versions, no code)
    const deps = pkg.dependencies || {};
    const devDeps = pkg.devDependencies || {};
    if (Object.keys(deps).length > 0) {
      chunks.push({
        source: `${sourceName} — package.json`,
        section: "## Dependencies",
        content: Object.entries(deps)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
        lineStart: 1,
        lineEnd: 1,
      });
    }
    if (Object.keys(devDeps).length > 0) {
      chunks.push({
        source: `${sourceName} — package.json`,
        section: "## Dev Dependencies",
        content: Object.entries(devDeps)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
        lineStart: 1,
        lineEnd: 1,
      });
    }

    return chunks;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 3. Composer.json Collector (PHP projects)
// ---------------------------------------------------------------------------

/**
 * Collect dependency info from composer.json (Laravel, Symfony, etc.).
 */
export function collectComposerJson(
  projectDir: string,
  sourceName: string
): Chunk[] {
  const composerPath = join(projectDir, "composer.json");
  if (!existsSync(composerPath)) return [];

  try {
    const composer = JSON.parse(readFileSync(composerPath, "utf-8"));
    const chunks: Chunk[] = [];

    chunks.push({
      source: `${sourceName} — composer.json`,
      section: "## Composer Package",
      content: [
        `Name: ${composer.name || "unnamed"}`,
        composer.description ? `Description: ${composer.description}` : "",
        composer.type ? `Type: ${composer.type}` : "",
        composer.license ? `License: ${composer.license}` : "",
        composer.require?.php ? `PHP: ${composer.require.php}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      lineStart: 1,
      lineEnd: 1,
    });

    const deps = composer.require || {};
    if (Object.keys(deps).length > 0) {
      chunks.push({
        source: `${sourceName} — composer.json`,
        section: "## PHP Dependencies",
        content: Object.entries(deps)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
        lineStart: 1,
        lineEnd: 1,
      });
    }

    const devDeps = composer["require-dev"] || {};
    if (Object.keys(devDeps).length > 0) {
      chunks.push({
        source: `${sourceName} — composer.json`,
        section: "## PHP Dev Dependencies",
        content: Object.entries(devDeps)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
        lineStart: 1,
        lineEnd: 1,
      });
    }

    // Scripts
    if (composer.scripts && Object.keys(composer.scripts).length > 0) {
      chunks.push({
        source: `${sourceName} — composer.json`,
        section: "## Composer Scripts",
        content: Object.entries(composer.scripts)
          .map(([k, v]) => {
            const val = Array.isArray(v) ? v.join(", ") : String(v);
            return `${k}: ${val}`;
          })
          .join("\n"),
        lineStart: 1,
        lineEnd: 1,
      });
    }

    return chunks;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 4. .env Collector (sanitized — passwords redacted)
// ---------------------------------------------------------------------------

/**
 * Collect environment configuration. Passwords/secrets are REDACTED.
 * Gives AI context about database hosts, mail config, app URLs, etc.
 */
export function collectEnvFile(
  projectDir: string,
  sourceName: string
): Chunk[] {
  const envPath = join(projectDir, ".env");
  if (!existsSync(envPath)) return [];

  try {
    const raw = readFileSync(envPath, "utf-8");
    const redacted = redactSensitive(raw);

    // Remove empty lines and comments for cleaner chunks
    const meaningful = redacted
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .join("\n");

    if (!meaningful) return [];

    return [
      {
        source: `${sourceName} — .env`,
        section: "## Environment Configuration",
        content: meaningful,
        lineStart: 1,
        lineEnd: meaningful.split("\n").length,
      },
    ];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 5. Shell History Collector (recent commands)
// ---------------------------------------------------------------------------

/**
 * Collect recent shell history entries.
 * Useful for understanding what the developer has been doing recently.
 * Passwords in history are redacted.
 */
export function collectShellHistory(sourceName: string): Chunk[] {
  const histFile = resolve(homedir(), ".zsh_history");
  if (!existsSync(histFile)) return [];

  try {
    // Read last 200 lines (most recent commands)
    const raw = exec(`tail -200 ${histFile}`);
    if (!raw) return [];

    // Parse zsh extended history format: : timestamp:0;command
    const commands = raw
      .split("\n")
      .map((line) => {
        const match = line.match(/^:\s*(\d+):\d+;(.+)/);
        if (match) return match[2].trim();
        // Plain format
        return line.trim();
      })
      .filter(Boolean)
      // Remove duplicates while preserving order
      .filter((cmd, i, arr) => arr.indexOf(cmd) === i);

    if (commands.length === 0) return [];

    const redacted = redactSensitive(commands.join("\n"));

    return [
      {
        source: `${sourceName} — shell history`,
        section: "## Recent Shell Commands",
        content: redacted,
        lineStart: 1,
        lineEnd: commands.length,
      },
    ];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 6. Docker Collector (running containers + compose config)
// ---------------------------------------------------------------------------

/**
 * Collect Docker container info — what's running, ports, images.
 */
export function collectDocker(sourceName: string): Chunk[] {
  if (!commandExists("docker")) return [];

  const chunks: Chunk[] = [];

  // Running containers
  const ps = exec(
    'docker ps --format "{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}" 2>/dev/null'
  );
  if (ps) {
    const formatted = ps
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, image, status, ports] = line.split("|");
        return `${name}: ${image} (${status}) ${ports || ""}`.trim();
      })
      .join("\n");

    chunks.push({
      source: `${sourceName} — docker`,
      section: "## Running Containers",
      content: formatted,
      lineStart: 1,
      lineEnd: 1,
    });
  }

  // Docker images
  const images = exec(
    'docker images --format "{{.Repository}}:{{.Tag}} ({{.Size}})" 2>/dev/null | head -20'
  );
  if (images) {
    chunks.push({
      source: `${sourceName} — docker`,
      section: "## Docker Images",
      content: images,
      lineStart: 1,
      lineEnd: 1,
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// 7. PM2 Collector (running processes)
// ---------------------------------------------------------------------------

/**
 * Collect PM2 process list — what apps are running, ports, status.
 */
export function collectPM2(sourceName: string): Chunk[] {
  if (!commandExists("pm2")) return [];

  // Use jlist for structured data
  const raw = exec("pm2 jlist 2>/dev/null");
  if (!raw) return [];

  try {
    const processes = JSON.parse(raw);
    if (!Array.isArray(processes) || processes.length === 0) return [];

    const formatted = processes
      .map((p: any) => {
        const env = p.pm2_env || {};
        return [
          `${p.name}: ${env.status || "unknown"}`,
          `  pid: ${p.pid || "N/A"}`,
          `  port: ${env.PORT || env.port || "N/A"}`,
          `  cwd: ${env.pm_cwd || "N/A"}`,
          `  uptime: ${env.pm_uptime ? new Date(env.pm_uptime).toISOString() : "N/A"}`,
          `  restarts: ${env.restart_time || 0}`,
        ].join("\n");
      })
      .join("\n\n");

    return [
      {
        source: `${sourceName} — pm2`,
        section: "## PM2 Processes",
        content: formatted,
        lineStart: 1,
        lineEnd: processes.length,
      },
    ];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 8. Nginx Collector (site configurations)
// ---------------------------------------------------------------------------

/**
 * Collect Nginx site configurations — domains, roots, proxy settings.
 * Reads from common config locations.
 */
export function collectNginx(sourceName: string): Chunk[] {
  const configDirs = [
    "/etc/nginx/sites-enabled",
    "/etc/nginx/conf.d",
    "/usr/local/etc/nginx/servers", // macOS Homebrew
  ];

  const chunks: Chunk[] = [];

  for (const dir of configDirs) {
    if (!existsSync(dir)) continue;

    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (file.startsWith(".")) continue;
        const filePath = join(dir, file);

        try {
          if (!statSync(filePath).isFile()) continue;
        } catch {
          continue;
        }

        try {
          const content = readFileSync(filePath, "utf-8");

          // Extract key directives for a summary
          const serverNames = [
            ...content.matchAll(/server_name\s+([^;]+);/g),
          ].map((m) => m[1].trim());
          const roots = [...content.matchAll(/root\s+([^;]+);/g)].map((m) =>
            m[1].trim()
          );
          const listens = [...content.matchAll(/listen\s+([^;]+);/g)].map(
            (m) => m[1].trim()
          );
          const proxyPasses = [
            ...content.matchAll(/proxy_pass\s+([^;]+);/g),
          ].map((m) => m[1].trim());

          const summary = [
            serverNames.length
              ? `Domains: ${serverNames.join(", ")}`
              : "",
            listens.length ? `Listen: ${listens.join(", ")}` : "",
            roots.length ? `Root: ${roots.join(", ")}` : "",
            proxyPasses.length
              ? `Proxy: ${proxyPasses.join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");

          if (summary) {
            chunks.push({
              source: `${sourceName} — nginx`,
              section: `## Nginx: ${file}`,
              content: summary,
              lineStart: 1,
              lineEnd: 1,
            });
          }
        } catch {
          // Permission denied — skip
        }
      }
    } catch {
      // Permission denied — skip
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// 9. Crontab Collector
// ---------------------------------------------------------------------------

/**
 * Collect crontab entries — scheduled tasks and maintenance jobs.
 */
export function collectCrontab(sourceName: string): Chunk[] {
  const cron = exec("crontab -l 2>/dev/null");
  if (!cron) return [];

  // Filter out comments and empty lines for summary
  const entries = cron
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"));

  if (entries.length === 0) return [];

  return [
    {
      source: `${sourceName} — crontab`,
      section: "## Scheduled Tasks (crontab)",
      content: entries.join("\n"),
      lineStart: 1,
      lineEnd: entries.length,
    },
  ];
}

// ---------------------------------------------------------------------------
// 10. Ecosystem.config.js Collector (PM2 config files)
// ---------------------------------------------------------------------------

/**
 * Collect PM2 ecosystem config from project directory.
 */
export function collectEcosystemConfig(
  projectDir: string,
  sourceName: string
): Chunk[] {
  const configNames = ["ecosystem.config.js", "ecosystem.config.cjs"];

  for (const name of configNames) {
    const configPath = join(projectDir, name);
    if (!existsSync(configPath)) continue;

    try {
      const content = readFileSync(configPath, "utf-8");
      return [
        {
          source: `${sourceName} — ecosystem.config`,
          section: "## PM2 Ecosystem Config",
          content,
          lineStart: 1,
          lineEnd: content.split("\n").length,
        },
      ];
    } catch {
      continue;
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// 11. Docker Compose Collector (project-level)
// ---------------------------------------------------------------------------

/**
 * Collect docker-compose.yml for a project — services, ports, volumes.
 */
export function collectDockerCompose(
  projectDir: string,
  sourceName: string
): Chunk[] {
  const composeNames = [
    "docker-compose.yml",
    "docker-compose.yaml",
    "docker-compose.prod.yml",
    "compose.yml",
    "compose.yaml",
  ];

  const chunks: Chunk[] = [];

  for (const name of composeNames) {
    const composePath = join(projectDir, name);
    if (!existsSync(composePath)) continue;

    try {
      const content = readFileSync(composePath, "utf-8");
      const redacted = redactSensitive(content);

      chunks.push({
        source: `${sourceName} — ${name}`,
        section: `## Docker Compose: ${name}`,
        content: redacted,
        lineStart: 1,
        lineEnd: redacted.split("\n").length,
      });
    } catch {
      // Permission denied — skip
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Master collector: gather all operational data for a project
// ---------------------------------------------------------------------------

/**
 * Collect all operational data for a single project directory.
 * Returns chunks from all available collectors.
 */
export function collectProjectOps(
  projectDir: string,
  sourceName: string
): Chunk[] {
  const allChunks: Chunk[] = [];

  allChunks.push(...collectGitLog(projectDir, sourceName));
  allChunks.push(...collectPackageJson(projectDir, sourceName));
  allChunks.push(...collectComposerJson(projectDir, sourceName));
  allChunks.push(...collectEnvFile(projectDir, sourceName));
  allChunks.push(...collectEcosystemConfig(projectDir, sourceName));
  allChunks.push(...collectDockerCompose(projectDir, sourceName));

  return allChunks;
}

/**
 * Collect system-wide operational data (not project-specific).
 * These run once, not per-project.
 */
export function collectSystemOps(): Chunk[] {
  const allChunks: Chunk[] = [];
  const sourceName = "System";

  allChunks.push(...collectShellHistory(sourceName));
  allChunks.push(...collectDocker(sourceName));
  allChunks.push(...collectPM2(sourceName));
  allChunks.push(...collectNginx(sourceName));
  allChunks.push(...collectCrontab(sourceName));

  return allChunks;
}

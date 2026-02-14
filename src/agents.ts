import { execSync } from "child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, join, basename } from "path";
import { homedir } from "os";
import type { ProjectDirectory } from "./config.js";

/**
 * Multi-Agent Architecture — Phase 1: Foundation + Compliance Agent
 *
 * Implements the plan-and-approve workflow described in
 * FASTPROD/docs/MULTI_AGENT_ARCHITECTURE_PLAN.md
 *
 * Risk levels:
 * 🟢 Read-only (auto-approve) — ls, cat, SELECT, status checks
 * 🟡 Non-destructive write — git commit, config edit (needs review)
 * 🔴 Destructive — DELETE, DROP, rm, deploy, reload (needs confirm)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectInfo {
  name: string;
  path: string;
  type: string; // "node", "php", "python", "flutter", "static", "unknown"
  framework: string; // "laravel", "react", "expo", "fastapi", etc.
  runtime: string; // "node 20", "php 8.2", etc.
  hasGit: boolean;
  gitRemotes: string[];
  hasDocker: boolean;
  hasPm2: boolean;
  deps: Record<string, string>; // key dependencies + versions
}

export interface PlanStep {
  action: string;
  description: string;
  command?: string;
  risk: "green" | "yellow" | "red";
  reversible: boolean;
  estimatedTime: string;
}

export interface AuditFinding {
  check: string;
  status: "pass" | "warn" | "fail";
  message: string;
  project?: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  remediation?: string;
  command?: string;
}

export interface AuditPlan {
  agent: string;
  timestamp: string;
  trigger: string;
  scope: string;
  findings: AuditFinding[];
  steps: PlanStep[];
  summary: {
    pass: number;
    warn: number;
    fail: number;
    critical: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Project Discovery & Analysis
// ---------------------------------------------------------------------------

/**
 * Analyze a project directory and determine its type, framework, runtime.
 */
export function analyzeProject(dir: ProjectDirectory): ProjectInfo {
  const info: ProjectInfo = {
    name: dir.name,
    path: dir.path,
    type: "unknown",
    framework: "unknown",
    runtime: "unknown",
    hasGit: existsSync(join(dir.path, ".git")),
    gitRemotes: [],
    hasDocker: existsSync(join(dir.path, "Dockerfile")) || existsSync(join(dir.path, "docker-compose.yml")),
    hasPm2: existsSync(join(dir.path, "ecosystem.config.js")) || existsSync(join(dir.path, "ecosystem.config.cjs")),
    deps: {},
  };

  // Git remotes
  if (info.hasGit) {
    const remotes = exec("git remote -v", dir.path);
    info.gitRemotes = [...new Set(
      remotes.split("\n").map(l => l.split(/\s+/)[0]).filter(Boolean)
    )];
  }

  // Node.js project
  const pkgPath = join(dir.path, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      info.type = "node";
      info.runtime = `node`;

      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Detect framework
      if (allDeps["next"]) {
        info.framework = "next.js";
        info.deps["next"] = allDeps["next"];
      } else if (allDeps["expo"]) {
        info.framework = "expo";
        info.deps["expo"] = allDeps["expo"];
      } else if (allDeps["react-scripts"]) {
        info.framework = "react-cra";
        info.deps["react-scripts"] = allDeps["react-scripts"];
      } else if (allDeps["vite"]) {
        info.framework = "vite";
        info.deps["vite"] = allDeps["vite"];
      } else if (allDeps["@modelcontextprotocol/sdk"]) {
        info.framework = "mcp-server";
        info.deps["@modelcontextprotocol/sdk"] = allDeps["@modelcontextprotocol/sdk"];
      } else if (allDeps["express"]) {
        info.framework = "express";
        info.deps["express"] = allDeps["express"];
      } else if (allDeps["fastify"]) {
        info.framework = "fastify";
        info.deps["fastify"] = allDeps["fastify"];
      }

      // Key deps
      if (allDeps["react"]) info.deps["react"] = allDeps["react"];
      if (allDeps["typescript"]) info.deps["typescript"] = allDeps["typescript"];
      if (allDeps["vue"]) info.deps["vue"] = allDeps["vue"];
      if (allDeps["@mui/material"]) info.deps["@mui/material"] = allDeps["@mui/material"];
      if (allDeps["@material-ui/core"]) info.deps["@material-ui/core"] = allDeps["@material-ui/core"];
    } catch { /* ignore */ }
  }

  // PHP project
  const composerPath = join(dir.path, "composer.json");
  if (existsSync(composerPath)) {
    try {
      const composer = JSON.parse(readFileSync(composerPath, "utf-8"));
      info.type = "php";
      info.runtime = "php";

      const allDeps = { ...composer.require, ...composer["require-dev"] };
      if (allDeps["laravel/framework"]) {
        info.framework = "laravel";
        info.deps["laravel/framework"] = allDeps["laravel/framework"];
      } else if (allDeps["symfony/framework-bundle"]) {
        info.framework = "symfony";
      }
    } catch { /* ignore */ }
  }

  // Python project
  const pyProjectPath = join(dir.path, "pyproject.toml");
  const requirementsPath = join(dir.path, "requirements.txt");
  if (existsSync(pyProjectPath) || existsSync(requirementsPath)) {
    info.type = "python";
    info.runtime = "python";

    if (existsSync(requirementsPath)) {
      const reqs = readFileSync(requirementsPath, "utf-8");
      if (reqs.includes("fastapi")) info.framework = "fastapi";
      else if (reqs.includes("django")) info.framework = "django";
      else if (reqs.includes("flask")) info.framework = "flask";
    }
  }

  // Flutter project
  if (existsSync(join(dir.path, "pubspec.yaml"))) {
    info.type = "flutter";
    info.framework = "flutter";
    info.runtime = "dart";
  }

  // Flutter web build (compiled only)
  if (existsSync(join(dir.path, "main.dart.js")) && existsSync(join(dir.path, "flutter_service_worker.js"))) {
    info.type = "flutter";
    info.framework = "flutter-web-build";
    info.runtime = "static";
  }

  return info;
}

/**
 * List all projects with tech analysis.
 */
export function listProjects(projectDirs: ProjectDirectory[]): ProjectInfo[] {
  return projectDirs.map(analyzeProject);
}

// ---------------------------------------------------------------------------
// Port Conflict Detection
// ---------------------------------------------------------------------------

interface PortUsage {
  port: number;
  project: string;
  source: string; // "ecosystem.config.js", "docker-compose.yml", ".env", "package.json"
  details: string; // "voila-api (php artisan serve)"
}

/**
 * Scan all projects for port declarations and detect conflicts.
 */
export function checkPorts(projectDirs: ProjectDirectory[]): {
  ports: PortUsage[];
  conflicts: Array<{ port: number; usages: PortUsage[] }>;
} {
  const allPorts: PortUsage[] = [];

  for (const dir of projectDirs) {
    // ecosystem.config.js — parse port from args or env
    for (const ecFile of ["ecosystem.config.js", "ecosystem.config.cjs"]) {
      const ecPath = join(dir.path, ecFile);
      if (!existsSync(ecPath)) continue;
      const content = readFileSync(ecPath, "utf-8");

      // Match port patterns: --port 8000, PORT=8000, port: 8000, WEB_PORT=19012
      const portPatterns = [
        /--port\s+(\d+)/g,
        /PORT[=:]\s*['"]?(\d+)/gi,
        /WEB_PORT[=:]\s*['"]?(\d+)/gi,
        /RCT_METRO_PORT[=:]\s*['"]?(\d+)/gi,
        /port:\s*(\d+)/g,
      ];
      for (const regex of portPatterns) {
        let match;
        while ((match = regex.exec(content)) !== null) {
          const port = parseInt(match[1], 10);
          if (port > 0 && port < 65536) {
            // Try to extract the app name from context
            const lines = content.split("\n");
            const matchLine = content.substring(0, match.index).split("\n").length - 1;
            let appName = dir.name;
            for (let i = matchLine; i >= Math.max(0, matchLine - 10); i--) {
              const nameMatch = lines[i]?.match(/name:\s*['"]([^'"]+)['"]/);
              if (nameMatch) { appName = nameMatch[1]; break; }
            }
            allPorts.push({
              port,
              project: dir.name,
              source: ecFile,
              details: appName,
            });
          }
        }
      }
    }

    // docker-compose.yml — published ports
    for (const dcFile of ["docker-compose.yml", "docker-compose.yaml", "docker-compose.prod.yml"]) {
      const dcPath = join(dir.path, dcFile);
      if (!existsSync(dcPath)) continue;
      const content = readFileSync(dcPath, "utf-8");
      const portMatches = content.matchAll(/["']?(\d+):(\d+)["']?/g);
      for (const m of portMatches) {
        const hostPort = parseInt(m[1], 10);
        if (hostPort > 0 && hostPort < 65536) {
          allPorts.push({
            port: hostPort,
            project: dir.name,
            source: dcFile,
            details: `host:${m[1]}→container:${m[2]}`,
          });
        }
      }
    }

    // .env — PORT= or APP_PORT= or DB_PORT=
    const envPath = join(dir.path, ".env");
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf-8");
      const portLines = content.match(/^(?:APP_)?(?:PORT|DB_PORT|REDIS_PORT)\s*=\s*(\d+)$/gm);
      if (portLines) {
        for (const line of portLines) {
          const [key, val] = line.split("=").map(s => s.trim());
          const port = parseInt(val, 10);
          if (port > 0 && port < 65536) {
            allPorts.push({
              port,
              project: dir.name,
              source: ".env",
              details: key,
            });
          }
        }
      }
    }

    // package.json — "start" script with --port
    const pkgPath = join(dir.path, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const scripts = pkg.scripts || {};
        for (const [scriptName, scriptCmd] of Object.entries(scripts)) {
          const cmd = String(scriptCmd);
          const portMatch = cmd.match(/--port\s+(\d+)/);
          if (portMatch) {
            allPorts.push({
              port: parseInt(portMatch[1], 10),
              project: dir.name,
              source: "package.json",
              details: `script: ${scriptName}`,
            });
          }
        }
      } catch { /* ignore */ }
    }
  }

  // Deduplicate (same port+project+source = one entry)
  const seen = new Set<string>();
  const dedupPorts = allPorts.filter(p => {
    const key = `${p.port}:${p.project}:${p.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Detect conflicts (same port used by different projects)
  const portMap = new Map<number, PortUsage[]>();
  for (const p of dedupPorts) {
    const list = portMap.get(p.port) || [];
    list.push(p);
    portMap.set(p.port, list);
  }

  const conflicts: Array<{ port: number; usages: PortUsage[] }> = [];
  for (const [port, usages] of portMap) {
    const uniqueProjects = new Set(usages.map(u => u.project));
    if (uniqueProjects.size > 1) {
      conflicts.push({ port, usages });
    }
  }

  return { ports: dedupPorts, conflicts };
}

// ---------------------------------------------------------------------------
// Compliance Agent — Audits
// ---------------------------------------------------------------------------

/**
 * Check git remotes: every project should have both 'origin' (GitHub) and 'gdrive'.
 */
function auditGitRemotes(projects: ProjectInfo[]): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const p of projects) {
    if (!p.hasGit) {
      findings.push({
        check: "git-remotes",
        status: "warn",
        message: `${p.name}: Not a git repository`,
        project: p.name,
        severity: "medium",
        remediation: `cd ${p.path} && git init && git remote add origin <url>`,
      });
      continue;
    }

    const hasOrigin = p.gitRemotes.includes("origin");
    const hasGdrive = p.gitRemotes.includes("gdrive");

    if (hasOrigin && hasGdrive) {
      findings.push({
        check: "git-remotes",
        status: "pass",
        message: `${p.name}: origin ✅ gdrive ✅`,
        project: p.name,
        severity: "info",
      });
    } else {
      const missing = [];
      if (!hasOrigin) missing.push("origin");
      if (!hasGdrive) missing.push("gdrive");
      findings.push({
        check: "git-remotes",
        status: "fail",
        message: `${p.name}: Missing remotes: ${missing.join(", ")}`,
        project: p.name,
        severity: "high",
        remediation: missing.map(r => `cd ${p.path} && git remote add ${r} <url>`).join("\n"),
      });
    }
  }

  return findings;
}

/**
 * Check for post-commit hook (auto-push to all remotes).
 * Also audits hook quality: error handling, gdrive best-effort pattern.
 */
function auditGitHooks(projects: ProjectInfo[]): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const p of projects) {
    if (!p.hasGit) continue;

    // Check both .git/hooks/ and hooks/ (custom dir)
    const hookPaths = [
      join(p.path, ".git", "hooks", "post-commit"),
      join(p.path, "hooks", "post-commit"),
    ];

    let foundHook = false;
    let hookContent = "";
    for (const hookPath of hookPaths) {
      if (existsSync(hookPath)) {
        hookContent = readFileSync(hookPath, "utf-8");
        if (hookContent.includes("push") || hookContent.includes("remote")) {
          foundHook = true;
          break;
        }
      }
    }

    // Also check git config for core.hooksPath
    const hooksPath = exec("git config core.hooksPath", p.path);
    if (hooksPath) {
      const customHook = resolve(p.path, hooksPath, "post-commit");
      if (existsSync(customHook)) {
        foundHook = true;
        if (!hookContent) hookContent = readFileSync(customHook, "utf-8");
      }
    }

    findings.push({
      check: "git-hooks",
      status: foundHook ? "pass" : "warn",
      message: `${p.name}: post-commit auto-push ${foundHook ? "✅" : "⚠ not found"}`,
      project: p.name,
      severity: foundHook ? "info" : "low",
      remediation: foundHook ? undefined : `Add post-commit hook: cp hooks/post-commit ${p.path}/.git/hooks/`,
    });

    // Hook quality checks (only if hook exists)
    if (foundHook && hookContent) {
      // Check: gdrive push should be best-effort (error-suppressed)
      const pushesGdrive = hookContent.includes("gdrive");
      const gdriveErrorSuppressed =
        hookContent.includes("2>/dev/null") ||
        hookContent.includes("2>&1") ||
        hookContent.includes("|| true") ||
        hookContent.includes("|| echo");

      if (pushesGdrive && !gdriveErrorSuppressed) {
        findings.push({
          check: "hook-quality",
          status: "warn",
          message: `${p.name}: gdrive push has no error suppression — FUSE failures will produce noisy output`,
          project: p.name,
          severity: "low",
          remediation: `Update hook: git push gdrive "$BRANCH" 2>/dev/null && echo "✅ gdrive" || echo "⚠️ gdrive (best-effort)"`,
        });
      } else if (pushesGdrive && gdriveErrorSuppressed) {
        findings.push({
          check: "hook-quality",
          status: "pass",
          message: `${p.name}: gdrive push is best-effort ✅ (errors suppressed)`,
          project: p.name,
          severity: "info",
        });
      }

      // Check: hook should use BRANCH variable, not hardcoded branch name
      const usesBranchVar =
        hookContent.includes("$BRANCH") ||
        hookContent.includes("$(git") ||
        hookContent.includes("`git");
      const hardcodesBranch =
        hookContent.includes("push origin main") ||
        hookContent.includes("push origin master") ||
        hookContent.includes("push gdrive main") ||
        hookContent.includes("push gdrive master");

      if (hardcodesBranch && !usesBranchVar) {
        findings.push({
          check: "hook-quality",
          status: "warn",
          message: `${p.name}: hook hardcodes branch name — won't work on feature branches`,
          project: p.name,
          severity: "low",
          remediation: `Use BRANCH=$(git rev-parse --abbrev-ref HEAD) then git push origin "$BRANCH"`,
        });
      }

      // Check: hook should have shebang
      if (!hookContent.startsWith("#!")) {
        findings.push({
          check: "hook-quality",
          status: "warn",
          message: `${p.name}: post-commit hook missing shebang (#!/bin/zsh or #!/bin/bash)`,
          project: p.name,
          severity: "low",
          remediation: `Add #!/bin/zsh as the first line of the hook`,
        });
      }
    }
  }

  return findings;
}

/**
 * Validate .env files exist for projects that need them.
 */
function auditEnvFiles(projects: ProjectInfo[]): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const p of projects) {
    // Only check projects that should have .env
    const needsEnv = ["laravel", "fastapi", "django", "express", "fastify", "next.js", "vite"].includes(p.framework)
      || existsSync(join(p.path, ".env.example"));

    if (!needsEnv) continue;

    const envPath = join(p.path, ".env");
    const envExamplePath = join(p.path, ".env.example");

    if (!existsSync(envPath)) {
      findings.push({
        check: "env-file",
        status: "fail",
        message: `${p.name}: .env file missing (framework: ${p.framework})`,
        project: p.name,
        severity: "high",
        remediation: existsSync(envExamplePath)
          ? `cd ${p.path} && cp .env.example .env`
          : `Create ${p.path}/.env from project documentation`,
      });
    } else {
      // Check .env is in .gitignore
      const giPath = join(p.path, ".gitignore");
      if (existsSync(giPath)) {
        const gi = readFileSync(giPath, "utf-8");
        if (!gi.includes(".env")) {
          findings.push({
            check: "env-file",
            status: "fail",
            message: `${p.name}: .env exists but NOT in .gitignore — secrets could be committed!`,
            project: p.name,
            severity: "critical",
            remediation: `echo ".env" >> ${p.path}/.gitignore`,
          });
        } else {
          findings.push({
            check: "env-file",
            status: "pass",
            message: `${p.name}: .env ✅ (in .gitignore)`,
            project: p.name,
            severity: "info",
          });
        }
      } else {
        findings.push({
          check: "env-file",
          status: "warn",
          message: `${p.name}: .env exists but no .gitignore found`,
          project: p.name,
          severity: "medium",
        });
      }
    }
  }

  return findings;
}

/**
 * Check Docker configuration consistency.
 */
function auditDocker(projects: ProjectInfo[]): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const p of projects) {
    if (!p.hasDocker) continue;

    // Check Dockerfile exists
    const dockerfilePath = join(p.path, "Dockerfile");
    if (existsSync(dockerfilePath)) {
      const content = readFileSync(dockerfilePath, "utf-8");

      // Check platform specification for production builds
      // (important: Apple Silicon → amd64)
      findings.push({
        check: "docker-config",
        status: "pass",
        message: `${p.name}: Dockerfile found`,
        project: p.name,
        severity: "info",
      });

      // Check for WORKDIR
      const workdirMatch = content.match(/WORKDIR\s+(\S+)/);
      if (workdirMatch) {
        findings.push({
          check: "docker-workdir",
          status: "pass",
          message: `${p.name}: WORKDIR = ${workdirMatch[1]}`,
          project: p.name,
          severity: "info",
        });
      }
    }

    // Check docker-compose volume mounts
    for (const dcFile of ["docker-compose.yml", "docker-compose.prod.yml"]) {
      const dcPath = join(p.path, dcFile);
      if (!existsSync(dcPath)) continue;
      const content = readFileSync(dcPath, "utf-8");

      // Check for restart policy
      if (content.includes("restart:")) {
        findings.push({
          check: "docker-restart",
          status: "pass",
          message: `${p.name} (${dcFile}): restart policy configured`,
          project: p.name,
          severity: "info",
        });
      } else {
        findings.push({
          check: "docker-restart",
          status: "warn",
          message: `${p.name} (${dcFile}): No restart policy — containers won't auto-restart`,
          project: p.name,
          severity: "medium",
          remediation: `Add 'restart: unless-stopped' to services in ${dcPath}`,
        });
      }
    }
  }

  return findings;
}

/**
 * Check PM2 ecosystem configs for best practices.
 */
function auditPm2(projects: ProjectInfo[]): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const p of projects) {
    if (!p.hasPm2) continue;

    for (const ecFile of ["ecosystem.config.js", "ecosystem.config.cjs"]) {
      const ecPath = join(p.path, ecFile);
      if (!existsSync(ecPath)) continue;

      const content = readFileSync(ecPath, "utf-8");

      // Check for bash wrapper anti-pattern
      if (content.includes("bash -c") || content.includes("bash -i")) {
        findings.push({
          check: "pm2-no-bash",
          status: "fail",
          message: `${p.name}: PM2 uses bash wrapper — causes orphan processes on restart`,
          project: p.name,
          severity: "high",
          remediation: `Remove 'bash -c' wrapper in ${ecPath} — use npx/node directly`,
        });
      }

      // Check treekill
      if (!content.includes("treekill")) {
        findings.push({
          check: "pm2-treekill",
          status: "warn",
          message: `${p.name}: PM2 config missing treekill: true — child processes may orphan on restart`,
          project: p.name,
          severity: "medium",
          remediation: `Add 'treekill: true' to ${ecPath}`,
        });
      }

      // Check kill_timeout
      if (!content.includes("kill_timeout")) {
        findings.push({
          check: "pm2-kill-timeout",
          status: "warn",
          message: `${p.name}: PM2 config missing kill_timeout — processes may hang on stop`,
          project: p.name,
          severity: "low",
          remediation: `Add 'kill_timeout: 10000' to ${ecPath}`,
        });
      }

      // Check autorestart
      if (content.includes("autorestart: false") || content.includes("autorestart:false")) {
        findings.push({
          check: "pm2-autorestart",
          status: "pass",
          message: `${p.name}: PM2 autorestart disabled (intentional for dev servers)`,
          project: p.name,
          severity: "info",
        });
      }
    }
  }

  return findings;
}

/**
 * Check for version issues — EOL runtimes, outdated deps, MUI v4/v5 coexistence.
 */
function auditVersions(projects: ProjectInfo[]): AuditFinding[] {
  const findings: AuditFinding[] = [];

  // Known EOL dates (approximate)
  const eolRuntimes: Record<string, { eol: string; replacement: string }> = {
    "php 7.4": { eol: "Nov 2022", replacement: "PHP 8.2+" },
    "node 14": { eol: "Apr 2023", replacement: "Node 20 LTS" },
    "node 16": { eol: "Sep 2023", replacement: "Node 20 LTS" },
    "python 3.7": { eol: "Jun 2023", replacement: "Python 3.11+" },
    "python 3.8": { eol: "Oct 2024", replacement: "Python 3.11+" },
  };

  for (const p of projects) {
    // Check MUI v4/v5 coexistence
    if (p.deps["@mui/material"] && p.deps["@material-ui/core"]) {
      findings.push({
        check: "dep-conflict",
        status: "warn",
        message: `${p.name}: MUI v4 AND v5 both installed — should consolidate to v5`,
        project: p.name,
        severity: "medium",
        remediation: `Migrate all @material-ui/* imports to @mui/* equivalents`,
      });
    }

    // Check for very old react-scripts
    if (p.deps["react-scripts"]) {
      const version = p.deps["react-scripts"].replace(/[^0-9.]/g, "");
      const major = parseInt(version.split(".")[0], 10);
      if (major < 5) {
        findings.push({
          check: "dep-outdated",
          status: "warn",
          message: `${p.name}: react-scripts v${version} (CRA is deprecated — consider Vite migration)`,
          project: p.name,
          severity: "medium",
          remediation: `Migrate to Vite: npm create vite@latest -- --template react-ts`,
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Compliance Agent — Full Audit
// ---------------------------------------------------------------------------

/**
 * Run the full compliance audit across all projects.
 * Returns a structured plan document.
 */
export function runComplianceAudit(projectDirs: ProjectDirectory[]): AuditPlan {
  const projects = listProjects(projectDirs);
  const portResult = checkPorts(projectDirs);

  const findings: AuditFinding[] = [];

  // Port conflicts
  for (const conflict of portResult.conflicts) {
    findings.push({
      check: "port-conflict",
      status: "fail",
      message: `Port ${conflict.port} used by: ${conflict.usages.map(u => `${u.project} (${u.source}: ${u.details})`).join(", ")}`,
      severity: "high",
    });
  }

  // All individual audit checks
  findings.push(...auditGitRemotes(projects));
  findings.push(...auditGitHooks(projects));
  findings.push(...auditEnvFiles(projects));
  findings.push(...auditDocker(projects));
  findings.push(...auditPm2(projects));
  findings.push(...auditVersions(projects));

  // Generate remediation steps for failures
  const steps: PlanStep[] = [];
  for (const f of findings) {
    if (f.status === "fail" && f.remediation) {
      steps.push({
        action: `Fix: ${f.check}`,
        description: f.message,
        command: f.command || f.remediation,
        risk: f.severity === "critical" ? "red" : "yellow",
        reversible: f.check !== "env-file", // most are reversible
        estimatedTime: "30s",
      });
    }
  }

  const summary = {
    pass: findings.filter(f => f.status === "pass").length,
    warn: findings.filter(f => f.status === "warn").length,
    fail: findings.filter(f => f.status === "fail").length,
    critical: findings.filter(f => f.severity === "critical").length,
  };

  return {
    agent: "Compliance Agent",
    timestamp: new Date().toISOString(),
    trigger: "manual",
    scope: `${projectDirs.length} projects`,
    findings,
    steps,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Plan Document Formatter
// ---------------------------------------------------------------------------

/**
 * Format an audit plan as a readable Markdown document.
 */
export function formatPlan(plan: AuditPlan): string {
  const lines: string[] = [];

  lines.push(`## 📋 Agent Plan: ${plan.agent} — ${plan.timestamp.split("T")[0]}`);
  lines.push("");
  lines.push(`### Context`);
  lines.push(`- **Trigger**: ${plan.trigger}`);
  lines.push(`- **Scope**: ${plan.scope}`);
  lines.push(`- **Summary**: ✅ ${plan.summary.pass} pass | ⚠ ${plan.summary.warn} warn | ❌ ${plan.summary.fail} fail | 🔴 ${plan.summary.critical} critical`);
  lines.push("");

  // Findings grouped by status
  const failures = plan.findings.filter(f => f.status === "fail");
  const warnings = plan.findings.filter(f => f.status === "warn");
  const passes = plan.findings.filter(f => f.status === "pass");

  if (failures.length > 0) {
    lines.push(`### ❌ Failures (${failures.length})`);
    for (const f of failures) {
      const severity = f.severity === "critical" ? "🔴 CRITICAL" : `⚠ ${f.severity}`;
      lines.push(`- **[${severity}] ${f.check}**: ${f.message}`);
      if (f.remediation) {
        lines.push(`  - Fix: \`${f.remediation}\``);
      }
    }
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push(`### ⚠ Warnings (${warnings.length})`);
    for (const f of warnings) {
      lines.push(`- **${f.check}**: ${f.message}`);
      if (f.remediation) {
        lines.push(`  - Fix: \`${f.remediation}\``);
      }
    }
    lines.push("");
  }

  if (passes.length > 0) {
    lines.push(`### ✅ Passed (${passes.length})`);
    for (const f of passes) {
      lines.push(`- ${f.check}: ${f.message}`);
    }
    lines.push("");
  }

  // Remediation steps
  if (plan.steps.length > 0) {
    lines.push(`### 🛠 Proposed Remediation Steps`);
    lines.push("");
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i];
      const risk = s.risk === "red" ? "🔴 High" : s.risk === "yellow" ? "🟡 Medium" : "🟢 Low";
      lines.push(`${i + 1}. **${s.action}** — ${s.description}`);
      if (s.command) {
        lines.push(`   - Command: \`${s.command}\``);
      }
      lines.push(`   - Risk: ${risk} | Reversible: ${s.reversible ? "Yes" : "No"} | Time: ${s.estimatedTime}`);
    }
    lines.push("");
    lines.push(`> ⚠ Review each step before approving. Only approved steps will be executed.`);
  }

  return lines.join("\n");
}

/**
 * Format project list as a readable summary.
 */
export function formatProjectList(projects: ProjectInfo[]): string {
  const lines: string[] = [];

  lines.push(`## 📂 FASTPROD Projects — ${projects.length} discovered`);
  lines.push("");

  // Group by type
  const grouped = new Map<string, ProjectInfo[]>();
  for (const p of projects) {
    const key = p.type;
    const list = grouped.get(key) || [];
    list.push(p);
    grouped.set(key, list);
  }

  for (const [type, projs] of grouped) {
    lines.push(`### ${type.toUpperCase()} (${projs.length})`);
    for (const p of projs) {
      const remotes = p.gitRemotes.length > 0 ? p.gitRemotes.join(", ") : "none";
      const depList = Object.entries(p.deps).map(([k, v]) => `${k}@${v}`).join(", ");
      const flags = [
        p.hasGit ? "git" : null,
        p.hasDocker ? "docker" : null,
        p.hasPm2 ? "pm2" : null,
      ].filter(Boolean).join("+");

      lines.push(`- **${p.name}** — ${p.framework} (${p.runtime})`);
      lines.push(`  - Path: ${p.path}`);
      if (depList) lines.push(`  - Key deps: ${depList}`);
      lines.push(`  - Infra: ${flags || "none"} | Remotes: ${remotes}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format port map as a readable table.
 */
export function formatPortMap(ports: PortUsage[], conflicts: Array<{ port: number; usages: PortUsage[] }>): string {
  const lines: string[] = [];

  lines.push(`## 🔌 Port Allocation Map`);
  lines.push("");

  if (conflicts.length > 0) {
    lines.push(`### ⚠ Conflicts (${conflicts.length})`);
    for (const c of conflicts) {
      lines.push(`- **Port ${c.port}**: ${c.usages.map(u => `${u.project}/${u.source} (${u.details})`).join(" vs ")}`);
    }
    lines.push("");
  }

  // Sort by port number
  const sorted = [...ports].sort((a, b) => a.port - b.port);
  lines.push("| Port | Project | Source | Details |");
  lines.push("|------|---------|--------|---------|");
  for (const p of sorted) {
    lines.push(`| ${p.port} | ${p.project} | ${p.source} | ${p.details} |`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// AI-Readiness Scoring — score_project tool
// ---------------------------------------------------------------------------

export interface ScoreCheck {
  name: string;
  category: string;
  points: number;
  maxPoints: number;
  status: "pass" | "partial" | "fail";
  detail: string;
}

export interface ProjectScore {
  project: string;
  path: string;
  score: number;
  maxScore: number;
  percentage: number;
  grade: string; // A+ to F
  checks: ScoreCheck[];
}

/**
 * Score a project's AI-readiness (0-100%).
 * Checks how well-prepared a project is for AI coding agents.
 */
export function scoreProject(dir: ProjectDirectory): ProjectScore {
  const checks: ScoreCheck[] = [];
  const p = dir.path;

  // --- Documentation (30 points max) ---

  // copilot-instructions.md (10 pts)
  const copilotPath = join(p, ".github", "copilot-instructions.md");
  if (existsSync(copilotPath)) {
    const content = readFileSync(copilotPath, "utf-8");
    const lines = content.split("\n").length;
    if (lines > 50) {
      checks.push({ name: "copilot-instructions.md", category: "Documentation", points: 10, maxPoints: 10, status: "pass", detail: `${lines} lines — comprehensive` });
    } else {
      checks.push({ name: "copilot-instructions.md", category: "Documentation", points: 6, maxPoints: 10, status: "partial", detail: `${lines} lines — could be more detailed` });
    }
  } else {
    checks.push({ name: "copilot-instructions.md", category: "Documentation", points: 0, maxPoints: 10, status: "fail", detail: "Missing — AI agents lack project context" });
  }

  // README.md (8 pts)
  const readmePath = join(p, "README.md");
  if (existsSync(readmePath)) {
    const content = readFileSync(readmePath, "utf-8");
    const readmeLines = content.split("\n").length;
    if (readmeLines > 30) {
      checks.push({ name: "README.md", category: "Documentation", points: 8, maxPoints: 8, status: "pass", detail: `${readmeLines} lines` });
    } else {
      checks.push({ name: "README.md", category: "Documentation", points: 4, maxPoints: 8, status: "partial", detail: `${readmeLines} lines — sparse` });
    }
  } else {
    checks.push({ name: "README.md", category: "Documentation", points: 0, maxPoints: 8, status: "fail", detail: "Missing" });
  }

  // CLAUDE.md / .cursorrules / AGENTS.md (6 pts)
  const altPatterns = ["CLAUDE.md", ".cursorrules", ".cursor/rules", "AGENTS.md"];
  const foundAlt = altPatterns.filter(pat => existsSync(join(p, pat)));
  if (foundAlt.length >= 2) {
    checks.push({ name: "Multi-agent patterns", category: "Documentation", points: 6, maxPoints: 6, status: "pass", detail: `Found: ${foundAlt.join(", ")}` });
  } else if (foundAlt.length === 1) {
    checks.push({ name: "Multi-agent patterns", category: "Documentation", points: 3, maxPoints: 6, status: "partial", detail: `Found: ${foundAlt[0]} only` });
  } else {
    checks.push({ name: "Multi-agent patterns", category: "Documentation", points: 0, maxPoints: 6, status: "fail", detail: "No CLAUDE.md, .cursorrules, or AGENTS.md" });
  }

  // .github/SKILLS.md (3 pts)
  const skillsPath = join(p, ".github", "SKILLS.md");
  if (existsSync(skillsPath)) {
    checks.push({ name: "SKILLS.md", category: "Documentation", points: 3, maxPoints: 3, status: "pass", detail: "Present" });
  } else {
    checks.push({ name: "SKILLS.md", category: "Documentation", points: 0, maxPoints: 3, status: "fail", detail: "Missing — agents can't discover capabilities" });
  }

  // .env.example (3 pts)
  const envExamplePath = join(p, ".env.example");
  if (existsSync(envExamplePath)) {
    checks.push({ name: ".env.example", category: "Documentation", points: 3, maxPoints: 3, status: "pass", detail: "Present — agents know which env vars to set" });
  } else {
    checks.push({ name: ".env.example", category: "Documentation", points: 0, maxPoints: 3, status: "fail", detail: "Missing — agents can't set up env" });
  }

  // --- Infrastructure (30 points max) ---

  // Git repo (5 pts)
  if (existsSync(join(p, ".git"))) {
    checks.push({ name: "Git repository", category: "Infrastructure", points: 5, maxPoints: 5, status: "pass", detail: "Initialized" });
  } else {
    checks.push({ name: "Git repository", category: "Infrastructure", points: 0, maxPoints: 5, status: "fail", detail: "Not a git repo" });
  }

  // .gitignore (3 pts)
  if (existsSync(join(p, ".gitignore"))) {
    checks.push({ name: ".gitignore", category: "Infrastructure", points: 3, maxPoints: 3, status: "pass", detail: "Present" });
  } else {
    checks.push({ name: ".gitignore", category: "Infrastructure", points: 0, maxPoints: 3, status: "fail", detail: "Missing" });
  }

  // Git hooks (5 pts)
  const hookDir = join(p, "hooks");
  const gitHookDir = join(p, ".git", "hooks");
  const hasPostCommit = existsSync(join(hookDir, "post-commit")) || existsSync(join(gitHookDir, "post-commit"));
  if (hasPostCommit) {
    checks.push({ name: "Git hooks", category: "Infrastructure", points: 5, maxPoints: 5, status: "pass", detail: "post-commit hook configured" });
  } else {
    checks.push({ name: "Git hooks", category: "Infrastructure", points: 0, maxPoints: 5, status: "fail", detail: "No hooks — consider auto-push" });
  }

  // Docker / containerization (5 pts)
  const hasDockerfile = existsSync(join(p, "Dockerfile"));
  const hasCompose = existsSync(join(p, "docker-compose.yml")) || existsSync(join(p, "docker-compose.prod.yml"));
  if (hasDockerfile && hasCompose) {
    checks.push({ name: "Docker", category: "Infrastructure", points: 5, maxPoints: 5, status: "pass", detail: "Dockerfile + compose" });
  } else if (hasDockerfile || hasCompose) {
    checks.push({ name: "Docker", category: "Infrastructure", points: 3, maxPoints: 5, status: "partial", detail: hasDockerfile ? "Dockerfile only" : "Compose only" });
  } else {
    checks.push({ name: "Docker", category: "Infrastructure", points: 0, maxPoints: 5, status: "fail", detail: "Not containerized" });
  }

  // CI config (5 pts)
  const ciPaths = [".github/workflows", ".gitlab-ci.yml", "Jenkinsfile", ".circleci", ".travis.yml"];
  const foundCI = ciPaths.filter(ci => existsSync(join(p, ci)));
  if (foundCI.length > 0) {
    checks.push({ name: "CI/CD", category: "Infrastructure", points: 5, maxPoints: 5, status: "pass", detail: foundCI.join(", ") });
  } else {
    checks.push({ name: "CI/CD", category: "Infrastructure", points: 0, maxPoints: 5, status: "fail", detail: "No CI pipeline" });
  }

  // Deploy script (4 pts)
  const deployPaths = ["deploy.sh", "deploy.js", "Makefile"];
  const foundDeploy = deployPaths.filter(d => existsSync(join(p, d)));
  if (foundDeploy.length > 0) {
    checks.push({ name: "Deploy script", category: "Infrastructure", points: 4, maxPoints: 4, status: "pass", detail: foundDeploy.join(", ") });
  } else {
    checks.push({ name: "Deploy script", category: "Infrastructure", points: 0, maxPoints: 4, status: "fail", detail: "No deploy automation" });
  }

  // PM2 / process manager (3 pts)
  if (existsSync(join(p, "ecosystem.config.js")) || existsSync(join(p, "ecosystem.config.cjs"))) {
    checks.push({ name: "Process manager", category: "Infrastructure", points: 3, maxPoints: 3, status: "pass", detail: "PM2 ecosystem config" });
  } else {
    checks.push({ name: "Process manager", category: "Infrastructure", points: 0, maxPoints: 3, status: "fail", detail: "No PM2 config" });
  }

  // --- Code Quality (20 points max) ---

  // Tests directory (8 pts)
  const testDirs = ["tests", "test", "__tests__", "spec", "src/__tests__"];
  const foundTests = testDirs.filter(td => existsSync(join(p, td)));
  if (foundTests.length > 0) {
    const testDir = join(p, foundTests[0]);
    try {
      const hasFiles = readdirSync(testDir).length > 0;
      if (hasFiles) {
        checks.push({ name: "Tests", category: "Code Quality", points: 8, maxPoints: 8, status: "pass", detail: `${foundTests[0]}/ directory with files` });
      } else {
        checks.push({ name: "Tests", category: "Code Quality", points: 3, maxPoints: 8, status: "partial", detail: `${foundTests[0]}/ exists but empty` });
      }
    } catch {
      checks.push({ name: "Tests", category: "Code Quality", points: 3, maxPoints: 8, status: "partial", detail: `${foundTests[0]}/ exists` });
    }
  } else {
    checks.push({ name: "Tests", category: "Code Quality", points: 0, maxPoints: 8, status: "fail", detail: "No test directory" });
  }

  // TypeScript / type checking (5 pts)
  if (existsSync(join(p, "tsconfig.json"))) {
    checks.push({ name: "TypeScript", category: "Code Quality", points: 5, maxPoints: 5, status: "pass", detail: "tsconfig.json present" });
  } else if (existsSync(join(p, "jsconfig.json"))) {
    checks.push({ name: "Type checking", category: "Code Quality", points: 2, maxPoints: 5, status: "partial", detail: "jsconfig.json only" });
  } else {
    checks.push({ name: "Type checking", category: "Code Quality", points: 0, maxPoints: 5, status: "fail", detail: "No tsconfig/jsconfig" });
  }

  // Linting config (4 pts)
  const lintConfigs = [".eslintrc.js", ".eslintrc.json", ".eslintrc.yml", "eslint.config.js", "eslint.config.mjs", ".prettierrc", "phpcs.xml"];
  const foundLint = lintConfigs.filter(l => existsSync(join(p, l)));
  if (foundLint.length > 0) {
    checks.push({ name: "Linting", category: "Code Quality", points: 4, maxPoints: 4, status: "pass", detail: foundLint.join(", ") });
  } else {
    checks.push({ name: "Linting", category: "Code Quality", points: 0, maxPoints: 4, status: "fail", detail: "No lint config" });
  }

  // Package scripts / build commands (3 pts)
  const pkgPath = join(p, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = Object.keys(pkg.scripts || {});
      const hasUseful = scripts.some(s => ["build", "dev", "start", "test", "lint"].includes(s));
      if (hasUseful) {
        checks.push({ name: "npm scripts", category: "Code Quality", points: 3, maxPoints: 3, status: "pass", detail: scripts.slice(0, 6).join(", ") });
      } else {
        checks.push({ name: "npm scripts", category: "Code Quality", points: 1, maxPoints: 3, status: "partial", detail: `Has scripts but no build/dev/test: ${scripts.join(", ")}` });
      }
    } catch { /* ignore */ }
  }

  // --- Security (20 points max) ---

  // .env in .gitignore (8 pts)
  const gitignorePath = join(p, ".gitignore");
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, "utf-8");
    if (gitignore.includes(".env")) {
      checks.push({ name: ".env in .gitignore", category: "Security", points: 8, maxPoints: 8, status: "pass", detail: ".env is gitignored" });
    } else {
      checks.push({ name: ".env in .gitignore", category: "Security", points: 0, maxPoints: 8, status: "fail", detail: ".env NOT in .gitignore — secrets at risk!" });
    }
  } else {
    checks.push({ name: ".env in .gitignore", category: "Security", points: 0, maxPoints: 8, status: "fail", detail: "No .gitignore at all" });
  }

  // No secrets in tracked files (6 pts)
  if (existsSync(join(p, ".env")) && existsSync(join(p, ".git"))) {
    const tracked = exec("git ls-files .env", p);
    if (tracked === ".env") {
      checks.push({ name: "Secrets exposure", category: "Security", points: 0, maxPoints: 6, status: "fail", detail: ".env is tracked by git!" });
    } else {
      checks.push({ name: "Secrets exposure", category: "Security", points: 6, maxPoints: 6, status: "pass", detail: ".env not tracked" });
    }
  } else {
    checks.push({ name: "Secrets exposure", category: "Security", points: 6, maxPoints: 6, status: "pass", detail: "No .env or not a git repo" });
  }

  // Lockfile present (3 pts)
  const lockfiles = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock"];
  const foundLock = lockfiles.filter(l => existsSync(join(p, l)));
  if (foundLock.length > 0) {
    checks.push({ name: "Lockfile", category: "Security", points: 3, maxPoints: 3, status: "pass", detail: foundLock.join(", ") });
  } else if (existsSync(pkgPath) || existsSync(join(p, "composer.json"))) {
    checks.push({ name: "Lockfile", category: "Security", points: 0, maxPoints: 3, status: "fail", detail: "No lockfile — deps not pinned" });
  }

  // node_modules in .gitignore (3 pts)
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, "utf-8");
    if (gitignore.includes("node_modules") || gitignore.includes("vendor")) {
      checks.push({ name: "Deps gitignored", category: "Security", points: 3, maxPoints: 3, status: "pass", detail: "node_modules/vendor gitignored" });
    } else if (!existsSync(join(p, "package.json")) && !existsSync(join(p, "composer.json"))) {
      checks.push({ name: "Deps gitignored", category: "Security", points: 3, maxPoints: 3, status: "pass", detail: "N/A — no package manager" });
    } else {
      checks.push({ name: "Deps gitignored", category: "Security", points: 0, maxPoints: 3, status: "fail", detail: "node_modules/vendor not in .gitignore" });
    }
  }

  // --- Calculate totals ---
  const totalScore = checks.reduce((sum, c) => sum + c.points, 0);
  const maxScore = checks.reduce((sum, c) => sum + c.maxPoints, 0);
  const percentage = Math.round((totalScore / maxScore) * 100);

  let grade: string;
  if (percentage >= 90) grade = "A+";
  else if (percentage >= 80) grade = "A";
  else if (percentage >= 70) grade = "B";
  else if (percentage >= 60) grade = "C";
  else if (percentage >= 50) grade = "D";
  else grade = "F";

  return {
    project: dir.name,
    path: dir.path,
    score: totalScore,
    maxScore,
    percentage,
    grade,
    checks,
  };
}

/**
 * Format a project score report as Markdown.
 */
export function formatScoreReport(scores: ProjectScore[]): string {
  const lines: string[] = [];

  // Summary table
  lines.push("# 🎯 AI-Readiness Scores\n");
  lines.push("| Project | Score | Grade | Doc | Infra | Quality | Security |");
  lines.push("|---------|-------|-------|-----|-------|---------|----------|");

  for (const s of scores) {
    const byCategory = new Map<string, { pts: number; max: number }>();
    for (const c of s.checks) {
      const cat = byCategory.get(c.category) || { pts: 0, max: 0 };
      cat.pts += c.points;
      cat.max += c.maxPoints;
      byCategory.set(c.category, cat);
    }

    const doc = byCategory.get("Documentation") || { pts: 0, max: 0 };
    const infra = byCategory.get("Infrastructure") || { pts: 0, max: 0 };
    const quality = byCategory.get("Code Quality") || { pts: 0, max: 0 };
    const security = byCategory.get("Security") || { pts: 0, max: 0 };

    const gradeEmoji = s.percentage >= 80 ? "🟢" : s.percentage >= 60 ? "🟡" : "🔴";

    lines.push(
      `| ${s.project} | **${s.percentage}%** | ${gradeEmoji} ${s.grade} | ${doc.pts}/${doc.max} | ${infra.pts}/${infra.max} | ${quality.pts}/${quality.max} | ${security.pts}/${security.max} |`
    );
  }

  // Sort by score descending
  const sorted = [...scores].sort((a, b) => b.percentage - a.percentage);

  // Top performers
  const top3 = sorted.slice(0, 3);
  lines.push("\n## 🏆 Top Performers");
  for (const s of top3) {
    lines.push(`- **${s.project}** — ${s.percentage}% (${s.grade})`);
  }

  // Needs work
  const needsWork = sorted.filter(s => s.percentage < 60);
  if (needsWork.length > 0) {
    lines.push("\n## ⚠️ Needs Work");
    for (const s of needsWork) {
      const fails = s.checks.filter(c => c.status === "fail");
      lines.push(`- **${s.project}** — ${s.percentage}% (${s.grade}): ${fails.map(f => f.name).join(", ")}`);
    }
  }

  // Detailed per-project breakdown (top 5 only to keep output manageable)
  lines.push("\n## 📋 Detailed Breakdown\n");
  for (const s of sorted.slice(0, 5)) {
    lines.push(`### ${s.project} — ${s.percentage}% (${s.grade})\n`);
    lines.push("| Check | Category | Score | Status | Detail |");
    lines.push("|-------|----------|-------|--------|--------|");
    for (const c of s.checks) {
      const icon = c.status === "pass" ? "✅" : c.status === "partial" ? "🟡" : "❌";
      lines.push(`| ${c.name} | ${c.category} | ${c.points}/${c.maxPoints} | ${icon} | ${c.detail} |`);
    }
    lines.push("");
  }

  // Overall stats
  const avgScore = Math.round(scores.reduce((sum, s) => sum + s.percentage, 0) / scores.length);
  lines.push(`\n---\n**${scores.length} projects scanned** | Average AI-readiness: **${avgScore}%**`);

  return lines.join("\n");
}

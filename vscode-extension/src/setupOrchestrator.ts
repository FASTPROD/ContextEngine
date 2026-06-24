/**
 * Setup Orchestrator — robust one-click install/uninstall for OpsContext.
 *
 * Replaces the old terminal-based `&&`-chain installer (which had zero
 * pre-checks, no per-step error capture, and dumped users at a `$` prompt
 * with red text). The new flow:
 *
 *   1. Pre-flight: `which node` + `which npm` via execFile — if missing,
 *      modal-prompt the user to install Node from nodejs.org.
 *   2. Pre-flight: hit http://127.0.0.1:7842/health — if 200, short-circuit
 *      with "Already installed" (still surfaces the next-steps modal).
 *   3. Per-step orchestration via `vscode.window.withProgress`. Each step is
 *      its own `cp.execFile` invocation; stdout/stderr stream to a dedicated
 *      "OpsContext Setup" OutputChannel so the user can see what's happening
 *      without a scary scrolling terminal of npm WARN noise.
 *   4. Idempotency: per-step exit codes are inspected. If a step reports the
 *      LaunchAgent / hook is already installed, we show a friendly
 *      "already installed — no changes needed" message instead of an error.
 *   5. On any hard failure, the notification carries an [Open Output] action
 *      that focuses the dedicated OutputChannel.
 *
 * Public API:
 *   - `runSetup(extensionOutput)` — implements `contextengine.setup`
 *   - `runUninstall(extensionOutput)` — implements `contextengine.uninstall`
 *
 * Both functions are async and return when the orchestration finishes (after
 * the user dismisses the final modal).
 *
 * Cross-platform note: install-autostart is macOS-only (LaunchAgent). On
 * Linux/Windows we skip step 2 with a friendly OutputChannel note. The whole
 * setup command on non-macOS still runs steps 1 and 3, and the entry-point
 * in extension.ts continues to gate the whole command behind the
 * "macOS-only" modal for non-darwin platforms to preserve prior behaviour.
 *
 * @module setupOrchestrator
 */

import * as vscode from "vscode";
import * as cp from "child_process";
import * as http from "http";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Local health endpoint exposed by the @compr/opscontext-mcp daemon. */
const HEALTH_URL = "http://127.0.0.1:7842/health";

/** How long to wait for the health probe before assuming the daemon is down. */
const HEALTH_TIMEOUT_MS = 1_000;

/** Hard cap on each install step. npm install -g can be slow on cold caches. */
const STEP_TIMEOUT_MS = 5 * 60 * 1_000; // 5 min

/** nodejs.org download landing page — surfaced when `node`/`npm` are missing. */
const NODEJS_DOWNLOAD_URL = "https://nodejs.org/en/download";

// ---------------------------------------------------------------------------
// Dedicated OutputChannel (created lazily so the cost is zero until used)
// ---------------------------------------------------------------------------

let setupChannel: vscode.OutputChannel | undefined;

function getSetupChannel(): vscode.OutputChannel {
  if (!setupChannel) {
    setupChannel = vscode.window.createOutputChannel("OpsContext Setup");
  }
  return setupChannel;
}

// ---------------------------------------------------------------------------
// execFile wrapper — returns { code, stdout, stderr } instead of throwing
// ---------------------------------------------------------------------------

interface StepResult {
  code: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

/**
 * Runs a command as a separate process (no shell, no terminal) and captures
 * stdout/stderr. Streams output to the provided channel as it arrives.
 *
 * Why not `cp.exec`? `exec` spawns through `/bin/sh -c` which means the
 * caller has to worry about shell quoting + injection. `execFile` takes an
 * argv array — safer and matches the audit recommendation verbatim.
 */
async function runStep(
  channel: vscode.OutputChannel,
  label: string,
  cmd: string,
  args: string[]
): Promise<StepResult> {
  channel.appendLine("");
  channel.appendLine(`── ${label} ──`);
  channel.appendLine(`$ ${cmd} ${args.join(" ")}`);

  return new Promise<StepResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = cp.execFile(
      cmd,
      args,
      { timeout: STEP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdoutFinal, stderrFinal) => {
        // The streaming `data` listeners below may have already accumulated
        // the same content; prefer them but fall back to the final buffers
        // if for some reason they're empty (e.g. fd dropped early).
        if (!stdout && stdoutFinal) stdout = stdoutFinal.toString();
        if (!stderr && stderrFinal) stderr = stderrFinal.toString();

        const code = error && typeof error.code === "number" ? error.code : (error ? 1 : 0);
        resolve({ code, stdout, stderr, error: error ?? undefined });
      }
    );

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      channel.append(text);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // npm writes a lot of progress to stderr; mirror it so users see it.
      channel.append(text);
    });
  });
}

// ---------------------------------------------------------------------------
// Pre-flight: Node / npm presence check
// ---------------------------------------------------------------------------

/**
 * Resolve a binary on PATH. Returns the resolved path or null if missing.
 * Uses `which` on POSIX and `where` on Windows — both are present out of
 * the box on every supported platform.
 */
async function whichBin(bin: string): Promise<string | null> {
  const probe = process.platform === "win32" ? "where" : "which";
  return new Promise<string | null>((resolve) => {
    cp.execFile(probe, [bin], { timeout: 5_000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const first = stdout.toString().split(/\r?\n/).find((l) => l.trim().length > 0);
      resolve(first ? first.trim() : null);
    });
  });
}

/**
 * Checks that `node` and `npm` are on PATH. On failure, shows a modal with
 * an [Open Download Page] button (calls `vscode.env.openExternal`).
 *
 * @returns true if both binaries are present, false if the user needs to
 *   install them (caller should abort the flow).
 */
async function ensureNodeToolchain(channel: vscode.OutputChannel): Promise<boolean> {
  const [nodePath, npmPath] = await Promise.all([whichBin("node"), whichBin("npm")]);

  if (nodePath && npmPath) {
    channel.appendLine(`[pre-flight] node: ${nodePath}`);
    channel.appendLine(`[pre-flight] npm:  ${npmPath}`);
    return true;
  }

  channel.appendLine("[pre-flight] node or npm not found on PATH");
  channel.appendLine(`  node: ${nodePath ?? "MISSING"}`);
  channel.appendLine(`  npm:  ${npmPath ?? "MISSING"}`);

  const action = await vscode.window.showWarningMessage(
    "OpsContext needs Node.js (and the npm CLI) to run.\n\n" +
      "Install Node.js from nodejs.org, then run “OpsContext: Set up” again.",
    { modal: true },
    "Open Download Page",
    "Cancel"
  );

  if (action === "Open Download Page") {
    await vscode.env.openExternal(vscode.Uri.parse(NODEJS_DOWNLOAD_URL));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pre-flight: health probe
// ---------------------------------------------------------------------------

/**
 * Hits the local OpsContext health endpoint. Resolves to true if the daemon
 * responds with HTTP 200 within HEALTH_TIMEOUT_MS, false otherwise.
 *
 * No external deps — uses the Node built-in `http` module so we don't pull
 * in `node-fetch` / `axios` just for one request.
 */
async function probeHealth(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: HEALTH_TIMEOUT_MS }, (res) => {
      const ok = res.statusCode === 200;
      // Drain so the socket can close cleanly.
      res.resume();
      resolve(ok);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Idempotency heuristics
// ---------------------------------------------------------------------------

/**
 * The install-autostart CLI returns non-zero when the LaunchAgent plist
 * already exists. We don't want to scare the user — interpret a stderr that
 * mentions "already exists" / "already installed" as a soft-success and
 * carry on. Same heuristic for install-claude-hook.
 *
 * We keep this LOOSE on purpose: the underlying CLI message wording is not
 * stable across versions, so we sniff a handful of phrases. False positives
 * here are harmless (we'd just claim "already installed" when in fact the
 * install actually succeeded with a stale warning).
 */
function looksAlreadyInstalled(result: StepResult): boolean {
  if (result.code === 0) return false;
  const blob = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    blob.includes("already exists") ||
    blob.includes("already installed") ||
    blob.includes("already wired") ||
    blob.includes("no changes needed") ||
    blob.includes("plist already")
  );
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

/**
 * Surface a per-step failure to the user with an [Open Output] action that
 * focuses the dedicated OutputChannel. Keeps the error message short — the
 * full log lives in the channel where it belongs.
 */
async function showStepFailure(
  channel: vscode.OutputChannel,
  stepLabel: string,
  result: StepResult
): Promise<void> {
  channel.appendLine("");
  channel.appendLine(`[FAIL] ${stepLabel} — exit code ${result.code}`);
  if (result.stderr.trim()) {
    channel.appendLine(`stderr: ${result.stderr.trim()}`);
  }

  const oneLine = (result.stderr.trim() || result.stdout.trim() || result.error?.message || "unknown error")
    .split("\n")[0]
    .slice(0, 200);

  const action = await vscode.window.showErrorMessage(
    `OpsContext setup: ${stepLabel} failed — ${oneLine}`,
    "Open Output",
    "Dismiss"
  );
  if (action === "Open Output") {
    channel.show(true);
  }
}

// ---------------------------------------------------------------------------
// Success modal
// ---------------------------------------------------------------------------

/**
 * Shows the post-install celebratory modal with three buttons. Centralised
 * so both the happy-path and the "already installed" short-circuit can call
 * it without duplicating button strings / handlers.
 */
async function showSuccessModal(): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "OpsContext setup complete — what's next?",
    { modal: true },
    "Open claude.ai",
    "Try @contextengine in Copilot Chat",
    "Done"
  );
  if (choice === "Open claude.ai") {
    await vscode.env.openExternal(vscode.Uri.parse("https://claude.ai/"));
  } else if (choice === "Try @contextengine in Copilot Chat") {
    // workbench.action.chat.open accepts an initial prompt.
    await vscode.commands.executeCommand("workbench.action.chat.open", "@contextengine status");
  }
}

// ---------------------------------------------------------------------------
// Public: runSetup
// ---------------------------------------------------------------------------

/**
 * Implements the `contextengine.setup` command — the flagship one-click
 * installer. Designed for non-tech "vibe coder" users on stock macOS.
 *
 * @param extensionOutput — the main OpsContext output channel; receives a
 *   one-line summary at the end. The per-step noise goes to the dedicated
 *   "OpsContext Setup" channel so the main channel stays readable.
 */
export async function runSetup(extensionOutput: vscode.OutputChannel): Promise<void> {
  const channel = getSetupChannel();
  channel.clear();
  channel.appendLine(`OpsContext setup — ${new Date().toISOString()}`);
  channel.appendLine(`platform: ${process.platform}`);

  // -- 1. Confirmation modal ------------------------------------------------
  const isDarwin = process.platform === "darwin";
  const confirm = await vscode.window.showInformationMessage(
    "Set up OpsContext on this machine? This will:\n" +
      "  1. npm install -g @compr/opscontext-mcp\n" +
      (isDarwin ? "  2. Install a macOS LaunchAgent (auto-start at login)\n" : "  2. (Linux/Windows: skipped — LaunchAgent is macOS-only)\n") +
      "  3. Wire Claude Code hooks (capture terminal prompts)\n\n" +
      "Each step's output streams to the “OpsContext Setup” panel. Proceed?",
    { modal: true },
    "Install",
    "Cancel"
  );
  if (confirm !== "Install") {
    channel.appendLine("[abort] user cancelled at confirmation modal");
    return;
  }

  // -- 2. Pre-flight: node + npm -------------------------------------------
  const hasToolchain = await ensureNodeToolchain(channel);
  if (!hasToolchain) {
    extensionOutput.appendLine("Setup aborted — Node.js / npm not on PATH");
    return;
  }

  // -- 3. Pre-flight: health probe (short-circuit if already running) ------
  channel.appendLine(`[pre-flight] probing ${HEALTH_URL}…`);
  const alreadyRunning = await probeHealth();
  if (alreadyRunning) {
    channel.appendLine("[pre-flight] daemon responded — OpsContext is already installed");
    const choice = await vscode.window.showInformationMessage(
      "OpsContext server is already running. Run setup anyway?",
      { modal: true },
      "Re-install",
      "Cancel"
    );
    if (choice !== "Re-install") {
      // User dismissed: still show the next-steps modal so they get the
      // [Open claude.ai] / [Try @contextengine] buttons.
      await showSuccessModal();
      return;
    }
  } else {
    channel.appendLine("[pre-flight] no daemon detected — proceeding with install");
  }

  // -- 4. Per-step orchestration -------------------------------------------
  // Show the channel so users see progress without having to click around.
  channel.show(true);

  let stepFailed = false;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "OpsContext setup",
      cancellable: false,
    },
    async (progress) => {
      // Step 1/3: npm install -g @compr/opscontext-mcp
      progress.report({ message: "Downloading OpsContext server (1/3)…", increment: 0 });
      const step1 = await runStep(
        channel,
        "Step 1/3: npm install -g @compr/opscontext-mcp",
        "npm",
        ["install", "-g", "@compr/opscontext-mcp"]
      );
      if (step1.code !== 0) {
        // npm failures here are the EACCES / network-down class. Always hard-fail.
        await showStepFailure(channel, "npm install -g @compr/opscontext-mcp", step1);
        stepFailed = true;
        return;
      }

      // Step 2/3: opscontext install-autostart (macOS only)
      progress.report({ message: "Setting up auto-start (2/3)…", increment: 33 });
      if (isDarwin) {
        const step2 = await runStep(
          channel,
          "Step 2/3: opscontext install-autostart",
          "opscontext",
          ["install-autostart"]
        );
        if (step2.code !== 0) {
          if (looksAlreadyInstalled(step2)) {
            channel.appendLine("[idempotent] OpsContext is already auto-starting on login — no changes needed.");
          } else {
            await showStepFailure(channel, "opscontext install-autostart", step2);
            stepFailed = true;
            return;
          }
        }
      } else {
        channel.appendLine("[skip] install-autostart is macOS-only — skipping on " + process.platform);
      }

      // Step 3/3: opscontext install-claude-hook
      progress.report({ message: "Wiring Claude Code hook (3/3)…", increment: 33 });
      const step3 = await runStep(
        channel,
        "Step 3/3: opscontext install-claude-hook",
        "opscontext",
        ["install-claude-hook"]
      );
      if (step3.code !== 0) {
        if (looksAlreadyInstalled(step3)) {
          channel.appendLine("[idempotent] Claude Code hook is already wired — no changes needed.");
        } else {
          await showStepFailure(channel, "opscontext install-claude-hook", step3);
          stepFailed = true;
          return;
        }
      }

      progress.report({ message: "Done", increment: 34 });
    }
  );

  if (stepFailed) {
    extensionOutput.appendLine("Setup failed — see OpsContext Setup output channel for details");
    return;
  }

  channel.appendLine("");
  channel.appendLine("[OK] OpsContext setup complete.");
  extensionOutput.appendLine("Setup complete — npm package + auto-start + Claude hook installed");

  await showSuccessModal();
}

// ---------------------------------------------------------------------------
// Public: runUninstall
// ---------------------------------------------------------------------------

/**
 * Implements the `contextengine.uninstall` command — the clean-slate reset
 * users need when a partial install left the machine in a weird state.
 *
 * Mirrors `runSetup` step-for-step but in reverse, and tolerates each step
 * failing because the user might have already removed pieces manually.
 */
export async function runUninstall(extensionOutput: vscode.OutputChannel): Promise<void> {
  const channel = getSetupChannel();
  channel.clear();
  channel.appendLine(`OpsContext uninstall — ${new Date().toISOString()}`);
  channel.appendLine(`platform: ${process.platform}`);

  const confirm = await vscode.window.showWarningMessage(
    "Uninstall OpsContext? This will:\n" +
      "  1. Remove the macOS LaunchAgent (auto-start at login)\n" +
      "  2. Remove the Claude Code hook\n" +
      "  3. Uninstall the @compr/opscontext-mcp npm package\n\n" +
      "Your audit log and learnings under ~/.contextengine remain untouched. Proceed?",
    { modal: true },
    "Uninstall",
    "Cancel"
  );
  if (confirm !== "Uninstall") {
    channel.appendLine("[abort] user cancelled at confirmation modal");
    return;
  }

  // The npm uninstall step also needs `npm` on PATH — re-use the same probe.
  const [npmPath, opscontextPath] = await Promise.all([whichBin("npm"), whichBin("opscontext")]);
  channel.appendLine(`[pre-flight] npm:        ${npmPath ?? "MISSING"}`);
  channel.appendLine(`[pre-flight] opscontext: ${opscontextPath ?? "MISSING"}`);

  channel.show(true);

  let anyFailed = false;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "OpsContext uninstall",
      cancellable: false,
    },
    async (progress) => {
      // Step 1/3: opscontext uninstall-autostart (macOS only, idempotent on missing plist)
      progress.report({ message: "Removing auto-start (1/3)…", increment: 0 });
      if (process.platform === "darwin" && opscontextPath) {
        const s1 = await runStep(
          channel,
          "Step 1/3: opscontext uninstall-autostart",
          "opscontext",
          ["uninstall-autostart"]
        );
        if (s1.code !== 0 && !looksAlreadyInstalled(s1)) {
          // Soft-fail: log it but keep going. Uninstall should be best-effort.
          channel.appendLine(`[warn] uninstall-autostart exited ${s1.code} — continuing`);
          anyFailed = true;
        }
      } else {
        channel.appendLine("[skip] uninstall-autostart skipped (non-darwin or opscontext missing)");
      }

      // Step 2/3: opscontext uninstall-claude-hook
      progress.report({ message: "Removing Claude Code hook (2/3)…", increment: 33 });
      if (opscontextPath) {
        const s2 = await runStep(
          channel,
          "Step 2/3: opscontext uninstall-claude-hook",
          "opscontext",
          ["uninstall-claude-hook"]
        );
        if (s2.code !== 0 && !looksAlreadyInstalled(s2)) {
          channel.appendLine(`[warn] uninstall-claude-hook exited ${s2.code} — continuing`);
          anyFailed = true;
        }
      } else {
        channel.appendLine("[skip] uninstall-claude-hook skipped (opscontext not on PATH)");
      }

      // Step 3/3: npm uninstall -g @compr/opscontext-mcp
      progress.report({ message: "Uninstalling npm package (3/3)…", increment: 33 });
      if (npmPath) {
        const s3 = await runStep(
          channel,
          "Step 3/3: npm uninstall -g @compr/opscontext-mcp",
          "npm",
          ["uninstall", "-g", "@compr/opscontext-mcp"]
        );
        if (s3.code !== 0) {
          // npm uninstall on a package that isn't installed is non-zero on
          // some npm versions — treat as soft-fail.
          channel.appendLine(`[warn] npm uninstall exited ${s3.code} — continuing`);
          anyFailed = true;
        }
      } else {
        channel.appendLine("[skip] npm uninstall skipped (npm not on PATH)");
      }

      progress.report({ message: "Done", increment: 34 });
    }
  );

  channel.appendLine("");
  if (anyFailed) {
    channel.appendLine("[partial] one or more uninstall steps reported issues — see lines above");
    extensionOutput.appendLine("Uninstall finished with warnings — see OpsContext Setup output channel");
    const action = await vscode.window.showWarningMessage(
      "OpsContext uninstall finished with warnings. Some components may still be present.",
      "Open Output",
      "Dismiss"
    );
    if (action === "Open Output") channel.show(true);
  } else {
    channel.appendLine("[OK] OpsContext uninstalled.");
    extensionOutput.appendLine("OpsContext uninstalled");
    await vscode.window.showInformationMessage(
      "OpsContext uninstalled. Run “OpsContext: Set up” any time to re-install.",
      { modal: true },
      "Done"
    );
  }
}

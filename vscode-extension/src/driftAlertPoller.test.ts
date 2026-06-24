/**
 * Tests for DriftAlertPoller — runnable via Node's built-in `node:test`
 * once compiled to JS, e.g.:
 *
 *   npx tsc -p ./
 *   node --test dist/driftAlertPoller.test.js
 *
 * OR with tsx (no dev-dep required to install — left to the runner):
 *
 *   npx tsx --test src/driftAlertPoller.test.ts
 *
 * The tsconfig excludes `**\/*.test.ts` from `npm run compile` so this file
 * does NOT block the production build. It's checked-in source the team can
 * run on demand.
 *
 * We hand-roll a minimal `vscode` mock at the top of the file and patch
 * `require.cache` BEFORE importing the module under test so its top-level
 * `import * as vscode from "vscode"` resolves to our stub.
 *
 * Covers:
 *   1. A synthetic `drift.detected` line is delivered to
 *      NotificationManager.showDriftAlert with the correct severity + kind.
 *   2. A second poll over the same line does NOT re-fire (hash dedup).
 *   3. Muting a kind suppresses subsequent popups of that kind.
 *   4. dispose() is clean — timer stopped, no throws.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Module from "node:module";

// ---------------------------------------------------------------------------
// 1. Mock `vscode` BEFORE we import the modules under test.
// ---------------------------------------------------------------------------

interface FakeMemento {
  store: Map<string, unknown>;
  get<T>(k: string): T | undefined;
  update(k: string, v: unknown): Thenable<void>;
}

interface FakeOutputChannel {
  lines: string[];
  appendLine: (l: string) => void;
  append: (l: string) => void;
  show: () => void;
  hide: () => void;
  dispose: () => void;
  clear: () => void;
  replace: (s: string) => void;
  name: string;
}

interface FakeEvent<T> {
  fire: (v: T) => void;
  event: (cb: (v: T) => void) => { dispose: () => void };
  dispose: () => void;
}

function makeOutputChannel(): FakeOutputChannel {
  const lines: string[] = [];
  return {
    lines,
    appendLine: (l: string) => lines.push(l),
    append: (l: string) => lines.push(l),
    show: () => {},
    hide: () => {},
    dispose: () => {},
    clear: () => {
      lines.length = 0;
    },
    replace: (_s: string) => {},
    name: "test-output",
  };
}

function makeMemento(): FakeMemento {
  const store = new Map<string, unknown>();
  return {
    store,
    get<T>(k: string): T | undefined {
      return store.get(k) as T | undefined;
    },
    update(k: string, v: unknown): Thenable<void> {
      store.set(k, v);
      return Promise.resolve();
    },
  };
}

interface NotificationCall {
  severity: string;
  kind: string;
  reason: string;
}

const notificationCalls: NotificationCall[] = [];
let nextNotificationAction: string | undefined;
let muteKindCallback: ((k: string) => void) | undefined;

// The vscode stub. We expose only what driftAlertPoller.ts +
// notifications.ts actually touch.
const fakeConfigStore: Record<string, unknown> = {
  enableNotifications: true,
  enableDriftAlerts: true,
};

const vscodeStub = {
  EventEmitter: class<T> implements FakeEvent<T> {
    private _subs: Array<(v: T) => void> = [];
    fire(v: T) {
      for (const s of this._subs) s(v);
    }
    event = (cb: (v: T) => void): { dispose: () => void } => {
      this._subs.push(cb);
      return {
        dispose: () => {
          this._subs = this._subs.filter((s) => s !== cb);
        },
      };
    };
    dispose() {
      this._subs = [];
    }
  },
  Disposable: class {
    constructor(public callOnDispose: () => void = () => {}) {}
    dispose() {
      this.callOnDispose();
    }
  },
  workspace: {
    getConfiguration: (_section: string) => ({
      get: <T>(k: string, dflt: T): T =>
        (fakeConfigStore[k] as T | undefined) ?? dflt,
    }),
  },
  window: {
    showInformationMessage: async (
      _title: string,
      ..._actions: string[]
    ): Promise<string | undefined> => nextNotificationAction,
    showWarningMessage: async (
      _title: string,
      _optsOrAction?: unknown,
      ..._rest: string[]
    ): Promise<string | undefined> => nextNotificationAction,
  },
  commands: {
    executeCommand: async (_cmd: string): Promise<void> => {},
  },
};

// Patch Node's module resolution so `require("vscode")` returns our stub.
// Approach: stuff an entry into require.cache keyed by a synthetic id, then
// override Module._resolveFilename to redirect "vscode" to that id.
const VSCODE_CACHE_ID = "__vscode_stub__";
require.cache[VSCODE_CACHE_ID] = {
  id: VSCODE_CACHE_ID,
  filename: VSCODE_CACHE_ID,
  loaded: true,
  exports: vscodeStub,
  children: [],
  paths: [],
} as unknown as NodeModule;
const origResolve = (Module as unknown as {
  _resolveFilename: (req: string, ...rest: unknown[]) => string;
})._resolveFilename;
(Module as unknown as {
  _resolveFilename: (req: string, ...rest: unknown[]) => string;
})._resolveFilename = function (request: string, ...rest: unknown[]): string {
  if (request === "vscode") return VSCODE_CACHE_ID;
  return origResolve.call(this, request, ...rest);
};

// Now safe to import the modules under test.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DriftAlertPoller } = require("./driftAlertPoller") as typeof import("./driftAlertPoller");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NotificationManager } = require("./notifications") as typeof import("./notifications");

// ---------------------------------------------------------------------------
// 2. Helper: a NotificationManager subclass that records every call.
// ---------------------------------------------------------------------------

class RecordingNotificationManager extends NotificationManager {
  async showDriftAlert(
    rec: import("./driftAlertPoller").DriftAuditRecord,
    opts: { onMuteKind: (k: import("./driftAlertPoller").DriftKind) => void }
  ): Promise<void> {
    notificationCalls.push({
      severity: rec.payload.severity,
      kind: rec.payload.kind,
      reason: rec.payload.reason,
    });
    muteKindCallback = opts.onMuteKind as (k: string) => void;
    // Honor mute-action when the test sets it.
    if (nextNotificationAction === "Mute this kind") {
      opts.onMuteKind(rec.payload.kind);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Helpers: synthesize a valid-looking drift.detected NDJSON line.
// ---------------------------------------------------------------------------

function buildDriftRecord(opts: {
  kind: string;
  severity: string;
  reason: string;
  prevHash?: string;
  ts?: string;
}): string {
  const ts = opts.ts ?? new Date().toISOString();
  const prev_hash = opts.prevHash ?? "0".repeat(64);
  const payload = {
    kind: opts.kind,
    severity: opts.severity,
    reason: opts.reason,
    evidence_count: 4,
  };
  // Hash is just sha256(ts+event+payload) — we don't verify the chain in
  // the poller, but we need a stable value so dedup tests are meaningful.
  const hash = createHash("sha256")
    .update(JSON.stringify({ prev_hash, ts, event: "drift.detected", actor: "system", payload }))
    .digest("hex");
  return JSON.stringify({
    ts,
    event: "drift.detected",
    actor: "system",
    payload,
    prev_hash,
    hash,
  });
}

function mkTempAuditDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "drift-alert-poller-"));
}

function resetFixtures(): void {
  notificationCalls.length = 0;
  nextNotificationAction = undefined;
  muteKindCallback = undefined;
  fakeConfigStore.enableNotifications = true;
  fakeConfigStore.enableDriftAlerts = true;
}

// ---------------------------------------------------------------------------
// 4. Tests
// ---------------------------------------------------------------------------

test("fires showDriftAlert with the correct severity + kind on a new drift.detected line", async () => {
  resetFixtures();
  const dir = mkTempAuditDir();
  const auditPath = path.join(dir, "audit.log");
  fs.writeFileSync(
    auditPath,
    buildDriftRecord({
      kind: "fabrication_suspect",
      severity: "critical",
      reason: "cited file.ext:42 not on disk",
    }) + "\n"
  );

  const notifications = new RecordingNotificationManager();
  const channel = makeOutputChannel() as unknown as import("vscode").OutputChannel;
  const poller = new DriftAlertPoller(
    notifications,
    channel,
    makeMemento() as unknown as import("vscode").Memento,
    auditPath
  );

  poller.poll();

  // Give NotificationManager.showDriftAlert (async) a microtask to settle.
  await new Promise((r) => setImmediate(r));

  assert.equal(notificationCalls.length, 1);
  assert.equal(notificationCalls[0].kind, "fabrication_suspect");
  assert.equal(notificationCalls[0].severity, "critical");
  assert.match(notificationCalls[0].reason, /cited file\.ext:42/);

  poller.dispose();
});

test("does NOT re-fire when the same line is polled twice (hash dedup)", async () => {
  resetFixtures();
  const dir = mkTempAuditDir();
  const auditPath = path.join(dir, "audit.log");
  fs.writeFileSync(
    auditPath,
    buildDriftRecord({
      kind: "loop",
      severity: "warn",
      reason: "same git command failed 4 times",
    }) + "\n"
  );

  const notifications = new RecordingNotificationManager();
  const channel = makeOutputChannel() as unknown as import("vscode").OutputChannel;
  const poller = new DriftAlertPoller(
    notifications,
    channel,
    makeMemento() as unknown as import("vscode").Memento,
    auditPath
  );

  poller.poll(); // first poll → fires
  await new Promise((r) => setImmediate(r));
  poller.poll(); // second poll → no new bytes (cursor advanced) → no fire
  await new Promise((r) => setImmediate(r));

  assert.equal(notificationCalls.length, 1, "second poll must not re-fire");

  // Even if we force the cursor backwards (simulating a flapping watcher),
  // the per-record hash LRU should still suppress.
  (poller as unknown as { _lastOffset: number })._lastOffset = 0;
  poller.poll();
  await new Promise((r) => setImmediate(r));

  assert.equal(
    notificationCalls.length,
    1,
    "re-reading the same record from offset 0 must still dedupe by hash"
  );

  poller.dispose();
});

test("muting a kind suppresses subsequent popups of that kind", async () => {
  resetFixtures();
  const dir = mkTempAuditDir();
  const auditPath = path.join(dir, "audit.log");

  // Append a first record, poll, then click "Mute this kind".
  fs.writeFileSync(
    auditPath,
    buildDriftRecord({
      kind: "no_insight",
      severity: "info",
      reason: "30 tool calls since last learning.save",
      ts: new Date(Date.now() - 1000).toISOString(),
    }) + "\n"
  );

  const notifications = new RecordingNotificationManager();
  const channel = makeOutputChannel() as unknown as import("vscode").OutputChannel;
  const poller = new DriftAlertPoller(
    notifications,
    channel,
    makeMemento() as unknown as import("vscode").Memento,
    auditPath
  );

  nextNotificationAction = "Mute this kind";
  poller.poll();
  await new Promise((r) => setImmediate(r));

  assert.equal(notificationCalls.length, 1);
  assert.equal(muteKindCallback !== undefined, true);

  // Append a SECOND record of the same kind. It should NOT fire.
  nextNotificationAction = undefined;
  fs.appendFileSync(
    auditPath,
    buildDriftRecord({
      kind: "no_insight",
      severity: "info",
      reason: "still no learning.save",
      prevHash: createHash("sha256").update("abc").digest("hex"),
    }) + "\n"
  );

  poller.poll();
  await new Promise((r) => setImmediate(r));

  assert.equal(notificationCalls.length, 1, "muted kind must not fire again");

  poller.dispose();
});

test("dispose() stops the timer and is idempotent", async () => {
  resetFixtures();
  const dir = mkTempAuditDir();
  const auditPath = path.join(dir, "audit.log");
  fs.writeFileSync(auditPath, "");

  const notifications = new RecordingNotificationManager();
  const channel = makeOutputChannel() as unknown as import("vscode").OutputChannel;
  const poller = new DriftAlertPoller(
    notifications,
    channel,
    makeMemento() as unknown as import("vscode").Memento,
    auditPath
  );

  poller.start(50);
  await new Promise((r) => setTimeout(r, 120));
  poller.dispose();

  // Second dispose must NOT throw.
  assert.doesNotThrow(() => poller.dispose());

  // Calling poll() after dispose() should also be safe.
  assert.doesNotThrow(() => poller.poll());
});

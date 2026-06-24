# L3 In-Session Reminder Injection — Design Spec

**Status**: Design only — NO IMPLEMENTATION in this commit. Awaiting user review before scoping the build.
**Author**: Session 14 overnight pass, 2026-06-24
**Related**: [CHANGELOG.md § vscode-ext 0.11.0](../CHANGELOG.md) (L1→L2 wiring), [SESSION_13](sessions/SESSION_13_2026-06-24.md) (where the L1→L2→L3 layer model was articulated)

## Recap of the L1→L2→L3 model

- **L1 — Detect**: `opscontext watch` runs the 8-heuristic drift detector against `~/.contextengine/audit.log` and writes `drift.detected` records back into the same log (`src/detector.ts:387` via `safeAppend`).
- **L2 — Surface (already shipped in vscode-ext 0.11.0)**: `vscode-extension/src/driftAlertPoller.ts` subscribes to `drift.detected` records, dedupes, and pushes severity-appropriate popups via `NotificationManager.showDriftAlert`.
- **L3 — Inject (this design)**: when a drift signal fires *during* an active Claude Code session, the agent itself should be told about it — in the same turn — so it can course-correct. A popup the user has to read + relay manually breaks the loop.

## What "L3 injection" means concretely

Claude Code supports a `UserPromptSubmit` hook event. The hook script runs BEFORE the agent's turn fires, and its JSON output can include an `additionalContext` field that gets prepended to the agent's context window for that turn. This is the documented injection point.

So L3's mechanism is: **a Claude Code `UserPromptSubmit` hook that reads recent `drift.detected` records from `~/.contextengine/audit.log` and emits them as `additionalContext`** — the agent sees a system-reminder-shaped paragraph in the same turn, written by us, describing the drift signal.

Concrete shape of the injected context (proposed):

```
<system-reminder>
The OpsContext drift detector fired the following signal(s) since your last turn. Use these to course-correct rather than continuing on the current trajectory.

[14:32:01] WARN  drift              Session has drifted from its opening prompt (similarity 0.04). Consider summarizing what's done on the original goal, saving it as a learning, then either confirming completion or refocusing.

[14:32:02] WARN  no_insight         173 tool calls since the last save_learning. Pause to crystallize: are there reusable rules in the recent work that future agents should know?

[14:32:08] CRIT  silent_failure     `npm run build` exited 1 four turns ago; you continued without acknowledging. Verify whether the build error was real and either fix or explicitly accept it.
</system-reminder>
```

Critical: the injection is **transparent** — the agent (and through it, the user) sees these are OpsContext-generated, not the user's own message. The system-reminder framing matches how Claude Code already inserts its own infrastructure messages.

## Spec — `opscontext install-l3-hook`

A new CLI subcommand `opscontext install-l3-hook` that:

1. Reads `~/.claude/settings.json`.
2. Splices a `UserPromptSubmit` hook entry pointing at `~/.claude/hooks/opscontext-l3-inject.sh` (a new script we install alongside the existing `opscontext-emit.sh`).
3. Sets a sane default config in `~/.contextengine/l3-config.json`:
   - `enabled: true`
   - `min_severity: "warn"` (suppress INFO to avoid noise)
   - `throttle_seconds: 300` (don't inject the same `kind` more than once per 5 min)
   - `max_signals_per_injection: 5` (cap so a flood doesn't blow the context)
   - `lookback_seconds: 600` (only look at signals from the last 10 min — old ones are stale by the time the agent sees them)
4. Idempotent: detects an existing `opscontext-l3-inject.sh` hook entry and reports "already installed; pass `--force` to overwrite."
5. Symmetric uninstall: `opscontext uninstall-l3-hook` removes the entry + the script + the config.

## Spec — the hook script `~/.claude/hooks/opscontext-l3-inject.sh`

```bash
#!/usr/bin/env bash
# 🔒 LOCKED [L3-INJECT-HOOK]
# Reads recent drift.detected records and outputs JSON for Claude Code's
# UserPromptSubmit hook with additionalContext that prepends a
# system-reminder-shaped paragraph into the agent's next turn.

set +e  # never block the agent's turn

CONFIG="$HOME/.contextengine/l3-config.json"
AUDIT="$HOME/.contextengine/audit.log"
CURSOR="$HOME/.contextengine/l3-cursor.json"

[ -r "$AUDIT" ] || { echo '{}' ; exit 0; }                # no log, no signal
[ -r "$CONFIG" ] && enabled=$(jq -r '.enabled' "$CONFIG") || enabled=true
[ "$enabled" = "false" ] && { echo '{}' ; exit 0; }       # explicitly off

# Load config knobs (with defaults)
min_severity=$(jq -r '.min_severity // "warn"' "$CONFIG" 2>/dev/null)
throttle=$(jq -r '.throttle_seconds // 300' "$CONFIG" 2>/dev/null)
max_signals=$(jq -r '.max_signals_per_injection // 5' "$CONFIG" 2>/dev/null)
lookback=$(jq -r '.lookback_seconds // 600' "$CONFIG" 2>/dev/null)

# Compute since-timestamp = now - lookback
since=$(python3 -c "from datetime import datetime, timezone, timedelta; print((datetime.now(timezone.utc) - timedelta(seconds=$lookback)).isoformat().replace('+00:00','Z'))")

# Pull drift.detected records since cutoff, severity-filtered, throttled per kind
# (the python helper is more reliable than chained jq for the throttle logic)
signals=$(python3 - <<PY
import json, sys, time
from datetime import datetime, timezone

min_sev = "$min_severity"
since = "$since"
throttle = $throttle
max_n = $max_signals
audit = "$AUDIT"
cursor_path = "$CURSOR"
sev_order = {"info": 0, "warn": 1, "critical": 2}

try:
    cursor = json.load(open(cursor_path))
except (FileNotFoundError, json.JSONDecodeError):
    cursor = {}  # { kind: last_emit_unix_ts }

now = time.time()
matches = []
with open(audit) as f:
    for line in f:
        try:
            r = json.loads(line)
        except: continue
        if r.get("event") != "drift.detected": continue
        if r.get("ts","") < since: continue
        p = r.get("payload", {})
        sev = p.get("severity", "info")
        kind = p.get("kind", "?")
        if sev_order.get(sev, 0) < sev_order.get(min_sev, 1): continue
        if now - cursor.get(kind, 0) < throttle: continue
        matches.append({
            "ts": r["ts"][11:19],
            "sev": sev.upper()[:4],
            "kind": kind,
            "reason": p.get("reason", "(no reason)"),
        })
        cursor[kind] = now

matches = matches[-max_n:]  # cap to most recent N

# Persist cursor so we don't re-inject the same kinds next turn
json.dump(cursor, open(cursor_path, "w"))

if not matches:
    sys.exit(0)  # caller emits {} below

lines = ["The OpsContext drift detector fired the following signal(s) since your last turn. Use these to course-correct rather than continuing on the current trajectory.", ""]
for m in matches:
    lines.append(f"[{m['ts']}] {m['sev']:<4}  {m['kind']:<18} {m['reason']}")
text = "\n".join(lines)
# Wrap in system-reminder tags (matching Claude Code's own conventions)
print("<system-reminder>")
print(text)
print("</system-reminder>")
PY
)

if [ -z "$signals" ]; then
  echo '{}'  # no injection
  exit 0
fi

# Emit JSON for Claude Code's hook protocol
jq -nc --arg ctx "$signals" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'
```

The script is `set +e` discipline (per the [OPSCONTEXT-CC-HOOK] LOCK precedent) — silent on any failure, never blocks the agent's turn.

## Edge cases + safety analysis

| Edge case | Behavior |
|---|---|
| Audit log missing | `[ -r "$AUDIT" ] || exit 0` — no injection, no error. |
| Hook config missing | Defaults apply (enabled=true, min_severity=warn). |
| User explicitly disables | `enabled: false` in config → empty `{}` output, agent's turn proceeds unmodified. |
| `jq` missing on the user's machine | Hook is bash-only with jq dependency, same as the existing `opscontext-emit.sh`. Document jq as a prerequisite for the L3 hook (it's already required for L1 emit). |
| Flooded with alerts (e.g. 50 silent_failure in 30s) | Capped at `max_signals_per_injection` (default 5). Cursor throttles per-kind so the same kind doesn't fire twice in 5 min. |
| Same kind fires every turn for hours | Throttle resets after `throttle_seconds`; user can mute permanently via L2's "Mute this kind" → also writes to L3 config (cross-layer mute). |
| `additionalContext` is too long (claude has a soft limit on injection size) | The 5-signal cap × ~150 chars each = ~750 chars. Well under typical injection limits. Document a hard ceiling of 2000 chars as a safety belt. |
| Agent reads the system-reminder + ignores it | That's the agent's call. The injection makes the signal *visible*; the response is the agent's choice. |
| Hook script has a bug and outputs malformed JSON | Claude Code logs the hook error and proceeds without the injection. We don't crash anyone's session — at worst, no L3 surface for that turn. |
| User manually edits the audit log | Drift detector's signals stay valid (the chain integrity is checked separately). L3 just reads — it doesn't validate. If the user wants to suppress signals, they should use the config, not edit the log. |
| Cursor file corruption | Python `try/except FileNotFoundError, json.JSONDecodeError` → resets to empty cursor → re-injects the most recent signals once. Self-healing. |

## Privacy considerations

The injected text contains:
- Severity + kind (enumerated values, no user data)
- Timestamp (no user data)
- `reason` field — written by the detector itself, NOT by the agent or the user. The detector's reasons are static templates ("Session has drifted...", "X tool calls since...") with at most a numeric occurrence count or threshold value. No prompt text, no file contents, no project paths.

So L3 doesn't leak the user's prompts back to themselves — it just adds a system-shaped commentary on patterns the L1 detector has already characterized.

## Why this is a Sprint-5 (not now) item

1. **Needs user review** — the system-reminder framing is opinionated. The user may want a different name ("⚠️ Pattern alert" vs "drift signal") or a different injection point (e.g. only on certain prompt types).
2. **Multi-machine config sync** — if a PRO user has 3 dev machines, do L3 mute decisions sync via api.compr.ch? Probably yes long-term, no for v1.
3. **Tests against an actual claude-code instance** — we need to verify the JSON shape Claude Code actually accepts. The docs cite `additionalContext`; reality may be a moving target on the SDK side. Author a small fixture-driven smoke test before shipping.
4. **Coordination with the L2 mute list** — when user clicks "Mute this kind" on a popup, that should also feed L3's config. Cross-layer state needs a clear ownership story.

## Recommended next steps (Sprint-5 if user approves)

1. **User reviews this spec** — flag any wording / framing concerns. (~30 min)
2. **Hook script + tests** — implement `~/.claude/hooks/opscontext-l3-inject.sh` per the spec above. Add a synthetic-audit-log test that asserts the JSON output shape. (~2 hours)
3. **CLI subcommands** — `opscontext install-l3-hook` + `uninstall-l3-hook` mirroring the existing `install-claude-hook` pattern. (~1 hour)
4. **Verify against Claude Code SDK** — run a controlled session that triggers a known drift signal and confirms the agent receives + acknowledges the system-reminder. (~30 min)
5. **L2 ↔ L3 mute sync** — when user clicks "Mute this kind" in VS Code, write to L3 config. When user manually edits L3 config to mute, surface that in the VS Code Options panel. (~1 hour)
6. **Documentation** — `docs/l3-architecture.md` explaining the L1→L2→L3 model end-to-end for both engineers and operators. (~1 hour)

Total estimate: ~6 hours for v1. Adds the highest-impact feature of the entire surveillance stack — the moment the agent itself becomes aware of OpsContext's signals.

## Decision matrix for the user

| Choice | What it means |
|---|---|
| 🟢 **Ship as designed** | L3 hook installs alongside the L1 emit hook. Agents start receiving drift signals as system-reminders within the same turn the L1 detector fires. PRO and free users both get this; it's not gated. |
| 🟡 **Ship with PRO gate** | Same UX, but `opscontext install-l3-hook` rejects unless license is PRO+. Lever for upselling. Trade-off: free users miss the highest-leverage UX. |
| 🟠 **Ship with opt-in only** | `enabled: false` default in the config. User has to flip it. Safer for users who don't want any in-context injection. |
| 🔴 **Skip / redesign** | Defer; revisit the injection point (maybe it's PreToolUse not UserPromptSubmit?). Lose the highest-impact UX win until reconsidered. |

My recommendation: **🟢 ship as designed**, with the `min_severity: warn` default keeping noise low. Free users benefit too; the value of L3 is feedback-loop closure, not a paywall.

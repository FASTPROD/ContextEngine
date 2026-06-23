#!/usr/bin/env bash
# OpsContext — Claude Code hook emitter
#
# 🔒 LOCKED [OPSCONTEXT-CC-HOOK] — 2026-06-23
# ⛔ NEVER block on success or fail loudly. Claude Code waits for hooks to
#    complete before continuing — any error must exit 0 + silent.
# ⛔ NEVER emit on PreToolUse. PostToolUse alone — PreToolUse would double-
#    count vs PostToolUse for the `stuck` heuristic and skew `silent_failure`.
# ⛔ NEVER print to stdout (would be interpreted as a hook decision message).
# WHY: This hook is the ONLY way Claude Code terminal sessions get into the
#    OpsContext audit log. If it's slow or breaks, the user disables it and
#    loses cross-surface drift visibility — the entire wedge collapses.
# FIX: To support a new Claude Code hook event, add a case branch. Keep the
#    exit-0-on-any-error discipline. Events go via HTTP (NOT direct file
#    write) so the running MCP server's in-process chain cache prevents the
#    concurrent-write race.

set +e

EVENT_KIND="${1:-}"
SECRET_FILE="$HOME/.contextengine/extension-secret"
ENDPOINT="${OPSCONTEXT_EVENT_URL:-http://127.0.0.1:7842/events}"

# Bail fast if not initialized — never block Claude Code
[ -r "$SECRET_FILE" ] || exit 0
SECRET=$(cat "$SECRET_FILE" 2>/dev/null)
[ -n "$SECRET" ] || exit 0

INPUT=$(cat)
[ -n "$INPUT" ] || exit 0

NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

case "$EVENT_KIND" in
  UserPromptSubmit)
    PAYLOAD=$(printf '%s' "$INPUT" | jq -c --arg ts "$NOW" '{
      v: 1, ts: $ts, event: "vscode.prompt_submit", actor: "claude-code",
      payload: {
        surface: "claude-code",
        text: ((.prompt // "")[:4000]),
        session: (.session_id // ""),
        cwd: (.cwd // ""),
        char_count: ((.prompt // "") | length)
      }
    }' 2>/dev/null)
    ;;
  PostToolUse)
    PAYLOAD=$(printf '%s' "$INPUT" | jq -c --arg ts "$NOW" '{
      v: 1, ts: $ts, event: "vscode.tool_call", actor: "claude-code",
      payload: ({
        surface: "claude-code",
        tool: (.tool_name // ""),
        args_preview: (
          (.tool_input.command
            // .tool_input.file_path
            // .tool_input.pattern
            // (.tool_input | tostring)
            // ""
          )[:200]
        ),
        session: (.session_id // ""),
        cwd: (.cwd // "")
      } + (
        if (.tool_response.is_error == true)
            or ((.tool_response.error // "") != "")
            or ((.tool_response.interrupt // false) == true)
        then { error: ((.tool_response.error
                        // (.tool_response.content | tostring)
                        // "tool reported error")[:500]) }
        else {}
        end
      ))
    }' 2>/dev/null)
    ;;
  SessionStart)
    PAYLOAD=$(printf '%s' "$INPUT" | jq -c --arg ts "$NOW" '{
      v: 1, ts: $ts, event: "vscode.session_start", actor: "claude-code",
      payload: {
        surface: "claude-code",
        session: (.session_id // ""),
        cwd: (.cwd // ""),
        source: (.source // "")
      }
    }' 2>/dev/null)
    ;;
  *)
    exit 0
    ;;
esac

[ -n "$PAYLOAD" ] || exit 0

# POST with 1s hard timeout. Any error → silent (curl >/dev/null 2>&1, exit 0).
curl -sS --max-time 1.0 \
  -H "Content-Type: application/json" \
  -H "X-OpsContext-Secret: $SECRET" \
  --data "{\"events\":[$PAYLOAD]}" \
  "$ENDPOINT" >/dev/null 2>&1

exit 0

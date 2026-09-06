#!/usr/bin/env bash
# Claude Code Stop hook for this repo: a turn may not end while the CE session is older than the
# last commit. Exit 2 blocks the stop and hands Claude the reason; exit 0 lets it end.
#
# [LOCKED] [SESSION-SAVE-IS-A-GATE] 2026-09-06
# [NEVER] turn this back into a reminder (exit 0 with a message) or gate it on a wall clock.
# WHY: Yan had to type "check and update session and ce docs!" at the end of every session
#      (2026-09-06: "why do I have to write this systematically?"). The firewall nag lives in
#      MCP tool responses and the post-push hook only reminds; on 2026-09-05 the MCP server was
#      disconnected for hours and the work went through the CLI, so nothing fired. A rule that
#      lives in prose is not a rule; a Stop hook that refuses is.
# FIX: compare the session file's mtime with the last commit's time. Older = block, with the doc
#      staleness numbers in the same message so the docs get the same pass. `stop_hook_active`
#      from Claude Code means "you are already continuing because of me": never block twice.
set -u
input="$(cat 2>/dev/null || true)"
case "$input" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;; esac

repo="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$repo" || exit 0
name="$(basename "$repo")"
sessions_dir="${CONTEXTENGINE_HOME:-$HOME/.contextengine}/sessions"
norm() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]'; }
mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }

# The session for this repo: CE_GATE_SESSION_FILE (tests), else the newest session file whose
# normalized name starts with the repo's normalized basename ("admin-CROWLR" and "admin.CROWLR"
# both count for admin.CROWLR). None = never saved = older than any commit.
session_ts=0; session_name="$name"
if [ -n "${CE_GATE_SESSION_FILE:-}" ]; then
  [ -f "$CE_GATE_SESSION_FILE" ] && session_ts="$(mtime "$CE_GATE_SESSION_FILE")"
else
  want="$(norm "$name")"
  for f in "$sessions_dir"/*.json; do
    [ -f "$f" ] || continue
    base="$(basename "$f" .json)"
    case "$(norm "$base")" in "$want"*) t="$(mtime "$f")"; if [ "$t" -gt "$session_ts" ]; then session_ts=$t; session_name="$base"; fi ;; esac
  done
fi

commit_ts="$(git log -1 --format=%ct 2>/dev/null || echo 0)"

# Doc staleness, informational: commits touching src/ since copilot-instructions.md last changed.
ci=".github/copilot-instructions.md"
ci_commit="$(git log -1 --format=%H -- "$ci" 2>/dev/null || true)"
if [ -n "$ci_commit" ]; then stale="$(git rev-list --count "$ci_commit"..HEAD -- src 2>/dev/null || echo '?')"; else stale="?"; fi
latest_session_doc="$(ls -t docs/sessions/SESSION_*.md 2>/dev/null | head -1)"

if [ "$session_ts" -lt "$commit_ts" ]; then
  fmt() { date -r "$1" "+%Y-%m-%d %H:%M" 2>/dev/null || date -d "@$1" "+%Y-%m-%d %H:%M"; }
  {
    if [ "$session_ts" -eq 0 ]; then when="never saved"; else when="$(fmt "$session_ts")"; fi
    echo "CE session gate: session '$session_name' ($when) is older than the last commit ($(fmt "$commit_ts")). Before ending:"
    echo "1. save_session (MCP) session='$session_name' keys summary and open, with what changed since the last save;"
    echo "2. update ${latest_session_doc:-docs/sessions/SESSION_N.md} if the work changed and commit it;"
    echo "3. $ci is $stale src commit(s) behind; update it if any of them changed how the project works;"
    echo "4. save_learning for any reusable lesson. Then end the turn; this gate passes once the session file is newer than HEAD."
  } >&2
  exit 2
fi
exit 0

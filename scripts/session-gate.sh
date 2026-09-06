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
session="${CE_GATE_SESSION_FILE:-${CONTEXTENGINE_HOME:-$HOME/.contextengine}/sessions/${name}.json}"

commit_ts="$(git log -1 --format=%ct 2>/dev/null || echo 0)"
if [ -f "$session" ]; then session_ts="$(stat -f %m "$session" 2>/dev/null || stat -c %Y "$session" 2>/dev/null || echo 0)"; else session_ts=0; fi

# Doc staleness, informational: commits touching src/ since copilot-instructions.md last changed.
ci=".github/copilot-instructions.md"
ci_commit="$(git log -1 --format=%H -- "$ci" 2>/dev/null || true)"
if [ -n "$ci_commit" ]; then stale="$(git rev-list --count "$ci_commit"..HEAD -- src 2>/dev/null || echo '?')"; else stale="?"; fi
latest_session_doc="$(ls -t docs/sessions/SESSION_*.md 2>/dev/null | head -1)"

if [ "$session_ts" -lt "$commit_ts" ]; then
  fmt() { date -r "$1" "+%Y-%m-%d %H:%M" 2>/dev/null || date -d "@$1" "+%Y-%m-%d %H:%M"; }
  {
    echo "CE session gate: session '$name' ($(fmt "$session_ts")) is older than the last commit ($(fmt "$commit_ts")). Before ending:"
    echo "1. save_session (MCP) session='$name' keys summary and open, with what changed since the last save;"
    echo "2. update ${latest_session_doc:-docs/sessions/SESSION_N.md} if the work changed and commit it;"
    echo "3. $ci is $stale src commit(s) behind; update it if any of them changed how the project works;"
    echo "4. save_learning for any reusable lesson. Then end the turn; this gate passes once the session file is newer than HEAD."
  } >&2
  exit 2
fi
exit 0

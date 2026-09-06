#!/usr/bin/env bash
# Claude Code Stop hook for THIS repo only (the one repo that publishes CE): a turn may not end
# while the version in package.json is on npm and `npm run verify-release` has not passed for it.
#
# [LOCKED] [PUBLISHED-MEANS-VERIFIED] 2026-09-06
# [NEVER] let "published" be written without the handshake proof, and [NEVER] make this a
#         reminder: it refuses (exit 2) or it passes.
# WHY: three releases were "published and verified" while Claude Code ran nothing (2026-08-23,
#      2026-09-05); [RELEASE-PROVEN-BY-HANDSHAKE] made verify-release the proof, but running it
#      was still a rule in prose. verify-release.sh now writes ~/.contextengine/verified-<version>
#      when it passes; this gate looks for that marker. Same shape as the session gate.
# FIX: cheap and offline unless a publish is suspected: the marker check is a stat; `npm view`
#      (network, ~1 s) runs only when the marker is missing, to tell "not published yet" (pass)
#      from "published, unverified" (block). stop_hook_active: never block twice.
set -u
input="$(cat 2>/dev/null || true)"
case "$input" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;; esac
repo="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$repo" || exit 0
v="$(node -p "require('./package.json').version" 2>/dev/null || true)"
[ -n "$v" ] || exit 0
marker="${CONTEXTENGINE_HOME:-$HOME/.contextengine}/verified-$v"
[ -f "$marker" ] && exit 0
published="$(npm view "@compr/opscontext-mcp@$v" version 2>/dev/null || true)"
[ "$published" = "$v" ] || exit 0   # not on npm: nothing to verify yet
echo "Release gate: @compr/opscontext-mcp@$v is on npm but 'npm run verify-release' has not passed for it (no $marker). Run it now; do not write 'published' anywhere before it is green." >&2
exit 2

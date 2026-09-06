#!/bin/bash
# verify-release.sh: prove a release the way Claude Code will use it, not the way npm reports it.
#   1. the local build answers a real MCP initialize + tools/list from this repo
#      (this is what Claude Code runs here: .mcp.json -> node dist/index.js)
#   2. the PUBLISHED package answers the same from a foreign cwd, serving the version in
#      package.json (this is what every other project runs: ~/.claude.json -> npx -y ...)
# Waits for the registry to serve that version (up to 10 minutes). Exits 1 on any miss.
#
# Usage: npm run verify-release            # after npm publish
#        npm run verify-release -- 2.5.5   # a specific version
# [LOCK] [RELEASE-PROVEN-BY-HANDSHAKE] in scripts/mcp-handshake.mjs
# pipefail is load-bearing: every probe below is piped through sed for indentation, and
# without it the `||` would test sed's exit status (always 0), not the probe's.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
PKG="@compr/opscontext-mcp"
VERSION="${1:-$(node -p "require('./package.json').version")}"
PROBE="$REPO/scripts/mcp-handshake.mjs"

echo "[verify-release] $PKG@$VERSION"
echo "[verify-release] 1/2 local build from the repo (node dist/index.js)"
[ -f "$REPO/dist/index.js" ] || { echo "  dist/index.js missing, run npm run build"; exit 1; }
EXPECT_VERSION="$VERSION" node "$PROBE" "$REPO" node dist/index.js | sed 's/^/  /' || { echo "  LOCAL BUILD FAILED THE HANDSHAKE"; exit 1; }

echo "[verify-release] 2/2 published package from a foreign cwd (npx -y $PKG@$VERSION)"
deadline=$(( $(date +%s) + 600 ))
until [ "$(npm view "$PKG@$VERSION" version 2>/dev/null)" = "$VERSION" ]; do
  [ "$(date +%s)" -lt "$deadline" ] || { echo "  registry still not serving $VERSION after 10 min"; exit 1; }
  sleep 20
done
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# A foreign cwd is the point: inside this repo npx resolves the package to the repo itself
# and its bin is not there (sh: opscontext: command not found), see the LOCK.
EXPECT_VERSION="$VERSION" node "$PROBE" "$TMP" npx -y "$PKG@$VERSION" | sed 's/^/  /' || { echo "  PUBLISHED PACKAGE FAILED THE HANDSHAKE"; exit 1; }

echo "[verify-release] OK: $VERSION answers initialize + tools/list from the repo build and from the registry"
# The proof leaves a marker for scripts/release-gate.sh ([PUBLISHED-MEANS-VERIFIED]).
mkdir -p "${CONTEXTENGINE_HOME:-$HOME/.contextengine}" && date -u +%Y-%m-%dT%H:%M:%SZ > "${CONTEXTENGINE_HOME:-$HOME/.contextengine}/verified-$VERSION"

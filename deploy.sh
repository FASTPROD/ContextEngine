#!/bin/bash
# ContextEngine — Full Deploy (npm publish + VPS activation server)
# Usage: ./deploy.sh [npm|server|all]
set -euo pipefail

ACTION="${1:-all}"

deploy_npm() {
  echo "📦 Building and publishing to npm..."
  npm run build
  npm run lint
  npm test
  npm publish --access public
  echo "✅ Published to npm"
}

deploy_server() {
  echo "🚀 Deploying activation server to VPS..."
  
  # [LOCKED] [GANDI_KEY_AUTH_ONLY] - 2026-08-20
  # [NEVER] reintroduce a password-auth wrapper, or PubkeyAuthentication=no, for
  #         admin@92.243.24.157.
  # WHY: that box had SSH password auth on, 387,832 failed attempts logged, and was
  #      compromised by a cryptominer in Feb 2026. Password auth was disabled 2026-08-20
  #      after auth.log showed 0 password logins vs 50 publickey logins over 5+ weeks.
  #      Forcing PubkeyAuthentication=no now fails outright. This script had also been
  #      carrying the literal placeholder <VPS_PASSWORD>, so deploy_server could not have
  #      worked as written - key auth is what makes it work again.
  # FIX: use the ed25519 key (~/.ssh/config Host gandi). sudo on the remote still needs
  #      the password; that is a separate mechanism and is unaffected.
  SSH_OPTS="-o StrictHostKeyChecking=no"
  SERVER="admin@92.243.24.157"
  SERVER_DIR="/var/www/contextengine-server"
  DIST_DIR="/var/www/contextengine-dist"

  # Sync server files
  #
  # [LOCKED] [NEVER-DELETE-THE-PM2-ECOSYSTEM-FILE] - 2026-08-20
  # [NEVER] drop ecosystem.config.cjs from this exclude list, and [NEVER] commit that
  #         file to this repo.
  # WHY: it lives only on the box, so `--delete` was going to remove it on the first
  #      successful run of this script. A dry-run caught it. `pm2 restart` would still
  #      have worked from the in-memory process list, so the deploy would have looked
  #      clean, and the activation server would simply not have come back at the next
  #      reboot or pm2 resurrect, with nothing in the deploy output pointing at the
  #      cause. A reboot of this box was already scheduled for the same day.
  #      It also carries Stripe keys and SMTP config, so it must stay out of git:
  #      secrets belong in .copilot-credentials.md, never in a repo file.
  # FIX: exclude it, and keep a dated copy beside it on the server before each deploy.
  echo "📦 Syncing server files..."
  ssh $SSH_OPTS "$SERVER" "cp -n $SERVER_DIR/ecosystem.config.cjs $SERVER_DIR/ecosystem.config.cjs.bak 2>/dev/null || true"

  # [LOCKED] [NEVER-REINSTALL-NODE_MODULES-ON-THIS-BOX] - 2026-08-20
  # [NEVER] run npm install / npm ci here unconditionally.
  # WHY: crowlrbackend is Debian buster. Its g++ rejects -std=c++20, which
  #      better-sqlite3 now requires, and prebuild-install finds no prebuilt binary for
  #      its glibc. The FIRST real run of this script died exactly there. The already
  #      built better_sqlite3.node from an earlier toolchain still works, so the danger
  #      is not the failed install, it is a future install that removes the working
  #      artifact before failing to replace it: the activation server would then not
  #      start again.
  # FIX: install only when package.json actually changed, and say so loudly when it
  #      did, because on this box that means a human has to deal with the toolchain.
  #      Measured on the run that found this: deps were byte-identical, so the install
  #      was pure risk with no purpose.
  LOCAL_PKG_HASH=$(md5 -q server/package.json 2>/dev/null || md5sum server/package.json | cut -d" " -f1)
  REMOTE_PKG_HASH=$(ssh $SSH_OPTS "$SERVER" "md5sum $SERVER_DIR/package.json 2>/dev/null | cut -d' ' -f1" || echo "none")
  if [ "$LOCAL_PKG_HASH" = "$REMOTE_PKG_HASH" ]; then
    echo "   package.json unchanged, skipping npm install (see [NEVER-REINSTALL-NODE_MODULES-ON-THIS-BOX])"
  else
    echo "   ⚠️  package.json CHANGED. This box cannot rebuild better-sqlite3."
    echo "      Handle the dependency change by hand before rerunning; aborting."
    exit 1
  fi
  rsync -avz --delete \
    --exclude='node_modules/' --exclude='dist/' \
    --exclude='data/' --exclude='delta-modules/' \
    --exclude='ecosystem.config.cjs*' \
    -e "ssh $SSH_OPTS" \
    server/ "$SERVER:$SERVER_DIR/"

  # [LOCKED] [COMPILE-LOCALLY-NEVER-ON-THIS-BOX] - 2026-08-20
  # [NEVER] run tsc on crowlrbackend.
  # WHY: its node_modules has drifted from server/package.json since February: stripe
  #      20.3.1 where the manifest pins ^14.25.0, and @types/nodemailer missing entirely.
  #      tsc there fails on two type errors that do not exist locally, and it cannot be
  #      repaired by npm install because the box cannot rebuild better-sqlite3
  #      (see [NEVER-REINSTALL-NODE_MODULES-ON-THIS-BOX]). Worse, tsconfig has no
  #      noEmitOnError, so the failing run still WROTE a new dist and only the pm2
  #      restart was skipped: the box was left with new code on disk and old code in
  #      memory, which the next reboot would have swapped in silently.
  # FIX: compile here, where deps match the manifest exactly, and ship the artifact.
  #      Production should not be a build environment anyway.
  echo "🔨 Compiling server locally..."
  (cd server && ./node_modules/.bin/tsc)

  echo "📦 Syncing compiled server dist..."
  rsync -avz \
    -e "ssh $SSH_OPTS" \
    server/dist/ "$SERVER:$SERVER_DIR/dist/"

  # Sync compiled dist (for gen-delta)
  echo "📦 Syncing dist/ for delta generation..."
  rsync -avz \
    -e "ssh $SSH_OPTS" \
    dist/ "$SERVER:$DIST_DIR/"

  # Install, build, gen-delta, restart
  #
  # [LOCKED] [REMOTE-BUILD-NEEDS-DEV-DEPS-AND-AN-ABSOLUTE-PM2] - 2026-08-20
  # [NEVER] call bare `pm2` over ssh, and [NEVER] pair `npm install --production`
  #         with `npx tsc` here.
  # WHY: both were in this script and both would have failed on first contact, which
  #      nobody had met because the <VPS_PASSWORD> placeholder made deploy_server
  #      unrunnable from 2026-02-27 to 2026-08-20.
  #      1. A non-interactive ssh session on crowlrbackend has no pm2 on PATH; the
  #         binary is under /usr/local/node-v*/bin. Bare `pm2` gives "command not
  #         found", so the restart silently never happens.
  #      2. typescript is a devDependency of server/package.json. `npm install
  #         --production` prunes it, and `npx tsc` then resolves the unrelated,
  #         deprecated npm package named `tsc` instead of TypeScript.
  # FIX: install with dev deps, compile with the local tsc binary, and resolve pm2
  #      explicitly, failing loudly if it is missing rather than skipping the restart.
  echo "🔧 Building on server..."
  ssh $SSH_OPTS "$SERVER" "
    set -eu
    PM2_BIN=\$(command -v pm2 || ls -d /usr/local/node-v*/bin/pm2 2>/dev/null | head -1)
    if [ ! -x \"\$PM2_BIN\" ]; then echo 'pm2 not found on the box'; exit 1; fi
    cd $SERVER_DIR
    CONTEXTENGINE_DIST=$DIST_DIR node dist/gen-delta.js
    \"\$PM2_BIN\" restart contextengine-api
  "

  # Health check
  echo "🏥 Health check..."
  sleep 2
  curl -sf https://api.compr.ch/contextengine/health | python3 -m json.tool
  echo "✅ Server deployed"
}

case "$ACTION" in
  npm)    deploy_npm ;;
  server) deploy_server ;;
  all)    deploy_npm && deploy_server ;;
  *)      echo "Usage: $0 [npm|server|all]"; exit 1 ;;
esac

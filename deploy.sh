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
  echo "📦 Syncing server files..."
  rsync -avz --delete \
    --exclude='node_modules/' --exclude='dist/' \
    --exclude='data/' --exclude='delta-modules/' \
    -e "ssh $SSH_OPTS" \
    server/ "$SERVER:$SERVER_DIR/"

  # Sync compiled dist (for gen-delta)
  echo "📦 Syncing dist/ for delta generation..."
  rsync -avz \
    -e "ssh $SSH_OPTS" \
    dist/ "$SERVER:$DIST_DIR/"

  # Install, build, gen-delta, restart
  echo "🔧 Building on server..."
  ssh $SSH_OPTS "$SERVER" "
    cd $SERVER_DIR && \
    npm install --production && \
    npx tsc && \
    CONTEXTENGINE_DIST=$DIST_DIR node dist/gen-delta.js && \
    pm2 restart contextengine-api
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

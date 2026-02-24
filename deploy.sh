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

  # Load VPS SSH password from environment or .env file
  if [ -z "${VPS_SSH_PASS:-}" ]; then
    if [ -f ".env" ]; then
      VPS_SSH_PASS=$(grep -E '^VPS_SSH_PASS=' .env | cut -d'=' -f2-)
    fi
    if [ -z "${VPS_SSH_PASS:-}" ]; then
      echo "❌ VPS_SSH_PASS not set. Set it in .env or as an environment variable." >&2
      exit 1
    fi
  fi
  export SSHPASS="$VPS_SSH_PASS"

  SSH_OPTS="-o PubkeyAuthentication=no -o StrictHostKeyChecking=no"
  SERVER="admin@92.243.24.157"
  SERVER_DIR="/var/www/contextengine-server"
  DIST_DIR="/var/www/contextengine-dist"

  # Sync server files
  echo "📦 Syncing server files..."
  rsync -avz --delete \
    --exclude='node_modules/' --exclude='dist/' \
    --exclude='data/' --exclude='delta-modules/' \
    -e "sshpass -e ssh $SSH_OPTS" \
    server/ "$SERVER:$SERVER_DIR/"

  # Sync compiled dist (for gen-delta)
  echo "📦 Syncing dist/ for delta generation..."
  rsync -avz \
    -e "sshpass -e ssh $SSH_OPTS" \
    dist/ "$SERVER:$DIST_DIR/"

  # Install, build, gen-delta, restart
  echo "🔧 Building on server..."
  sshpass -e ssh $SSH_OPTS "$SERVER" "
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

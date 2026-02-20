#!/bin/bash
# ContextEngine Activation Server — Production Deploy to Gandi VPS
# Run from your Mac: ./server/deploy.sh
# Requires: SSH access to admin@92.243.24.157

set -euo pipefail

SERVER="admin@92.243.24.157"
SSH_KEY="~/.ssh/id_ed25519"
REMOTE_DIR="/var/www/contextengine-server"
SSH_CMD="ssh -i $SSH_KEY $SERVER"

echo "🚀 Deploying ContextEngine Activation Server..."

# 1. Create remote directory
echo "📁 Creating remote directory..."
$SSH_CMD "sudo mkdir -p $REMOTE_DIR && sudo chown admin:admin $REMOTE_DIR"

# 2. Sync server files (exclude node_modules, data, delta-modules)
echo "📦 Syncing server files..."
rsync -avz --delete \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='data/' \
  --exclude='delta-modules/' \
  --exclude='.gitignore' \
  -e "ssh -i $SSH_KEY" \
  "$(dirname "$0")/" "$SERVER:$REMOTE_DIR/"

# 3. Also sync the main ContextEngine dist/ (needed for gen-delta)
echo "📦 Syncing ContextEngine dist/ for delta generation..."
rsync -avz \
  -e "ssh -i $SSH_KEY" \
  "$(dirname "$0")/../dist/" "$SERVER:$REMOTE_DIR/../contextengine-dist/"

# 4. Install deps + build + generate delta on server
echo "🔧 Installing and building on server..."
$SSH_CMD "cd $REMOTE_DIR && npm install --production && npx tsc"

# 5. Generate delta modules from the synced dist
echo "🔐 Generating delta modules..."
$SSH_CMD "cd $REMOTE_DIR && mkdir -p delta-modules && CONTEXTENGINE_DIST=$REMOTE_DIR/../contextengine-dist node dist/gen-delta.js"

# 6. Seed a license if DB doesn't exist yet
echo "🔑 Checking license database..."
$SSH_CMD "cd $REMOTE_DIR && if [ ! -f data/licenses.db ]; then mkdir -p data && node dist/seed.js yannick@compr.ch enterprise 12; else echo 'DB exists — skipping seed'; fi"

# 7. Setup PM2
echo "⚙️  Setting up PM2..."
$SSH_CMD "cd $REMOTE_DIR && pm2 delete contextengine-api 2>/dev/null || true && pm2 start dist/server.js --name contextengine-api && pm2 save"

# 8. Add nginx config
echo "🌐 Configuring nginx..."
NGINX_CONF='
# ContextEngine Activation API
location /contextengine/ {
    proxy_pass http://127.0.0.1:8010/contextengine/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Rate limit at nginx level (backup to express-rate-limit)
    # limit_req zone=contextengine burst=5 nodelay;
}
'

echo ""
echo "=========================================="
echo "✅ Server deployed to $REMOTE_DIR"
echo ""
echo "⚠️  MANUAL STEP: Add this nginx location block"
echo "   to /etc/nginx/sites-enabled/crowlr.com"
echo "   (inside the server block for api.compr.ch):"
echo ""
echo "$NGINX_CONF"
echo ""
echo "   Then: sudo nginx -t && sudo systemctl reload nginx"
echo ""
echo "🧪 Test: curl https://api.compr.ch/contextengine/health"
echo "=========================================="

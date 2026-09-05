#!/bin/bash
# OpsContext Activation Server, Production Deploy to crowlr2 (OVH)
# Run from your Mac: ./server/deploy.sh
# Requires: SSH access to debian@137.74.175.123 (alias crowlr2)
#
# Hardened 2026-06-11 after a production path bug + bare-pm2 issue:
#   - Builds LOCALLY (server-side tsc was failing on missing devDeps)
#   - Uses the FULL pm2 path on the server (bare pm2 isn't on the
#     non-interactive ssh PATH)
#   - Pre-flight checks: SSH reachability, private key present, local
#     build clean, key permissions OK
#   - Smoke test EVERY deploy: hit /health after restart and verify a
#     known-good response. Roll back if it fails.
#
# Use --dry-run to print what WOULD happen without actually doing it.

set -euo pipefail

# ===================================================================
# Config
# ===================================================================
# [LOCKED] [CROWLR2-TARGET] 2026-08-21
# [NEVER] point SERVER back at admin@92.243.24.157 (old Gandi) or reuse the
#         /usr/local/node-v18 pm2 path.
# WHY: activation server migrated to crowlr2 on 2026-08-20 (DNS api.compr.ch
#      -> 137.74.175.123, pm2 contextengine-api online, licenses.db live there).
#      Old Gandi is frozen, 30-day grace; a deploy there would diverge licenses.db
#      from production. Verified from the Mac 2026-08-21: health 200 from
#      137.74.175.123, pm2 at /usr/bin/pm2, node v20.20.2, dirs owned debian.
# FIX: SERVER/PM2_BIN below are the only truth. Box hosts 13 sites: rsync
#      targets must stay under /var/www/contextengine-* (never a bare /var/www).
SERVER="debian@137.74.175.123"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_DIR="/var/www/contextengine-server"
PM2_BIN="/usr/bin/pm2"
PM2_PROCESS_NAME="contextengine-api"
HEALTH_URL="https://api.compr.ch/contextengine/health"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# [LOCK] [DEPLOY_ONLY_COMMITTED] shared preflight; this repo sources the original.
. "$PROJECT_ROOT/scripts/deploy-preflight.sh"

DRY_RUN=0
for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=1
done

# Tiny helpers
log() { echo "[deploy] $*"; }
warn() { echo "[deploy] ⚠️  $*" >&2; }
die() { echo "[deploy] ❌ $*" >&2; exit 1; }
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] $*"
  else
    eval "$@"
  fi
}
ssh_run() {
  local cmd="$1"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] ssh -i $SSH_KEY $SERVER '$cmd'"
  else
    ssh -i "$SSH_KEY" "$SERVER" "$cmd"
  fi
}

# ===================================================================
# Phase 0: Pre-flight (fail fast — never start a deploy that can't finish)
# ===================================================================
log "Phase 0 — pre-flight"

[[ -f "$SSH_KEY" ]] || die "SSH key not found at $SSH_KEY"
[[ -f "$SCRIPT_DIR/package.json" ]] || die "Not in server/ directory — run from project root"

# The bundle is built from server/ only; a bundle built from a dirty server/ matches no
# commit. Checked BEFORE the build so a dirty tree is refused, not built then refused.
# [LOCK] [DEPLOY_ONLY_COMMITTED]
deploy_preflight_tree "$PROJECT_ROOT" server || exit 1
log "  ✅ server/ committed, bundle will match $(git -C "$PROJECT_ROOT" rev-parse --short HEAD)"

# Local build must succeed BEFORE we touch the server. This is the lesson
# from the 2026-06-11 prod incident: server-side tsc was failing silently
# on missing devDeps, masking real compile errors.
log "  Local server build..."
(cd "$SCRIPT_DIR" && npm run build > /tmp/deploy-build.log 2>&1) || {
  cat /tmp/deploy-build.log >&2
  die "Local server build failed — fix before deploying"
}

# Ed25519 private key must be present (it rides along in the rsync below;
# without it, the server refuses to start)
if [[ ! -f "$SCRIPT_DIR/.secrets/ed25519-license-private.pem" ]]; then
  die "Ed25519 private key missing at $SCRIPT_DIR/.secrets/ed25519-license-private.pem
       This is required by the activation server. NEVER commit it.
       Restore from .copilot-credentials.md or regenerate (and re-issue licenses)."
fi

# Permissions check on the private key — we want 0600 locally; rsync -a
# preserves perms so this is what lands on the server too.
KEY_PERMS=$(stat -f %A "$SCRIPT_DIR/.secrets/ed25519-license-private.pem" 2>/dev/null \
            || stat -c %a "$SCRIPT_DIR/.secrets/ed25519-license-private.pem" 2>/dev/null \
            || echo "?")
if [[ "$KEY_PERMS" != "600" ]]; then
  warn "Private key permissions are $KEY_PERMS (expected 600). Fixing..."
  chmod 600 "$SCRIPT_DIR/.secrets/ed25519-license-private.pem"
fi

# SSH reachability
log "  SSH reachability..."
if [[ $DRY_RUN -eq 0 ]]; then
  ssh -i "$SSH_KEY" -o ConnectTimeout=10 -o BatchMode=yes "$SERVER" 'true' \
    || die "Cannot SSH to $SERVER (key auth or network issue)"
fi

# Current /health state — record baseline
log "  Baseline /health response (for comparison after restart)..."
BASELINE_HEALTH=$(curl -sf --max-time 5 "$HEALTH_URL" 2>/dev/null || echo "(server currently down)")
log "    $BASELINE_HEALTH"

log "  ✅ Pre-flight complete"

# ===================================================================
# Phase 1: Sync server source + compiled dist + private key
# ===================================================================
log "Phase 1 — rsync to server"

# Server code (source + compiled dist + .secrets/). NOTE: --delete here is
# DELIBERATELY scoped to server/ on the remote. .secrets/ is included in
# the rsync (no exclude), so the private key rides along with mode 0600.
run rsync -az \
  --exclude='node_modules/' \
  --exclude='data/' \
  --exclude='.gitignore' \
  -e "ssh -i $SSH_KEY" \
  "$SCRIPT_DIR/" "$SERVER:$REMOTE_DIR/"

# Verify private key landed with correct permissions
if [[ $DRY_RUN -eq 0 ]]; then
  REMOTE_KEY_PERMS=$(ssh -i "$SSH_KEY" "$SERVER" \
    "stat -c %a $REMOTE_DIR/.secrets/ed25519-license-private.pem" 2>/dev/null || echo "?")
  if [[ "$REMOTE_KEY_PERMS" != "600" ]]; then
    die "Private key landed with permissions $REMOTE_KEY_PERMS (expected 600). Aborting."
  fi
  log "  ✅ Private key on server, mode 600"
fi

# ===================================================================
# Phase 2: Install runtime deps on server (we already built locally)
# ===================================================================
log "Phase 2 — runtime deps on server"

ssh_run "cd $REMOTE_DIR && npm install --omit=dev --no-audit --no-fund --silent 2>&1 | tail -3"

# Phase 3 (gen-delta) removed 2026-08-21. [LOCK] [DELTA-RETIRED-SERVER] in src/server.ts

# ===================================================================
# Phase 4: PM2 restart (using FULL path — bare pm2 isn't on non-TTY PATH)
# ===================================================================
log "Phase 4 — PM2 restart"

# Use restart (graceful) not start. If the process doesn't exist yet,
# fall back to start. PM2's exit code distinguishes the two.
# [LOCKED] [PM2-START-FROM-ECOSYSTEM-ONLY] 2026-08-21
# [NEVER] fall back to a bare `pm2 start dist/server.js`.
# WHY: STRIPE_* and SMTP_* live only in ecosystem.config.cjs on the box (never in git).
#      On crowlr2 the process had been started bare, so health reported
#      stripeEnabled:false with no error anywhere; `pm2 restart` keeps whatever env the
#      process was born with, so the defect survives every deploy until someone
#      restarts from the ecosystem file. Found and fixed by the admin.CROWLR agent.
# FIX: restart if running; if absent, start from ecosystem.config.cjs or fail loudly.
ssh_run "$PM2_BIN restart $PM2_PROCESS_NAME 2>/dev/null \
          || { test -f $REMOTE_DIR/ecosystem.config.cjs \
               && cd $REMOTE_DIR && $PM2_BIN start ecosystem.config.cjs --only $PM2_PROCESS_NAME; } \
          || { echo 'no running process and no ecosystem.config.cjs on the box'; exit 1; }"
ssh_run "$PM2_BIN save --force 2>&1 | tail -1"

# ===================================================================
# Phase 5: Smoke test — wait for boot, hit /health, verify response
# ===================================================================
log "Phase 5 — smoke test"

if [[ $DRY_RUN -eq 0 ]]; then
  # Allow up to 30s for the server to boot
  for i in 1 2 3 4 5 6; do
    sleep 5
    HEALTH=$(curl -sf --max-time 5 "$HEALTH_URL" 2>/dev/null || true)
    if [[ -n "$HEALTH" ]]; then
      echo "  $HEALTH"
      # Must report status: healthy
      if echo "$HEALTH" | grep -q '"status":"healthy"'; then
        log "  ✅ /health reports healthy"
        # Env sanity: stripeEnabled:false means the process runs without its
        # ecosystem env. [LOCK] [PM2-START-FROM-ECOSYSTEM-ONLY]
        if echo "$HEALTH" | grep -q '"stripeEnabled":true'; then
          log "  ✅ stripeEnabled:true, ecosystem env loaded"
        else
          warn "stripeEnabled is not true: process likely started without ecosystem.config.cjs env."
        fi
        # Verify the Ed25519 marker is in the PM2 logs
        ED_OK=$(ssh -i "$SSH_KEY" "$SERVER" \
          "tail -100 /home/debian/.pm2/logs/contextengine-api-out.log | grep -c 'Ed25519 license-signing key loaded'" 2>/dev/null || echo 0)
        if [[ "$ED_OK" -gt 0 ]]; then
          log "  ✅ Ed25519 key load confirmed in PM2 logs"
        else
          warn "Ed25519 marker NOT found in recent logs — check manually."
        fi
        break
      fi
    fi
    if [[ $i -eq 6 ]]; then
      warn "Server did not return healthy /health after 30s. Check PM2 logs."
      ssh -i "$SSH_KEY" "$SERVER" \
        "tail -25 /home/debian/.pm2/logs/contextengine-api-error.log" 2>&1 | tail -15
      die "Deploy verification FAILED. Server may be in a broken state — manual intervention required."
    fi
    log "  (attempt $i — waiting for server...)"
  done
fi

# ===================================================================
# Done
# ===================================================================
log ""
log "=========================================="
log "✅ Deploy complete"
log ""
log "Manual follow-ups (only if you changed nginx config or DB schema):"
log "  - nginx: sudo nginx -t && sudo systemctl reload nginx"
log "  - sanity: curl -sf $HEALTH_URL"
log "  - logs:   ssh $SERVER '$PM2_BIN logs $PM2_PROCESS_NAME --lines 20 --nostream'"
log "=========================================="

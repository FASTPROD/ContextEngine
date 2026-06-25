# Deploy Architecture Upgrade — Beyond "Rsync With Safety Belts"

**Status**: Design only — NO implementation yet. Awaiting user choice from the option matrix at the bottom.
**Context**: User's 2026-06-25 question after Sprint-15 scripts shipped: *"this procedure is run to update the server code I assume, is there an other way to do this more safe from start? longer 2 or 3 steps maybe but safer?"*
**Honest answer**: yes. `rsync` to a live serving directory is structurally risky no matter how disciplined the script is, because the write window is the same window nginx serves from. Below are 5 patterns that eliminate that window entirely.

## Why even the hardened rsync script is still risky

`compR.fr/deploy.sh` (Sprint-15 ship, commit `90e9135`) does whitelist + dry-run + snapshot + auto-rollback. That's a B+ in deploy safety. But:

1. **The rsync writes directly into the nginx-serving directory.** Mid-rsync, a visitor can hit `index.html` while `terms.html` is still the old version. Inconsistent state visible to real users.
2. **Any human bypassing the script** still has root rsync access to `/var/www/comprfr/`. The script doesn't *prevent* the unsafe shape; it just provides a safe shape.
3. **Rollback requires another rsync.** The script's auto-rollback re-pushes the snapshot — another 5-10 seconds of writes to the live dir.
4. **No real "staging".** First time you see if the new copy renders correctly in real Chrome is when it's already serving to your real users.

The patterns below fix this by removing rsync-to-live as the deploy primitive entirely.

---

## Option A — Atomic Symlink Swap (recommended for compR.fr)

**The pattern:**
- Server has `/var/www/comprfr-current` as a **symlink**, not a directory
- The symlink points at `/var/www/comprfr-YYYYMMDD-HHMMSS/` (a timestamped versioned dir)
- Nginx serves from the symlink (transparent — nginx follows symlinks natively)
- Deploy creates a NEW timestamped dir, rsyncs into it, smoke-tests it, then `ln -sfn` swaps the symlink atomically

**Why this is much safer:**
- The rsync target is a brand-new directory that's **not yet serving traffic**. Even a totally botched rsync (wrong files, partial transfer, anything) cannot corrupt the live site, because the live site is still served from the OLD timestamped dir until you flip the symlink.
- `ln -sfn` is atomic at the filesystem level. There's no "half-deployed" state visible to nginx — the symlink either points at the old dir or the new one, never both.
- Rollback is one `ln -sfn` back to the previous timestamped dir. **Sub-second**, no rsync needed.
- You can smoke-test the staged dir BEFORE flipping (`curl` with `Host:` header to nginx pointing at the new dir).
- The blast-radius point about sibling sites (admin.CROWLR, compr.app) gets even stronger: you can't accidentally `rsync` into the wrong dir, because every dir name is timestamped and unique.

**Server-side one-time setup (~10 min, you do this once):**

```bash
ssh admin@92.243.24.157

# (1) Stop nginx briefly to swap the dir → symlink (or skip this if you accept ~100ms gap)
sudo systemctl reload nginx  # not strictly needed; this is just to flush

# (2) Move the current live dir to its first timestamped name
cd /var/www
sudo cp -al comprfr/ comprfr-20260625-000000/    # cp -al = hardlink, ~instant
sudo rm -rf comprfr.old; sudo mv comprfr/ comprfr.old/  # safety backup
sudo ln -sfn /var/www/comprfr-20260625-000000 /var/www/comprfr  # symlink in place
ls -la /var/www/comprfr  # should show: comprfr -> /var/www/comprfr-20260625-000000

# (3) Verify nginx still works (no config change needed — it follows symlinks)
curl -s https://compr.fr/ | head -5

# (4) After 1 hour of confirmed-working state, remove the safety backup:
sudo rm -rf /var/www/comprfr.old/
```

**New deploy.sh (a v2 you'd write — concrete sketch):**

```bash
# Inside the script, no longer rsync into /var/www/comprfr/. Instead:
NEW_DIR="/var/www/comprfr-$(date +%Y%m%d-%H%M%S)"

# 1. Create the new timestamped dir
ssh admin@host "sudo mkdir -p $NEW_DIR && sudo chown admin:admin $NEW_DIR"

# 2. Rsync into the new dir (NOT touching the currently-live one)
rsync -av --no-perms --no-owner --no-group \
  "${DEPLOY_FILES[@]}" \
  "admin@host:$NEW_DIR/"

# 3. Smoke-test BEFORE flipping: curl localhost via the new dir
ssh admin@host "curl -s -H 'Host: compr.fr' http://localhost/ \
  --resolve compr.fr:80:127.0.0.1 -d 'X-Site-Dir: $NEW_DIR'" | grep "$HEALTH_MARKER"

# 4. Atomic flip
ssh admin@host "sudo ln -sfn $NEW_DIR /var/www/comprfr"

# 5. Verify live
curl -s https://compr.fr/ | grep "$HEALTH_MARKER"

# 6. Rollback (just one symlink swap to the previous timestamped dir)
# ls -la /var/www/comprfr-*  → see all available, pick previous
# sudo ln -sfn /var/www/comprfr-<previous-ts> /var/www/comprfr
```

**Trade-offs:**

| Aspect | Status quo (Sprint-15) | Option A symlink swap |
|---|---|---|
| Risk of corrupting live site | Low (script enforces) | **Zero** (rsync target is a new dir) |
| Rollback time | ~10s (rsync back snapshot) | **<1s** (one ln -sfn) |
| Wrong-target blast radius | Low (whitelist + dry-run) | **Impossible** (each dir name is unique) |
| Staging URL visible? | No | Yes (you can curl the new dir before flipping) |
| Server-side setup needed | None | One-time ~10 min |
| Disk space | 1× site | N× site (auto-prune old timestamps) |

**Estimate to implement:** ~10 min server setup + ~30 min to write v2 deploy.sh + ~10 min to test. **Total ~50 min for a one-time investment that permanently eliminates the live-dir risk.**

---

## ⚠️ Option B status: **DEFERRED 2026-06-25** — multi-agent diagnostic flagged 5 design errors + 2 structural blockers

The design below is **NOT shippable as-written.** A multi-agent root-cause pass (workflow `wdcraou93`, Agent A code-audit + Agent B adversarial + foreground probe-list) caught the following before implementation:

| # | What's broken | Severity |
|---|---|---|
| 1 | `server.ts:46` reads only `ACTIVATION_PORT` env — does NOT read `--port` argv NOR `PORT` env. Design's `pm2 start ... -- --port $INACTIVE_PORT` is ignored; both instances bind 8010 → second crashes. | Blocker |
| 2 | Port 3000 below collides with PLANK.io's documented backend (CLAUDE.md project table) | Blocker |
| 3 | Three conflicting PM2 process names across the repo (`contextengine-mcp` / `contextengine-api` / `contextengine-server`) | High |
| 4 | `nginx -s reload` step has no `nginx -t` gate; broken upstream block could break sibling sites | High |
| 5 | `server/deploy.sh:22` targets Gandi (92.243.24.157) but session docs name konive-ovh (217.182.204.86) for `api.compr.ch`. **Don't know which is correct without `dig`.** | Blocker (factual) |
| 6 | `licenses.db` SQLite WAL — single-writer; dual pm2 instances would hit `SQLITE_BUSY` | Structural |
| 7 | Stripe webhook double-provisioning risk during blue+green overlap | Structural |

**Action required before this section is trusted again:** run the 8 read-only ssh probes in [SPRINT_16_OPTION_B_PROBES.md](SPRINT_16_OPTION_B_PROBES.md). Probes #1, #2, #5, #7, #8 are gating. Probe #0 (`dig api.compr.ch`) resolves the Gandi/OVH contradiction and re-targets everything.

**Likely outcome after probes:** Agent A's safer alternative — symlink-versioned dirs + `db.pragma('busy_timeout = 5000')` — gives ~75% of blue/green's value (atomic deploys + crash-safe rollback) at ~5% of the cross-app risk. No dual-process. Recommend that path UNLESS probes prove every blue/green prerequisite is clean AND the SQLite single-writer is migrated off in-process SQLite.

The full draft is preserved below for context. **Read it AFTER the probe outputs, with the corrections above in mind.**

## Option B — Blue/Green for the Activation Server (recommended for `api.compr.ch`)

**The pattern:**
- Run TWO pm2 instances on different ports (3000 = "blue", 3001 = "green")
- nginx upstream has both, with a "current" upstream pointer
- Deploy to the inactive one, smoke-test it on its dedicated port, atomic nginx config swap, kill the old one after grace period

**Why this is safer for the server:**
- Currently, `pm2 restart` causes ~200-500ms downtime where the server isn't responding. Real customers' license activations and heartbeats fail during that window.
- Blue/green has **zero-downtime deploys** — nginx hot-reloads the upstream block (atomic), and in-flight requests on the old instance complete before it's killed.
- If the new code crashes on boot, the old instance is still serving — no impact on customers.
- A/B testing is possible (10% of traffic to green, watch metrics, ramp up).

**Server-side one-time setup (~30 min):**

```bash
ssh konive-ovh

# (1) Convert single-instance pm2 to blue/green
pm2 stop contextengine-api
pm2 delete contextengine-api

# Edit ecosystem.config.cjs to define two instances:
# {
#   apps: [
#     { name: 'opscontext-blue',  script: 'dist/server.js', env: { PORT: 3000 } },
#     { name: 'opscontext-green', script: 'dist/server.js', env: { PORT: 3001 } },
#   ]
# }
pm2 start ecosystem.config.cjs
pm2 save

# (2) Update nginx upstream block — two upstreams, one default
# /etc/nginx/sites-available/api.compr.ch:
# upstream opscontext_current {
#   server 127.0.0.1:3000;   # blue is initial active
# }
# upstream opscontext_blue  { server 127.0.0.1:3000; }
# upstream opscontext_green { server 127.0.0.1:3001; }
# server { ... proxy_pass http://opscontext_current; ... }

sudo nginx -t  # syntax check
sudo systemctl reload nginx

# (3) Verify both instances respond
curl http://127.0.0.1:3000/contextengine/health
curl http://127.0.0.1:3001/contextengine/health
curl https://api.compr.ch/contextengine/health  # should be blue's response
```

**New deploy.sh v2 (concrete sketch):**

```bash
# Determine current and target
CURRENT=$(grep -oE "127.0.0.1:[0-9]+" /etc/nginx/sites-available/api.compr.ch | head -1)
if [[ "$CURRENT" == "127.0.0.1:3000" ]]; then
  ACTIVE="blue"; INACTIVE="green"; ACTIVE_PORT=3000; INACTIVE_PORT=3001
else
  ACTIVE="green"; INACTIVE="blue"; ACTIVE_PORT=3001; INACTIVE_PORT=3000
fi

log "Active: $ACTIVE ($ACTIVE_PORT) | Deploying to: $INACTIVE ($INACTIVE_PORT)"

# 1. Rsync new code (only the inactive instance reads it — but they share dist/
#    so we must coordinate: deploy code to a versioned dir, then restart INACTIVE
#    with the new dir as its working dir)
NEW_DIST="/var/www/contextengine-server-$(date +%Y%m%d-%H%M%S)"
ssh host "mkdir -p $NEW_DIST"
rsync -avz dist/ host:$NEW_DIST/dist/

# 2. Restart only the INACTIVE pm2 instance with the new dist
ssh host "pm2 stop opscontext-$INACTIVE && \
          pm2 delete opscontext-$INACTIVE && \
          pm2 start $NEW_DIST/dist/server.js --name opscontext-$INACTIVE -- --port $INACTIVE_PORT"

# 3. Smoke-test the INACTIVE instance on its port (not yet serving production)
sleep 3
INACTIVE_HEALTH=$(curl -s http://host:$INACTIVE_PORT/contextengine/health)
[[ "$INACTIVE_HEALTH" == *"ok"* ]] || die "Inactive instance failed health check — aborting before flip"

# 4. Flip nginx — atomic
ssh host "sed -i 's/127.0.0.1:$ACTIVE_PORT/127.0.0.1:$INACTIVE_PORT/' /etc/nginx/sites-available/api.compr.ch && nginx -s reload"

# 5. Grace period — let in-flight requests on old instance complete
sleep 30

# 6. Stop the now-old instance (keep it as a hot rollback target for 10 min)
ssh host "pm2 stop opscontext-$ACTIVE"

# Rollback if needed: re-flip nginx, restart $ACTIVE
```

**Trade-offs:**

| Aspect | Status quo (server/deploy.sh) | Option B blue/green |
|---|---|---|
| Downtime per deploy | ~200-500ms (pm2 restart) | **Zero** (nginx reload atomic) |
| If new code crashes on boot | Production is down until pm2 falls back | **Zero impact** (old instance still serving) |
| Rollback | re-rsync old code + pm2 restart (~30s) | **Re-flip nginx** (~1s) |
| Mid-deploy customer impact | License activations fail during restart | **None** (old instance handles them) |
| Server-side setup needed | None | ~30 min one-time |
| Steady-state RAM cost | 1× server process | 2× server processes |

**Estimate:** ~30 min server setup + ~45 min to write v2 deploy.sh. **Total ~75 min for zero-downtime + crash-safe deploys.**

---

## Option C — Staging Subdomain (low-effort safety multiplier, stacks with A or B)

**The pattern:**
- `staging.compr.fr` and `staging-api.compr.ch` exist as separate sites with their own dirs/pm2 instances
- Deploy ALWAYS goes to staging first
- Visual + automated verification on staging
- Promote-to-prod step only after staging passes

**Why useful:**
- You see the new copy rendered in real Chrome BEFORE prod users do
- You can have automated regression tests run against staging post-deploy
- For the activation server: staging lets you test new endpoints against a copy of the licenses DB without touching prod

**Server-side setup:** ~20 min — add nginx server blocks for the staging hostnames + (if separate) duplicate the directory + DNS A record.

**Deploy.sh change:** ~10 min — deploy.sh just rsync to two targets, with an "approve" step in between.

**Stacks with A or B:** staging can ALSO use atomic symlink swap and/or blue/green internally. The patterns compose.

---

## Option D — Pull-Based Deploy (no SSH credentials on dev machine)

**The pattern:**
- Server has a tiny webhook listener (or a cron job) that periodically `git pull`s from a deploy-ready branch
- Push to git → server detects → server pulls → server runs its local deploy hooks
- Your laptop never SSHes to production

**Why safer:**
- Compromised dev machine cannot deploy bad code (only push to git, which requires the protected `deploy` branch protection rules)
- Audit trail is in git, not in shell history
- Multiple devs can deploy without sharing SSH credentials

**Trade-offs:**
- Loses the "human eyeballs verify before flip" step unless paired with B's blue/green
- Adds infrastructure (the webhook listener / cron)
- Server needs git + the ability to pull (already true here)

**Estimate:** ~1 hour to set up the webhook + ~30 min to wire deploy hooks server-side. Worth it if you want to add a second developer or use a CI service.

---

## Option E — Full CI/CD via GitHub Actions

**The pattern:**
- Push to `main` triggers GitHub Actions
- Actions runs tests + builds + deploys to staging
- Manual "approve" gates the production deploy
- Audit trail in GitHub UI

**Why safer:**
- Zero local-machine deploy capability (the deploy credential lives in GitHub Secrets, used only by Actions)
- Test gate is enforced — broken code can't deploy
- Standard industry pattern, well-documented

**Trade-offs:**
- Heaviest setup (~3-4 hours for first project, then ~1 hour per additional)
- Requires storing deploy credentials in GitHub Secrets (a different trust model)
- Locks you into GitHub for CI (acceptable if already using GitHub)

---

## Comparison matrix

| | Setup time | Per-deploy time | Rollback | Zero-downtime | Mid-deploy customer risk | Recommended for |
|---|---|---|---|---|---|---|
| **Status quo** (script) | 0 (done) | 2 min | 10s | No | Low | Bridge state, not the destination |
| **A: Symlink swap** | 50 min | 2 min | **<1s** | **Yes** | **Zero** | compR.fr + any static site |
| **B: Blue/green pm2** | 75 min | 3 min | **1s** | **Yes** | **Zero** | api.compr.ch + any Node server |
| **C: Staging subdomain** | 20 min | +1 step | (depends on flip) | (depends) | (depends) | Stacks with A or B |
| **D: Pull-based** | 90 min | git push only | manual | No (alone) | Low | Multi-dev team |
| **E: Full CI/CD** | 4 hr | git push only | re-deploy old commit | Yes (if A+B inside) | None | Production-grade SaaS |

---

## My recommendation

**Tomorrow's deploys: use Sprint-15 scripts as-is.** They're a B+ and good enough for what you're doing tomorrow (one CWS submission + one compR.fr copy refresh + one activation server endpoint add). Don't block tomorrow on architecture work.

**This week or next: implement Option A for compR.fr** (~50 min total). It's the highest-leverage single change — eliminates the live-dir-race risk entirely and gives you sub-second rollback. Worth doing before the next significant compR.fr update.

**This month: implement Option B for api.compr.ch** (~75 min total). The activation server is your most-customer-visible production surface. Zero-downtime deploys + crash-safe rollback is the right destination. Worth doing before you have many paying customers — every pm2-restart blip today is invisible because customers are few; that won't last.

**Later (or skip): Options C/D/E** — useful when team size grows. For a 1-person operation today, the marginal benefit doesn't justify the marginal complexity.

### What this looks like in 2 weeks

| Surface | Today | After Option A | After Option B |
|---|---|---|---|
| compR.fr deploy | hardened script | **symlink swap; sub-second rollback** | (same as A) |
| api.compr.ch deploy | server/deploy.sh (pm2 restart) | (same) | **zero-downtime blue/green** |
| Manual rsync risk | Eliminated by script | **Structurally impossible** | (same as A) |
| Server-side complexity | 1 process | 1 process + symlink convention | 2 processes + nginx upstream block |
| Recovery from bad deploy | ~10s | **~1s** | **~1s, no customer impact** |

### Concrete next-action choice for you

When you have an hour spare (not tomorrow — tomorrow is the publish sprint), reply with one of:

- 🟢 **Implement Option A now** — I'll write the server-side setup commands + the new deploy.sh v2 + test it. ~50 min.
- 🟢 **Implement Option B now** — same, for the activation server. ~75 min.
- 🟢 **Both A and B in one pass** — ~2 hours.
- 🟡 **Add Option C (staging)** to either — adds 20 min.
- 🔴 **Defer all — Sprint-15 scripts are good enough for now** — totally valid; revisit when scaling pressure hits.

My recommendation in order: **A first** (highest leverage, simplest, most reusable pattern). **B second** (slightly more setup, but where the customer-visible value is). Skip C/D/E unless team grows or compliance asks for them.

# Sprint 15 — User-Gated Steps After the 2026-06-25 Overnight Pass

> Each item below is something I deliberately did NOT do overnight, because it requires either your auth (npm OTP, marketplace PAT, $5 dev account) or touches live external state (production VPS, the live compR.fr site, etc.). Each has a numbered safety walkthrough.
>
> **Order recommendation:** items 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. The early items unlock the later ones (e.g. npm publish unlocks the new `opscontext` CLI features the README references).
>
> **You explicitly deferred Sprint-15 item #6** (the L3 design review). Try the existing solution first; come back when you're ready to choose ship-mode.

---

## 1. `npm publish` 2.1.2 — irreversible, OTP-gated

**Blast radius:** publishing to the public npm registry. Once published you can `npm unpublish` only within 72 hours and only for the exact version (downstream installs may have already cached). Pre-flight is your safety belt.

```bash
cd /Users/yan/Projects/ContextEngine

# (a) Pre-flight: confirm the version, the tarball, and the dist contents
cat package.json | grep '"version"'                          # must show "2.1.2"
npm run build                                                # rebuild from source
npm pack --dry-run 2>&1 | tail -30                          # see exactly what would ship
npx vitest run 2>&1 | tail -3                                # must say "276 passed"

# (b) Read the CHANGELOG entry one more time
sed -n '/## \[2.1.2\]/,/## \[vscode-ext 0.11.0\]/p' CHANGELOG.md | head -50

# (c) Verify npm token still works (DOES NOT publish — read-only whoami)
npm whoami                                                   # expect: your npm username

# (d) When ready, publish. You'll be prompted for 2FA OTP if your account has it enabled.
npm publish --access public

# (e) Verify within 60 seconds (npm registry caches but should be fresh)
npm view @compr/opscontext-mcp version                       # expect: 2.1.2
npm view @compr/opscontext-mcp dist.tarball                  # confirm tarball URL
```

**If it goes wrong:** `npm unpublish @compr/opscontext-mcp@2.1.2` within 72 hours (only). For anything later, you must publish 2.1.3 with the fix. Do NOT republish 2.1.2 even after unpublish — the registry caches version bytes for 24h.

**Skip the OTP loop if:** you'd rather batch all today's publishes into one terminal session — keep the OTP code window open between `npm publish` and `vsce publish` (item 2).

---

## 2. VS Code Marketplace publish — irreversible, PAT-gated

**Blast radius:** the Marketplace listing gets a new version. Old version is preserved but most users auto-update within 24h.

**Decision first:** there are TWO candidate versions on disk:
- `0.11.0` — drift-alert wiring (Session 13)
- `0.12.0` — if we fold the Session 14 B2 setup-orchestrator + uninstall command into a fresh bump

The B2 work landed AFTER 0.11.0 was staged, so `vscode-extension/package.json` currently says `0.11.0` but the code has both `driftAlertPoller` AND `setupOrchestrator` + `contextengine.uninstall`. Two options:

**Option A — ship as 0.11.0 (just bump nothing):** the Marketplace doesn't care that 0.11.0 grew between staging and publish.
**Option B — bump to 0.12.0:** cleaner CHANGELOG, but you'd have to write the entry. ~5 min.

Recommendation: **Option A**. The CHANGELOG entry at the top of `CHANGELOG.md` already covers the 0.11.0 features; the B2 work would fit as "Added: also includes setupOrchestrator hardening + uninstall command — folded from staged 0.12.0 work".

```bash
cd /Users/yan/Projects/ContextEngine/vscode-extension

# (a) Pre-flight
cat package.json | grep '"version"'                          # 0.11.0 (Option A) or 0.12.0 (Option B)
npm run compile                                              # tsc must be clean
ls media/icon.png && echo "icon present"                     # required by Marketplace

# (b) PAT — grab from .copilot-credentials.md
# look for "Azure DevOps PAT" or "VS Code Marketplace" section
grep -A2 -i "azure\|marketplace\|vsce" .copilot-credentials.md 2>/dev/null | head -8
#   if .copilot-credentials.md doesn't show it, the password manager fallback is
#   ymolinier@hotmail.com per SKILLS.md § VS Code Extension

# (c) Package locally first (verifies before publish)
npx @vscode/vsce package
ls *.vsix                                                    # contextengine-0.11.0.vsix should exist

# (d) Open the .vsix to sanity-check what's actually in the package
unzip -l contextengine-0.11.0.vsix | head -30
# should NOT see: out-test/, src/setupOrchestrator.test.ts, src/driftAlertPoller.test.ts
# (the tsconfig excludes *.test.ts from production compile; verify here)

# (e) Publish — paste PAT when prompted, or pipe in:
echo '<YOUR_PAT>' | npx @vscode/vsce publish

# (f) Verify in 1-2 minutes
open "https://marketplace.visualstudio.com/items?itemName=css-llc.contextengine"
```

**If it goes wrong:** `vsce unpublish css-llc.contextengine` removes the listing entirely. You CANNOT republish the same version number — must bump.

---

## 3. Chrome Web Store submission of `chrome-ext 0.1.4` — multi-step, irreversible

**This is the longest path.** ~30 min if everything is queued; 14-day Google review afterward.

### 3a. Deploy the privacy policy URL first

```bash
# The Chrome Web Store form wants a URL that hosts the privacy policy.
# We have chrome-extension/PRIVACY.md but it needs to be at a public HTTPS URL.

# Suggested URL: https://compr.fr/privacy-opscontext.html
# Option (i) — convert MD → HTML manually:
npx marked /Users/yan/Projects/ContextEngine/chrome-extension/PRIVACY.md > /tmp/privacy-opscontext.html
# Option (ii) — host the .md directly on GitHub Pages (no conversion needed):
# https://github.com/FASTPROD/ContextEngine/blob/main/chrome-extension/PRIVACY.md
# Use this URL in the submission form if you want to skip the rsync.
```

**If you go with option (i):** see Sprint-15 item #4 for the ssh-gandi rsync to push the .html file to /var/www/comprfr/.

### 3b. Capture 5 screenshots (1280×800 or 640×400)

Per the plan in `docs/CHROME_WEBSTORE_SUBMISSION.md` § 6:
1. **Hero shot** — claude.ai with the OpsContext popup open (green dot + recent events)
2. **Options page** — `chrome-extension://<id>/options/options.html` with all fields filled
3. **Live event flow** — terminal showing `tail -f ~/.contextengine/audit.log` with events landing
4. **Detector signal** (optional) — terminal showing `opscontext watch` firing
5. **Architecture diagram** (optional) — simple block diagram

```bash
# macOS screenshot tool: Cmd-Shift-4, region select. Save as PNG.
# Verify dimensions:
for f in ~/Desktop/Screenshot*.png; do file "$f" | grep -oE "[0-9]+ x [0-9]+"; done
# Each must be exactly 1280x800 OR 640x400 — Chrome rejects other sizes.
```

### 3c. Package the .zip for upload

```bash
cd /Users/yan/Projects/ContextEngine/chrome-extension
npm run package
# Produces opscontext-chrome-0.1.4.zip in this directory.
unzip -l opscontext-chrome-0.1.4.zip | head -20
# should contain: manifest.json (at root), background/, content/, popup/, options/, icons/
```

### 3d. Register $5 Google developer account (one-time)

```bash
open "https://chrome.google.com/webstore/devconsole"
# Sign in with your Google account → pay the $5 fee → wait for activation (~5 min)
```

### 3e. Create the listing in the dev console

1. Click "New Item" → upload `opscontext-chrome-0.1.4.zip`
2. Paste from `docs/CHROME_WEBSTORE_SUBMISSION.md`:
   - Short description (§3) — **verify with `wc -c` that it's ≤132 chars** (129 in the doc — paste exactly)
   - Detailed description (§4) — paste the full markdown; CWS renders it
3. Upload icons from `chrome-extension/icons/` (16/48/128 PNGs already generated)
4. Upload the 5 screenshots
5. Privacy policy URL: from step 3a
6. Submit for review

### 3f. After submission

Google's review window is 14 days. You'll get email updates. **If they reject:** the email tells you why; common reasons (per our adversarial CWS-reviewer audit) are addressed in the submission pack — accuracy of privacy claims, single-purpose, deceptive description. We pre-fixed all of these.

**If it goes wrong:** you can withdraw the submission and resubmit. Once approved, you can publish a new version anytime (item upload, same listing).

---

## 4. ⚠️ `ssh gandi` rsync of `compR.fr` — **CAREFUL: live external site**

**Blast radius:** the Gandi server at `92.243.24.157` hosts **3 production sites**:
- `compr.fr` (the portfolio we're updating)
- `admin.CROWLR` (admin panel for CROWLR)
- `compr.app` (the benchmark widget PWA)

A bad rsync could wipe one of the OTHER two if the rsync target path is wrong. **The safety belt is to push only specific files, not a whole tree.**

### 4a. Pre-flight — what's in the compR.fr commit we're deploying

```bash
cd /Users/yan/Projects/compR.fr
git log --oneline -3
# 0ad942c should be the most recent — that's the OpsContext card refresh + terms.html

# See exactly which files changed in 0ad942c
git diff-tree --no-commit-id --name-only -r 0ad942c
# expect: index.html, terms.html, SCORE.md, SKILLS.md, copilot-instructions.md
```

### 4b. SSH alive + jump-host fallback (per CLAUDE.md ssh policy)

```bash
# Try direct first (fastest)
ssh -o ConnectTimeout=5 admin@92.243.24.157 'echo "direct ssh ok"'

# If timeout / refused (fail2ban?), use the jump host
ssh -J debian@51.178.19.190 admin@92.243.24.157 'echo "via OVH-Ollama-VPS ok"'
# Or the second fallback
ssh -J debian@217.182.204.86 admin@92.243.24.157 'echo "via Konive OVH ok"'

# If you're locked out by fail2ban:
ssh -J debian@51.178.19.190 admin@92.243.24.157 \
    "echo '<pw-from-credentials-vault>' | sudo -S fail2ban-client set sshd unbanip <YOUR_PUBLIC_IP>"
# (find <YOUR_PUBLIC_IP> via: curl -s ifconfig.me)
```

### 4c. Confirm the production target path BEFORE pushing

```bash
# DRY-RUN — does the remote target exist and look right?
ssh admin@92.243.24.157 'ls -la /var/www/comprfr/ | head -10'
# Should show: index.html, terms.html, privacy.html, cookies.html, assets/, etc.
# If you see something OTHER than those — STOP, you're pointed at the wrong directory.
```

### 4d. Rsync ONLY the changed files (whitelist, not full tree)

```bash
cd /Users/yan/Projects/compR.fr

# DRY-RUN FIRST — see exactly what would change without actually changing
rsync -avn --no-perms --no-owner --no-group \
    index.html terms.html \
    admin@92.243.24.157:/var/www/comprfr/

# Read the "would transfer" output. Sanity check:
#   - Only index.html and terms.html should appear in the transfer list
#   - No "deleting X" lines (we're not passing --delete; if you see deletes, STOP)

# If dry-run looks right, drop the -n:
rsync -av --no-perms --no-owner --no-group \
    index.html terms.html \
    admin@92.243.24.157:/var/www/comprfr/

# Post-deploy: hit the live URL + confirm the new copy is there
curl -s https://compr.fr/ | grep -A1 "OpsContext\|@compr/opscontext-mcp" | head -10
# Should show "OpsContext" (NOT "ContextEngine") and the new npm package name
```

### 4e. Rollback if something looks wrong

```bash
# You have a git history of compR.fr — to roll back the local copy:
cd /Users/yan/Projects/compR.fr
git checkout HEAD~1 -- index.html terms.html       # restore old version locally
# Then rsync the OLD versions back to the server (same command as 4d).
# Verify with curl that the OLD copy is live again.
# Then `git restore index.html terms.html` to bring local back to current.
```

**Do NOT:**
- `rsync -a /Users/yan/Projects/compR.fr/ admin@host:/var/www/comprfr/` — trailing slashes + missing whitelist = nuke everything.
- `rsync --delete ...` — would wipe files on the server that don't exist locally.
- `scp -r .` — same risk class.

---

## 5. ⚠️ `ssh konive-ovh` rsync of community-rules server endpoint — **CAREFUL: live activation server**

**Blast radius:** the OVH VPS at `217.182.204.86` hosts the live `api.compr.ch` activation server. The current production endpoints (`/activate`, `/heartbeat`) serve real customers. Adding the new community-rules endpoint requires careful coordination so the existing endpoints don't go down.

### 5a. Pre-flight: what's the current production state?

```bash
# Hit the live /health endpoint
curl -s https://api.compr.ch/contextengine/health
# Should return a JSON status. If it doesn't — production is already down, stop and triage.

# Check what version of the server is running
ssh konive-ovh 'cd /var/www/contextengine-server && cat package.json | grep version'
# OR
ssh konive-ovh 'pm2 list | grep contextengine-server'
```

### 5b. Build the new server-side code

```bash
cd /Users/yan/Projects/ContextEngine/server

# Compile the server's TypeScript
npx tsc
ls dist/
# Should include: server.js (with the new route mounted), community-rules-server.js, ...

# Verify the new endpoint is wired into server.ts
grep -n "community-rules" dist/server.js
```

### 5c. Test the build locally (if you have a sandbox)

```bash
# Spin up the server on a dev port + smoke-test the new endpoint
cd server
PORT=7843 npm run start &       # background; uses a different port to not collide
sleep 2
# POST to the new endpoint with a known test license (from .copilot-credentials.md)
curl -X POST http://127.0.0.1:7843/contextengine/community-rules/fetch \
    -H "Content-Type: application/json" \
    -d '{"license_token":"<TEST-LICENSE-KEY>","machine_id":"test-machine"}' \
    | python3 -m json.tool
# Should return either a signed payload (if test license is PRO) or 403 (if free).
# Either is OK — confirms the endpoint is wired and the auth path runs.
kill %1                          # stop the dev server
```

### 5d. Push to production (the careful version)

```bash
# DRY-RUN FIRST — what's the diff between local dist/ and server's running dist/?
ssh konive-ovh "cd /var/www/contextengine-server/dist && ls -la community-rules-server.js 2>&1"
# Returns "No such file or directory" if not yet deployed (expected).

# Push only the NEW files (don't disturb existing server.js with a full tree sync)
cd /Users/yan/Projects/ContextEngine/server
rsync -avn \
    dist/community-rules-server.js \
    dist/community-rules-server.d.ts \
    konive-ovh:/var/www/contextengine-server/dist/
# Dry-run output should show just those 2 files transferring. If anything else shows up STOP.

# Drop -n + add the modified server.js (it's the only existing file that changed)
rsync -av \
    dist/community-rules-server.js \
    dist/community-rules-server.d.ts \
    dist/server.js \
    konive-ovh:/var/www/contextengine-server/dist/

# Also push the starter dataset
rsync -av \
    data/community-rules-tier-b.json \
    konive-ovh:/var/www/contextengine-server/data/
```

### 5e. Restart pm2 + smoke-test the live endpoint

```bash
ssh konive-ovh 'cd /var/www/contextengine-server && pm2 restart ecosystem.config.cjs && pm2 save'

# Wait 5 sec for the server to come up + verify the existing /health still works
sleep 5
curl -s https://api.compr.ch/contextengine/health        # must return JSON (NOT a 502)

# Verify the NEW endpoint is responding
curl -s -X POST https://api.compr.ch/contextengine/community-rules/fetch \
    -H "Content-Type: application/json" \
    -d '{"license_token":"definitely-not-a-real-license","machine_id":"test"}'
# Expect 401 — proves the endpoint is wired and the auth-fail path works (without leaking real data).

# Tail logs for 30 sec to make sure no startup errors
ssh konive-ovh 'pm2 logs contextengine-server --lines 20 --nostream'
```

### 5f. Rollback if /health goes 502

```bash
ssh konive-ovh '
  cd /var/www/contextengine-server
  # Restore the previous server.js from a backup (if pm2 was set up correctly,
  # it kept the old code in /var/www/contextengine-server.backup-<date>/)
  ls -la /var/www/contextengine-server.backup-*  # find the most recent
  cp /var/www/contextengine-server.backup-<DATE>/dist/server.js dist/server.js
  rm dist/community-rules-server.*  # remove the new files so server.js doesnt import a broken handler
  pm2 restart ecosystem.config.cjs
'
sleep 5
curl -s https://api.compr.ch/contextengine/health  # confirm back to 200
```

---

## 6. ⏭️ DEFERRED — L3 design review

You said: "I will start using the solution myself first and decide later for the Decision matrix for the user."

Acknowledged. When you're ready: open `docs/L3_IN_SESSION_INJECTION_DESIGN.md` and read the "Decision matrix for the user" section at the bottom. Four options:
- 🟢 Ship as designed (my recommendation)
- 🟡 Ship with PRO gate
- 🟠 Ship with opt-in only
- 🔴 Skip / redesign

Reply with the choice and I'll implement (~6 hours of work for v1).

---

## 7. Create the public Tier A rules repo

```bash
# Create the empty GitHub repo (browser easiest; or gh cli)
gh repo create FASTPROD/opscontext-community-rules \
    --public \
    --description "Tier A: free, MIT-licensed sanitized OpsContext learnings. Curated by maintainers."

# Clone it locally for the curation pass (item 8 writes the rules.json into it)
cd ~/Projects
git clone https://github.com/FASTPROD/opscontext-community-rules.git
cd opscontext-community-rules

# Minimal first commit (placeholder so item 8 has a target):
cat > README.md <<'EOF'
# OpsContext Community Rules (Tier A)

Sanitized operational learnings. MIT-licensed. Fetched daily by `opscontext sync-community-rules`.

Auto-rebuilt from the maintainer's `opscontext export-learnings --tier A` runs. PRs welcome (see CONTRIBUTING.md when it exists).
EOF
cat > LICENSE <<'EOF'
MIT License
... (standard MIT text)
EOF
echo '{"version":1,"tier":"A","generatedAt":"2026-06-25T00:00:00.000Z","count":0,"rules":[]}' > rules.json
git add README.md LICENSE rules.json
git commit -m "init: empty Tier A starter — will be populated via opscontext export-learnings --tier A"
git push origin main
```

---

## 8. Run `opscontext export-learnings --tier A` to seed

After items 1 (npm publish) + 7 (repo exists) are done:

```bash
# Generate the Tier A export from your 942+ local learnings
opscontext export-learnings --tier A --output /tmp/tier-a-export.json --review

# --review opens $EDITOR (vi by default) on the JSON so you can manually trim
# any borderline rules before they ship to public. Pay attention to:
#   - Anything that mentions a customer name (you'd recognize)
#   - Anything that describes a non-public production incident
#   - Anything that references an internal port number, internal hostname, etc.
#
# The redactor already strips secrets + PII + brand names, but human review
# is the final IP-safety belt.

# Copy the curated file into the public repo
cp /tmp/tier-a-export.json ~/Projects/opscontext-community-rules/rules.json
cd ~/Projects/opscontext-community-rules
git diff -- rules.json | head -30                # eyeball the actual changes
git add rules.json
git commit -m "feat: seed Tier A library — N curated rules from maintainer export $(date +%Y-%m-%d)"
git push origin main

# Verify the URL the sync client will hit (no auth required — public repo)
curl -s https://raw.githubusercontent.com/FASTPROD/opscontext-community-rules/main/rules.json | head -5

# Local sanity test of the sync client against the new repo
opscontext sync-community-rules --tier A
cat ~/.contextengine/community-learnings.json | head -10
```

---

## Quick reference — what you DON'T need to do tomorrow

- `audit-rotate` for the existing index-2826 break — fixed in code; new chains write race-free. The historical break is tamper-evident-preserved (don't heal it).
- Run any commands listed in `docs/SPRINT_15_USER_GATED.md` (this file) more than once — each is idempotent OR has its own dedicated dry-run/rollback.
- Touch `~/.contextengine/learnings.json` directly — `opscontext save-learning` is the API.
- Worry about chrome-ext + vscode-ext build state — both are committed at clean compiles; rebuild before publish only if you've edited.

## Diagnostics-before-destruction (from your py-spy observation)

You flagged a meta-pattern worth saving:
> "If you want me to diagnose deeper before any restart: install py-spy and run `py-spy dump --pid 97833` to see what the worker is stuck on. That's read-only and proves hypothesis 1 vs 2 vs 3."

I saved two persistent learnings to the OpsContext store:
1. **Meta**: before restarting/killing a stuck process, propose a read-only diagnostic FIRST. Restart-first throws away the evidence that explains why.
2. **Tool tip**: `py-spy dump --pid <PID>` is the Python equivalent for live workers — installs via `pip install py-spy`, no instrumentation needed, distinguishes network-wait vs CPU-bound vs deadlock without restarting.

Both are now in `~/.contextengine/learnings.json` (category=debugging + category=tooling); they'll auto-surface in `search_context` queries about stuck processes.

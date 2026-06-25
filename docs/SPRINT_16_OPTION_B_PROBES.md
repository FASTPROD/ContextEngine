# Sprint 16 — Read-Only SSH Probes Required Before Option B (Blue/Green Activation Server)

> Multi-agent diagnostic (workflow `wdcraou93`, 2026-06-25) found Option B as drafted in [DEPLOY_ARCHITECTURE_UPGRADE.md](DEPLOY_ARCHITECTURE_UPGRADE.md) is **NOT shippable**. Agent A + Agent B independently rated cross-app risk MED → HIGH; both flagged that the design assumes facts about the VPS that we have not verified.
>
> **Before any code change for Option B**, run the 8 probes below — all read-only, none modify production. Each is annotated with what it proves AND what the output would look like if blue/green is unsafe.
>
> **If any probe returns its "unsafe_if" condition: STOP**, file what's blocking, choose between (a) fix the prerequisite, (b) downgrade to the symlink-versioned-dir variant (Agent A's safer alternative), or (c) defer indefinitely.

---

## What the multi-agent diagnostic found

Run [workflow `wdcraou93`](/private/tmp/claude-501/-Users-yan-Projects-INVOK-fr/8b3f9572-8df1-4b4a-896f-02b43c43ab6b/tasks/wdcraou93.output) (cached) for the full verdicts. Summary of contradictions in our current design:

| # | Issue (caught by) | Where it lives |
|---|---|---|
| 1 | `server.ts:46` reads `process.env.ACTIVATION_PORT \|\| 8010` — does NOT read `PORT` env nor `--port` argv. The blue/green design's `pm2 start ... -- --port $INACTIVE_PORT` is silently ignored. Both instances bind 8010; second crashes. | Agent A + Agent B agreed |
| 2 | Port 3000 in the design doc **collides with PLANK.io's documented backend port** (per global CLAUDE.md project table). | Agent B |
| 3 | Three conflicting PM2 process names: `contextengine-mcp` (`ecosystem.config.cjs:9`), `contextengine-api` (`deploy.sh:27`), `contextengine-server` (`SPRINT_15_USER_GATED.md:358`). `pm2 reload <name>` against the wrong name does nothing; against `ecosystem.config.cjs` reloads ALL processes. | Agent B |
| 4 | `nginx -s reload` step has no `nginx -t` gate. A syntax error in our upstream block would silently leave the prior config active, but if the broken sed touches a shared upstream name, sibling sites are affected on next reload. | Agent B |
| 5 | **Factual contradiction**: `server/deploy.sh:22` targets `admin@92.243.24.157` (Gandi VPS), but `docs/sessions/SESSION_15` + `docs/SPRINT_15_USER_GATED.md` + `docs/about.md` all describe the activation server as running on konive-ovh (`217.182.204.86`). One of these is wrong. We don't know which VPS actually serves `api.compr.ch` without `dig`. | Foreground (probe builder) |
| 6 | SQLite `licenses.db` opened with WAL at `server.ts:65` + held by 7 prepared statements in-process. Two pm2 instances writing to the SAME WAL file will hit `SQLITE_BUSY` under contention during blue+green overlap. | Agent A |
| 7 | Stripe webhook handler at `server.ts:214` calls `provisionLicense`. During blue+green simultaneous-run window, Stripe retries can hit DIFFERENT instances → **double-license-provisioning risk**. | Agent B |
| 8 | `express-rate-limit` is in-memory per-process. Two instances = 2× effective rate-limit ceiling (10/min instead of 5/min). | Agent B |

---

## The 8 probes — run in this exact order

Each command is read-only. Paste each one into your terminal, capture the output, paste it back into a conversation with Claude (or this doc as a comment). Claude will interpret the output against the "unsafe_if" clause and tell you whether blue/green is safe to proceed.

**Probe #0 — `dig` resolves the Gandi-vs-OVH contradiction (RUN THIS FIRST)**

```bash
dig +short api.compr.ch
curl -sI https://api.compr.ch/contextengine/health -o /dev/null -w '%{http_code} %{remote_ip}\n'
```

*Proves:* Authoritatively resolves which VPS actually serves `api.compr.ch` — Gandi (92.243.24.157) or OVH (217.182.204.86). This is the contradiction between `deploy.sh` and session docs that MUST be resolved before any blue/green plan is trusted.
*Unsafe if:* `remote_ip` differs from what `deploy.sh`/`SESSION_15` says → ALL downstream probes need to be re-targeted. If DNS returns BOTH IPs (round-robin) → blue/green is impossible without DNS-level coordination — STOP.

**Probe #1 — port availability + sibling port enumeration**

```bash
ssh konive-ovh "ss -tlnp 2>/dev/null | grep -E ':(3000|3001|8010|8011|8012|8002|8003|10000) '"
# (replace 'konive-ovh' with whichever host probe #0 actually returns)
```

*Proves:* Lists every TCP listener on candidate blue/green ports + neighboring apps' ports (KONIVE 8012, agent.invoq.me.ai 8002, FC_project 8003/10000 per CLAUDE.md project table).
*Unsafe if:* 3000 or 3001 already LISTEN'd by another process → inactive pm2 instance fails to bind on boot → silent failure. If 8010 shows TWO listeners → production is already in some unexpected dual-process state.

**Probe #2 — pm2 process inventory**

```bash
ssh konive-ovh "sudo /usr/local/node-v18.19.0-linux-x64/bin/pm2 list 2>/dev/null || pm2 list"
```

*Proves:* Enumerates every pm2-managed process on the VPS. Reveals all sibling apps so we know what a fleet-wide command would touch.
*Unsafe if:* `contextengine-api` (or whatever the real name turns out to be) shows restarts > 5/day → server already unstable, adding blue/green risk is wrong. If pm2 list shows >8-10 apps → ecosystem.config.cjs likely shared, our changes would conflict.

**Probe #3 — pm2 per-process details (exec_mode + cwd + script paths)**

```bash
ssh konive-ovh "sudo /usr/local/node-v18.19.0-linux-x64/bin/pm2 prettylist 2>/dev/null | head -200"
```

*Proves:* Per-process pm2_env including cwd, script path, exec_mode (fork vs cluster), instance count.
*Unsafe if:* Any sibling process uses `exec_mode=cluster` with `instances>1` → pm2 reload is multi-step + partial reloads possible → blue/green needs different semantics.

**Probe #4 — locate all ecosystem.config files (shared vs per-app)**

```bash
ssh konive-ovh "find / -maxdepth 4 -name 'ecosystem.config.*' -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null"
```

*Proves:* Locates ALL ecosystem config files. There may be ONE shared file at `/home/debian/ecosystem.config.cjs` governing every app, or per-app files.
*Unsafe if:* Single shared `ecosystem.config.cjs` lists every app → editing it for blue/green could syntax-break the whole fleet on next `pm2 startOrReload`. If 0 files found → current pm2 state is in-memory only, restart loses everything.

**Probe #5 — full nginx config dump**

```bash
ssh konive-ovh "sudo nginx -T 2>&1 | head -400"
```

*Proves:* Full effective nginx config. Reveals how `api.compr.ch` is proxied today, whether upstream blocks are shared across server_names, where SSL cert lives.
*Unsafe if:* `api.compr.ch` upstream is named generically (e.g. `upstream backend`) and that name is referenced by sibling sites → editing for blue/green silently re-routes sibling. If `proxy_pass` hard-coded to `http://127.0.0.1:8010` with no upstream block → sed-flip works but loses weighted-routing option.

**Probe #6 — sites enumeration**

```bash
ssh konive-ovh "sudo ls -la /etc/nginx/sites-enabled/ && sudo ls -la /etc/nginx/sites-available/"
```

*Proves:* Every site nginx serves on this VPS. Cross-check against pm2 list — every pm2 app should map to a sites-enabled vhost.
*Unsafe if:* sites-enabled count > pm2 list count → some apps served outside pm2 (systemd, docker, raw) → blue/green plan misses dependencies.

**Probe #7 — upstream + proxy_pass enumeration**

```bash
ssh konive-ovh "sudo grep -rn -E 'upstream|proxy_pass' /etc/nginx/sites-available/ /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null"
```

*Proves:* Locates every upstream block + proxy_pass directive. Confirms whether `api.compr.ch` shares an upstream pool with any sibling.
*Unsafe if:* Two server_names point at same upstream name → sed-replace in design doc's deploy.sh would flip BOTH (collateral damage). If proxy_pass points at a Unix socket → port-based blue/green doesn't apply at all.

**Probe #8 — `licenses.db` writer status (single-writer baseline check)**

```bash
ssh konive-ovh "sudo lsof /var/www/contextengine-server/data/licenses.db 2>/dev/null || sudo lsof /var/www/contextengine-server/licenses.db 2>/dev/null"
# (path depends on where the active code actually lives — adjust per probe #4's findings)
```

*Proves:* Whether `licenses.db` currently has a single writer (single PID with FD open in `w` mode) or multiple. Confirms Agent A's SQLite-single-writer concern.
*Unsafe if:* More than one PID has the file open for write → another process already shares the DB → blue/green's "two instances" assumption is already partly broken. If 0 results → the DB path is wrong in this probe; fix and re-run.

---

## Decision tree (what to do based on probe outputs)

```
Probe #0:
├─ api.compr.ch resolves to ONE of {92.243.24.157, 217.182.204.86}
│  ├─ Matches deploy.sh (Gandi 92.243.24.157)?
│  │  ├─ YES → great; update all session docs that wrongly named konive-ovh
│  │  │       → run probes #1-#8 against admin@92.243.24.157
│  │  └─ NO → update deploy.sh:22 + all references; run probes against konive-ovh
│  └─ Matches konive-ovh (217.182.204.86)?
│     └─ Update deploy.sh:22 + run probes against konive-ovh
└─ DNS round-robin (BOTH IPs)
   └─ STOP. Blue/green requires DNS-coordination first. Out of scope.

Probes #1, #2, #5, #7 all green (no sharing / no collisions):
├─ Probe #8 confirms single-writer SQLite
│  ├─ Choose between:
│  │  ├─ Agent A's path: symlink-versioned dirs + busy_timeout pragma — atomic deploys + crash-safe rollback, NO dual-process. (Safer; ~75% of blue/green's value at 5% of the risk.)
│  │  └─ Agent B's path: full dual-pm2-app blue/green AFTER fixing 5 prerequisite errors in our doc. (Higher upside, higher implementation cost.)
│  └─ Probe #8 shows multiple writers
│     └─ Migrate licenses.db off in-process SQLite FIRST (Postgres? Redis? external) — blue/green not possible until that lands.

Any of probes #1, #2, #5, #7 red:
└─ DEFER. File the specific blocker. Don't try to work around.
```

---

## What gets done BEFORE the probes (already shipped)

In SESSION_15, we shipped these regardless of Option B's fate — they're safe in isolation:

- ✅ `compR.fr/deploy.sh` v1 (hardened rsync; commit `90e9135`)
- ✅ `compR.fr/setup-symlink-deploy.sh` + `deploy-v2.sh` (Option A for compR.fr; commit `727c98a`) — orthogonal to Option B; ship anytime
- ✅ Global CLAUDE.md rule "Multi-Tenant VPS Deploy — Canonical Pattern"
- ✅ `docs/DEPLOY_ARCHITECTURE_UPGRADE.md` (the design that this audit just contradicted)
- ✅ `docs/SPRINT_15_USER_GATED.md` (still valid — Option B section will be revised based on probe outcomes)

---

## Meta-finding: why the multi-agent diagnostic was worth the 3.5 minutes

The original `DEPLOY_ARCHITECTURE_UPGRADE.md` Option B section looked plausible. It would have shipped as-written if a single-pass implementation followed the design. The multi-agent pass found **5 specific code-level errors** (port-binding mismatch, port collision with PLANK, three process names, missing nginx -t gate, Gandi-vs-OVH confusion) **PLUS 2 structural blockers** (SQLite single-writer, Stripe double-provision) **PLUS** the entire VPS-identity contradiction.

This is the canonical case for the pattern: any architecture change touching shared infrastructure on a multi-tenant production server deserves multi-agent + adversarial verification BEFORE implementation, not as a post-hoc check. Especially when the "doc" was written by the same agent who would implement it (no independent eyes).

Memory: `feedback_multi_agent_for_shared_infra.md` saved this lesson.

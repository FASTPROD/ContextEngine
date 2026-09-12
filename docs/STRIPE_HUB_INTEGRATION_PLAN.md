# ContextEngine on the Stripe Hub: memberships, steps, who does what

Written 2026-09-12 (session 28). Decision by Yan the same day: ContextEngine sells through the
Stripe Hub (`~/Projects/STRIPE backend`, live at `api.compr.ch/stripe-hub`), not through the
activation server's own Stripe code. The hub audit of 2026-09-10
(`STRIPE backend/docs/SESSION_2026-09-10_HUB_RECEIVERS.md`, table row "contextengine") had
recommended the opposite, "own endpoint, no app code", because it was the least work. The own
endpoint was proven that way on 2026-09-12, in test mode. Yan then chose the hub: one Stripe
integration for the fleet, live mode already wired, one dashboard, one signing secret.
Cost of the choice: about one day of agent work plus one hour of Yan's hands, against a
config-only go-live on the own endpoint. Recorded here so nobody re-litigates it by accident.

## 1. Where things stand (verified 2026-09-12, read-only)

- Hub project `contextengine` exists: `active 1`, currency **usd**, callback URL **empty**,
  `success_url https://compr.ch/contextengine/success`, 0 subscriptions, 0 webhook rows.
- Hub plans for it, already synced to Stripe live (product and price ids set): `pro` USD 2/month
  "1 machine", `team` USD 12/month "5 machines", `enterprise` USD 36/month "unlimited machines,
  custom adapters, SSO". Monthly only.
- The activation server's own pricing page (`server/public/pricing.html`) sells in **CHF**, three
  tiers, monthly and annual: Pro CHF 2/month or 20/year, 2 machines; Team CHF 12/month or 120/year,
  5 machines; Enterprise CHF 36/month or 360/year, 10 machines. Plan keys `pro_monthly`,
  `pro_annual`, `team_monthly`, `team_annual`, `enterprise_monthly`, `enterprise_annual`, mapped by
  `PLAN_CONFIG` in `server/src/stripe.ts` to maxMachines 2 / 5 / 10 and 1 or 12 months.
- The two catalogues disagree on currency, machine counts, annual plans and features. The hub
  catalogue is the one buyers will see through checkout, so it is the one to fix (section 2).
- The activation server's own Stripe path is in **test mode** (`sk_test_` key, test-mode webhook
  endpoint `we_1T42YVJARWpNRnC4mFpskAiB`, proven 2026-09-12). It stays as is until section 4 step 8.

## 2. The memberships (the catalogue to enter in the hub admin)

Currency CHF everywhere (project setting `currency chf`, today `usd`: Yan's confirmation needed,
CHF is what the page and every other hub project use). Plan slugs follow the admin-crowlr
convention `<family>-<cycle>`, because the receiver derives the licence plan from the slug.

| Hub plan slug | Name | Price | Interval | Machines | Description (one line) | Features (JSON array in the hub) |
|---|---|---|---|---|---|---|
| `pro-monthly` | Pro | CHF 2.00 | month | 2 | Single developer, 2 machine activations | hybrid search (BM25 + local embeddings), learnings store, sessions, project scoring, compliance audit log, MCP server + CLI, community rules |
| `pro-annual` | Pro, annual | CHF 20.00 | year | 2 | Single developer, 2 machines, two months free | same as Pro |
| `team-monthly` | Team | CHF 12.00 | month | 5 | Small team, 5 machine activations | everything in Pro, priority support by email (2 business days) |
| `team-annual` | Team, annual | CHF 120.00 | year | 5 | Small team, 5 machines, two months free | same as Team |
| `enterprise-monthly` | Enterprise | CHF 36.00 | month | 10 | Organisation, 10 machine activations | everything in Team, help building a custom adapter (Notion and RSS examples ship in `examples/`), invoice billing on request |
| `enterprise-annual` | Enterprise, annual | CHF 360.00 | year | 10 | Organisation, 10 machines, two months free | same as Enterprise |

Rules behind the table:
- Machine counts are what the licence enforces (`PLAN_CONFIG`), not marketing. The hub's current
  "1 machine" and "unlimited" would sell something the server does not grant. Enterprise stays at 10
  unless `PLAN_CONFIG` changes in the same commit.
- **No SSO.** The hub's current enterprise text promises SSO; nothing in the code provides it. Do not
  list it until it exists.
- Trial days 0 (the free tier is the unlicensed product itself: search, learnings, sessions work
  without a licence; `score_project`, `run_audit`, `check_ports`, `list_projects` are the gated
  tools).
- Every plan `active 1`, sort order 0 to 5 in the table's order.
- Existing hub plans `pro`, `team`, `enterprise` (USD, monthly): rename to the slugs above or delete
  and recreate, then **Sync** each plan (the hub refuses checkout for an unsynced plan; syncing
  creates new Stripe prices, the old USD prices stay archived in Stripe and hurt nothing).

## 3. Who does what

| Step | Hands | Where |
|---|---|---|
| Hub project settings and the six plans, Sync | Yan | hub admin (token in `STRIPE backend/.copilot-credentials.md`) |
| Receiver endpoint on the activation server, tests, pricing page change | agent | this repo, `server/` |
| Deploy of the server | agent runs `server/deploy.sh` after Yan's GO (dry-run shown first) | crowlr2 |
| Callback key: generate, put on the server, put in the hub admin | Yan | ecosystem file on crowlr2, hub admin |
| Proof purchase, cancel, refund | Yan | Stripe checkout with his own card |
| Verification, read-only | agent | health, logs, `licenses.db`, hub `webhook_logs` |

## 4. Steps, in order

1. **Yan, hub admin.** Project `contextengine`: currency `chf`, description "OpsContext for AI
   agents: searchable project knowledge, learnings, sessions and compliance audit for Claude Code
   and other MCP clients", `success_url` = `https://api.compr.ch/contextengine/success`
   (`server/public/success.html` is served there; check that `compr.ch/contextengine/success` is
   not a dead URL before keeping it), `cancel_url` = `https://api.compr.ch/contextengine/pricing`,
   statement descriptor `COMPR OPSCONTEXT`. Then the six plans of section 2, Sync each, and check
   every plan shows a Stripe price id.
2. **Agent, receiver.** `POST /contextengine/hub-callback` in `server/src/server.ts` (or a new
   `server/src/hub-callback.ts`), modelled on the FC_project reference (`FC/routes/subscription.py`,
   LOCK `[HUB_CALLBACK_ACTIVATES_TIER]`) and the admin.CROWLR receiver
   (`StripeHubCallbackController`, LOCK `[HUB_CALLBACK_ACTIVATES_PACKAGE]`):
   - Auth: the shared key as the `key` query parameter, constant-time compare against
     `HUB_CALLBACK_KEY` from the process env; 403 without or with a wrong key, 503 when the env
     value is empty. Also accept `X-Hub-Signature` (`t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`,
     reject a timestamp older than 5 minutes) from `HUB_CALLBACK_SECRET`, so the endpoint is ready
     the day the hub signs its callbacks (hub decision 6, recommended 2026-09-11).
   - Four event shapes, nothing else: `checkout.session.completed` provisions the licence
     (`provisionLicense(db, email, planKey, customerId, subscriptionId)`, `planKey` derived from
     `metadata.plan_slug` by replacing `-` with `_`; email from `customer_details.email` then
     `customer_email`; `client_reference_id` recorded when present) and sends the licence email;
     `customer.subscription.deleted` calls `deactivateLicenseByStripe(db, subscription.id)`;
     `invoice.payment_failed` writes an audit row; `crypto_payment.succeeded` provisions like a
     checkout, months from the plan slug.
   - Idempotent per `(event_type, object id)` in a new `hub_callback_events` table; a repeat answers
     200 and does nothing. Rate limited like the activation endpoints. Raw body kept for the HMAC.
   - Tests next to `community-rules-server.test.ts`: key check, signature check, the four shapes, a
     repeat, an unknown plan slug (must not throw a 500 to the hub: log, audit, answer 200).
   - The key travels in the URL, and nginx on crowlr2 logs request lines (hub finding 1). The
     activation server itself logs no request lines. Until the hub signs callbacks, this is the same
     exposure invoc.me carries; the HMAC path above is the way out, not an nginx change.
3. **Agent, checkout.** `server/public/pricing.js`: the buy buttons post to
   `https://api.compr.ch/stripe-hub/api/checkout` with `project_slug: "contextengine"`,
   `plan_slug` from the table, `customer_email` (the hub requires it: add an email field to the
   pricing page, validated client side), `success_url`, `cancel_url`, then follow the returned
   `url`. `client_reference_id` stays empty (no account exists before purchase; the licence key
   goes by email). The server's own `/contextengine/create-checkout-session` stays mounted but
   unused until step 8.
4. **Agent, deploy.** `npm run build` in `server/`, tests green, commit, then
   `cd /Users/yan/Projects/ContextEngine/server && ./deploy.sh --dry-run`, show it, Yan's GO, real
   run. After the deploy the live endpoint must answer 503 to a bare POST (no key configured yet):
   `curl -s -X POST https://api.compr.ch/contextengine/hub-callback -d '{}' -H 'Content-Type: application/json'`.
5. **Yan, key.** `openssl rand -hex 24` on the Mac. On crowlr2 the value goes into the ecosystem
   file as `HUB_CALLBACK_KEY: "<value>",` (same `read -rs` + `sed` method as the webhook secret on
   2026-09-12, counts only, never print the file), then `pm2 delete contextengine-api`,
   `pm2 start ecosystem.config.cjs --only contextengine-api`, `pm2 save --force`. The bare POST now
   answers 403. Then hub admin, project `contextengine`, callback URL
   `https://api.compr.ch/contextengine/hub-callback?key=<value>`, Save.
6. **Yan, proof.** No ContextEngine hub event exists to resend (0 rows), so one real checkout:
   Pro monthly, CHF 2, Yan's own email and card. Agent verifies read-only: hub `webhook_logs` row
   `checkout.session.completed` with `project_slug contextengine` processed, activation server
   `licenses` row (plan pro, 2 machines, active), `stripe_mapping` row, the licence email received,
   the pm2 log line. Then Yan cancels the subscription in Stripe (immediately): agent verifies
   `customer.subscription.deleted` reached the receiver and the licence row is `is_active 0`. Then
   the CHF 2 refund in the dashboard.
7. **Agent, record.** SKILLS.md § Stripe Payment Integration rewritten for the hub path, session
   doc, CE learning, LOCK on the receiver (`[HUB_CALLBACK_ACTIVATES_LICENSE]`).
8. **Later, one more commit after a week of hub-only sales.** Remove the server's own Stripe
   checkout route and webhook route, the six `STRIPE_PRICE_*` values and `STRIPE_SECRET_KEY` from
   the ecosystem file (Yan's hands), delete the test-mode endpoint `we_1T42YV...` in the Stripe
   dashboard, drop the `stripe` npm dependency from `server/package.json`. Not before the proof of
   step 6 and not in the same commit as the receiver.

## 5. Decisions for Yan before step 1

1. Currency CHF (the page) rather than USD (today's hub project).
2. Machine counts 2 / 5 / 10 as the licence enforces, or change `PLAN_CONFIG`.
3. Annual plans kept (two months free), six plans in total.
4. Feature wording: no SSO; "custom adapters" phrased as help, not a product.
5. Statement descriptor and the project description text above.

## 6. What this does not cover

Crypto (NOWPayments) through the hub for ContextEngine: the receiver accepts the shape, the
end-to-end proof is the fleet-wide one planned for next week (hub decision 7). Signed callbacks are
the hub's build (decision 6); this receiver only verifies them when they arrive.

# Prompt: the hub is healthy, now every project sells and activates (opened 2026-09-12)

Paste this into a new chat opened in `~/Projects/STRIPE backend` (or continue the payment chat of
2026-09-10 there). It continues `docs/PROMPT_HUB_CALLBACK_RECEIVERS.md` and the state recorded in
`docs/SESSION_2026-09-10_HUB_RECEIVERS.md` with its 09-11 addenda; read both first, then
`~/Projects/ContextEngine/docs/sessions/SESSION_28_2026-09-12.md` for what changed on 09-12.

---

You support Yan on the compR fleet. This chat has ONE job, in this order: confirm the Stripe Hub
webhook is healthy and harden the one weak spot in it, then bring every hub project to "a payment
activates the buyer", one project at a time, each with a proof. Yan's hands touch every server env
and every hub admin form; you write code in the app repos, deploy through each repo's committed
deploy script, and verify read-only. Never a second payment to test when a resend will do.

## Verified state, 2026-09-12 evening (read-only: curl, ssh, better-sqlite3 readonly, Stripe CLI)

- **The 45 % error rate Stripe shows for `stripe-hub-production`
  (`https://api.compr.ch/stripe-hub/api/webhooks/stripe`) is residue, not a live failure.** Hub
  `webhook_logs` holds 11 rows ever; the 4 since 2026-09-09 16:40 (checkout.session.completed,
  subscription.updated, invoice.payment_succeeded, subscription.deleted, all invocme) are
  `processed 1`, no error. The five 400s of the 09-09 morning (stale signing secret, refreshed by
  Yan at 16:40) are 5 of 11 deliveries: 45 %. Job 1 is to confirm this on Stripe's side, not to
  hunt a bug that is not there.
- **One real weak spot in the hub webhook path** (`src/stripe-service.ts`, after the switch): the
  forward to `webhook_callback_url` is an awaited `fetch` with no timeout and no retry, inside the
  response to Stripe. A slow receiver makes the hub answer late, Stripe times out and retries, and
  the log shows a success. Fix in job 2.
- **ContextEngine changed course on 09-12.** Its own endpoint is proven, but in test mode, and Yan
  decided the hub route: `~/Projects/ContextEngine/docs/STRIPE_HUB_INTEGRATION_PLAN.md` has the
  catalogue (six CHF plans), the receiver spec and the steps. The hub side of it (project currency
  chf, six plans, Sync, callback URL) is Yan's hands in the hub admin, guided from this chat; the
  code side is done in the ContextEngine repo. The hub project today: `usd`, three monthly plans
  (USD 2 / 12 / 36, "1 machine", "unlimited", "SSO"), callback empty, 0 subscriptions.
- **Correction to the 09-10 doc, GO 2 step 2:** the ContextEngine secrets do not live in a `.env`
  and `pm2 restart --update-env` does not apply. They sit in the pm2 ecosystem file in the server
  directory (both Stripe values on the same line), reload is `pm2 delete` + `pm2 start
  ecosystem.config.cjs --only contextengine-api` + `pm2 save --force`. Fix that line in the doc.
- Pending from the 09-11 addenda, unchanged today: admin-crowlr receiver built at `782a9e9f` on
  `upgrade/laravel-11`, not deployed, then Yan's four steps (key, hub callback URL, Sync the six
  plans, one real checkout); hub Active switch at `04736e9`, not deployed; signed callbacks
  (decision 6) recommended, not built; Invoc+ CHF 2 proof not run; app-crowlr and compr-app wait
  for Yan's word on what a payment unlocks; konive nothing without a GO; demand and crowlr to
  deactivate; crypto end to end next week.
- Stripe CLI is logged in on the Mac (Crowlr account, 90 days). Test mode by default; any `--live`
  call from a non-interactive shell blocks on the macOS keychain prompt. `stripe events list
  --live` works once Yan clicks Allow; `stripe events resend <evt_> --webhook-endpoint <we_>` is the
  zero-side-effect proof; `stripe trigger` fans out to every endpoint of that mode, avoid it.

## Jobs, in priority order, each with its proof

1. **Hub webhook health, 10 minutes.** Yan opens the endpoint `stripe-hub-production`, Event
   deliveries: every delivery after 2026-09-09 16:40 must be 200. You read `pm2 logs stripe-hub
   --lines 100 --nostream` and the `webhook_logs` counts. If anything after that time is not 200:
   root cause from the hub log, fix, deploy via `STRIPE backend/deploy.sh` (dry-run is the default,
   snapshot + verify + rollback), prove by resending that event. Record the finding either way.
2. **One hub deploy that closes three items** (touches the live invoc.me path: Yan's GO in his words):
   the Active switch (`04736e9`), signed callbacks per the 09-11 evening recommendation
   (per-project secret, `X-Hub-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`,
   receivers verify in constant time, 5-minute replay window, the key in the URL kept during
   migration), and the callback forward moved out of the webhook response: answer Stripe first,
   then deliver from a `callback_deliveries` table (project, event, status, attempts, 5 s timeout,
   retries with backoff, a "Resend to app" button in the admin). Tests, build, dry-run, GO, deploy,
   then prove with one resend of the 09-10 invocme `customer.subscription.deleted` event
   (`evt_1UE5DDJARWpNRnC4g3DG7Vbb`, live, inside the 30-day window until 2026-10-10).
3. **admin-crowlr goes live.** Yan runs `bash scripts/deploy_backend.sh --really-deploy` in
   admin.CROWLR, then his four steps from the 09-11 addendum. Proof: one real checkout from a test
   company, the package row, the mail, then cancel and refund.
4. **ContextEngine on the hub.** Hub side here with Yan (section 4 steps 1 and 5 of the CE plan);
   code side in a ContextEngine chat (steps 2 to 4 and 7). Proof: step 6 of that plan, one CHF 2
   Pro purchase, cancel, refund.
5. **Invoc+ proof**, the steps of the 09-11 evening addendum, CHF 2, cancel and refund.
6. **app-crowlr and compr-app**: once Yan says what a payment unlocks, extend the admin.CROWLR
   receiver to the two slugs (one route, three projects, one key each).
7. **konive**: only on Yan's GO, pricing page plus a FastAPI receiver on the FC pattern.
8. **Deactivate `demand` and `crowlr`** in the hub admin (Yan's hands, after job 2 ships the switch).
9. **Crypto**: one small NOWPayments invoice end to end, Yan's hands, next week, before the 50 %
   crypto discount is advertised again.
10. **End state**: a fleet payments table in the hub session doc (project, sells?, receiver, proof
    date, remaining gap), SKILLS and session docs updated in each touched repo, CE learnings for
    the lessons, every commit pushed to origin and gdrive.

## Rails

- Secrets never in chat, docs or commits: `.copilot-credentials.md` per repo, then
  `bash ~/Projects/backup-credentials.sh`. Never print an env or ecosystem file; counts only.
- Agent-on-server policy: read-only ssh freely, one session per box, fail2ban budgets
  (`admin.CROWLR/docs/SSH_REMOTE_EXECUTION.md`); state changes only via committed deploy scripts or
  Yan's explicit GO; never write a credential on a server, prepare the exact line and Yan runs it.
- crowlr2 is multi-tenant: only the repo's deploy script, never rsync by hand, never `--delete`.
- Every verified fix gets its LOCK in the same commit. No long dashes anywhere. Talk short.
- Quote the cost before spawning any agent; most of this is one grep, one curl, one read-only query.

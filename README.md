# OVERRIDE

A 5×5 simultaneous-turn territory game with Practice, Quick Duel, friend rooms, and human Ranked matches. Product requirements live in [OVERRIDE_PRD_v0.3.docx](OVERRIDE_PRD_v0.3.docx); delivery decisions and acceptance gates are in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

The production architecture uses Cloudflare Workers and a SQLite-backed Durable Object. The Node server remains available for local development and tests. Staging uses a separate Worker and Durable Object namespace on the existing Workers Paid account; usage beyond included allowances may incur charges, and this setup does not guarantee zero spend.

## Local development

Use Node.js 24 or newer:

```powershell
npm ci
npm run dev:server
```

In another terminal, run `npm run dev` and open <http://localhost:5173>. Vite proxies API and WebSocket traffic to the server on port 8787. Practice, bot games, and guest friend rooms work without credentials.

For local Worker development, copy `.dev.vars.example` to `.dev.vars`, replace the local-only values, then run `npm run dev:worker`. The Node server uses the separate configuration in `.env.example`.

## Verify and build

```powershell
npm test
npm run build
```

CI also runs the production and full dependency audits, Linux Worker runtime smoke, and container backup/restore check. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for current evidence and open checks.

## Google sign-in

Enable Google in Firebase Authentication. Add each deployed host to Firebase Authorized domains and add its same-origin callback (`https://<workers-host>/__/auth/handler`) to the Google OAuth client's authorized redirect URIs. Preserve existing production entries when adding staging. Both Google buttons use Firebase redirect sign-in; Node and Worker verify Firebase ID tokens against public signing certificates and permit only the Google provider. No Firebase Admin service-account key is required. Real account sign-in still needs verification on supported desktop and mobile browsers.

## Cloudflare deployment

`wrangler.jsonc` builds the client, serves the SPA assets, and routes API and WebSocket requests to the Durable Object. The `staging` environment deploys as `override-game-staging`, uses its own `GAME` namespace, and reuses the Firebase project. The current staging URL, version, and smoke results are recorded in [STAGING_VERIFICATION.md](STAGING_VERIFICATION.md).

Deploy staging with `npx wrangler deploy --env staging`. Use separate secrets for each environment; staging uses `INVITATION_ENCRYPTION_KEY` and `RECOVERY_CONTROL_TOKEN`. For example:

```powershell
npx wrangler secret put INVITATION_ENCRYPTION_KEY --env staging
npx wrangler secret put RECOVERY_CONTROL_TOKEN --env staging
```

Keep Firebase on Spark. Workers Paid may bill usage beyond included allowances; budget alerts only notify, and the app's 80% request, compute, and SQL admission thresholds are estimates rather than account-level spending limits. Review [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), and [Cloudflare billing alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) before broad play. Do not deploy the Node server to a paid host or add paid services/domains.

## Metrics, backups, and recovery

```powershell
npm run report:metrics
npm run ops:status
npm run backup:db
```

Metrics summarize revealed rounds and finished matches; pending actions are never read. Guest matches, telemetry, and expired invitation tokens are removed after 30 days. Ranked matches and settlement records are retained for rating integrity. `ops:status` reports overdue deadlines, stuck ready shells, expired searches, unsettled matches, failed settlement retries, and duplicate settlement attempts. `/api/health` returns 503 when database checks fail or server work is overdue.

`backup:db` creates an integrity-checked SQLite backup beside `DB_PATH`. Restore to a new database path and use the same `INVITATION_ENCRYPTION_KEY` as the source. Preserve the source database and WAL files before a recovery. Back up persistent databases regularly; ephemeral storage loses sessions, matches, and ratings.

The Worker records SQL cursor reads/writes, including maintenance and `SELECT changes()`. Multi-statement `exec` exposes only its final cursor, and external dashboard or account traffic is outside the ledger. Safety multipliers remain, so usage accounting supports admission estimates rather than billing reconciliation. Existing matches, accepted invitations, queue leases, retries, and alarms continue when new allocations are paused.

Durable Object recovery uses the operator-only `POST /__ops/recovery/bookmark` and `POST /__ops/recovery/restore` endpoints with a unique `RECOVERY_CONTROL_TOKEN`. Restore accepts a bookmark or a timestamp from the preceding 30 days, returns an undo bookmark, temporarily gates player APIs, and restarts through an alarm. Rehearse only in the isolated staging namespace; SQLite point-in-time recovery is unavailable in Wrangler local development.

## Product boundaries

- Guest and bot games never affect Ranked ratings.
- Ranked requires two distinct Google accounts and public handles.
- Pending moves remain private until the fixed server deadline; the server resolves rounds and ratings.
- The global leaderboard combines players after two qualifying placement matches with shared practice bots. BOT tags identify bots, and all entries use the same RP order; bot practice does not change human records.

Before public launch, complete the staging checks, structured human playtest, device interruption checks, and mobile screen-reader review in the implementation plan.

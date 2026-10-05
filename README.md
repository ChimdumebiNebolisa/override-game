# OVERRIDE

A 5×5 simultaneous-turn territory game with Practice, Quick Duel, friend rooms, and human Ranked matches.

The product requirements are in [OVERRIDE_PRD_v0.3.docx](OVERRIDE_PRD_v0.3.docx). The [implementation plan](IMPLEMENTATION_PLAN.md) records approved product decisions and delivery gates. The production target is Cloudflare Workers with the Workers $5 monthly plan covered by the owner's student account. The app has a Worker entry point backed by one SQLite Durable Object; the Node server remains available for local development and tests.

## Run locally

Use Node.js 24 or newer.

```powershell
npm ci
npm run dev:server
```

In another terminal:

```powershell
npm run dev
```

Open <http://localhost:5173>. The Vite dev server proxies `/api` and WebSocket traffic to the authoritative service at port 8787. Practice, Quick Duel vs Bot, and guest friend rooms work without credentials.

For Ranked, configure Firebase Authentication with Google as an enabled provider and add the deployed origin to Firebase Authentication's authorized domains. The browser gets a Firebase ID token after Google sign-in; the server verifies its signature and claims and permits only the Google provider. The game continues to use its own opaque cookie session and SQLite profiles. The Worker verifies tokens against Firebase's public signing certificates and does not require a private Admin key. Deployed sign-in requires HTTPS.

## Verify and build

```powershell
npm test
npm run build
```

For local Worker development, copy `.dev.vars.example` to `.dev.vars`, set `INVITATION_ENCRYPTION_KEY`, then run `npm run dev:worker`. `FIREBASE_WEB_CONFIG` is stored in `wrangler.jsonc` so Git deployments keep the public web config in sync. Use `npm run dev:server` for the Node development server; it uses the separate Node configuration documented in `.env.example`.

Cloudflare Workers Builds can keep its build command blank: `wrangler.jsonc` configures Wrangler to run `npm run build` before `npx wrangler deploy`. Wrangler serves the SPA assets from `dist` and routes API and WebSocket requests to a SQLite-backed Durable Object. The Firebase web config is in `wrangler.jsonc`; set `INVITATION_ENCRYPTION_KEY` as a Worker secret before sending API traffic. Set the exact `workers.dev` hostname as an authorized Firebase Authentication domain before testing Google sign-in. Do not deploy the Node server to a paid host under the project's zero-spend constraint.

Use the Cloudflare Workers $5 monthly plan covered by the owner's student account. Stay within its included usage, and do not enable billable overages or add-ons. Keep Firebase on Spark. Cloudflare's Durable Object SQL storage and Workers have included quotas; overages can be billed. See [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), and [Firebase billing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans). Use a `workers.dev` origin so a custom domain is unnecessary.

Room and bot match creation requests include a UUID `creationKey`. The client reuses it after an uncertain response, and the server returns the original room or match.

## Metrics and operations

```powershell
npm run report:metrics
npm run ops:status
npm run backup:db
```

`report:metrics` prints aggregate funnel, gameplay, rematch, and side results as JSON. It reads revealed rounds and finished matches; it never reads pending actions. Guest matches, telemetry, and expired invitation tokens are removed after 30 days, while Ranked matches and settlement records remain for rating integrity. Transient Ranked settlement failures remain pending for retry; invalid settlement data voids the result after repeated failures without changing ratings. `ops:status` lists overdue deadlines, stuck ready shells, expired searches, unsettled Ranked matches, failed settlement retries, and duplicate settlement attempts. `/api/health` returns 503 if the database check fails or server work is overdue. Match transitions and settlements also produce JSON log lines keyed by match ID, without hidden moves or provider tokens.

`backup:db` creates a timestamped, integrity-checked SQLite backup in a `backups/` folder beside `DB_PATH` (by default, ignored `data/backups/`). Invitation tokens and codes are encrypted in the database; restore with the same `INVITATION_ENCRYPTION_KEY` used by the source database. To rehearse a restore, stop the server, copy a backup to a **new** database path, set `DB_PATH` to that path, run `npm run ops:status` and `npm run report:metrics`, then start the server against it. Use the same procedure for a real restore after preserving the old database and its WAL files. Back up the persistent database regularly; an ephemeral filesystem will lose sessions, matches, and Ranked ratings.

The Worker persists new-session rate limits in SQLite and caps bot match creation by session. App-level usage guardrails are conservative, but cannot guarantee that account-level Worker request charges never accrue under all traffic patterns. Confirm the student coverage and Cloudflare billing controls before a public launch. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for checks and remaining release gates.

## Product boundaries

- Guest games and bot games never affect Ranked ratings.
- Ranked requires two distinct Google accounts signed in through Firebase Authentication and a public handle.
- Pending moves stay private until the fixed server deadline; the server alone resolves rounds and settles ratings.
- The human leaderboard includes only players who completed five qualifying placement matches. Static Rivals are benchmark labels, not human ranks.

The current implementation still needs the structured human playtest and production staging gates described in the implementation plan before a public launch.

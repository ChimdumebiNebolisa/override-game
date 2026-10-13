# OVERRIDE

OVERRIDE is a 5×5 simultaneous-turn territory game. Play an untimed Practice game, a timed Quick Duel against a bot or friend, or a human Ranked match. Signed-in players with public handles can also earn RP in timed Hard Quick Duels.

[Play the game](https://override-game.cnebolisa.workers.dev/) · [Staging](https://override-game-staging.cnebolisa.workers.dev/)

The deployed app uses a Cloudflare Worker with a SQLite-backed Durable Object. The Node server is for local development, tests, and local database operations.

## Run locally

Use Node.js 24 or newer:

```powershell
npm ci
npm run dev:server
```

In another terminal, run `npm run dev` and open <http://localhost:5173>. Vite proxies API and WebSocket traffic to the Node server on port 8787. Guest games work without credentials. To test the Worker locally, copy `.dev.vars.example` to `.dev.vars`, replace its local-only values, and run `npm run dev:worker`. `.env.example` lists the separate Node configuration; the Node development script does not load that file automatically.

## Verify

```powershell
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

Run `npm run test:worker-runtime` on Linux. CI also runs dependency audits and a container backup/restore check in [`.github/workflows/verify.yml`](.github/workflows/verify.yml).

## Ratings and timing

New human matches have a shared ten-second decision window. They resolve when both players lock or the deadline passes, followed by a three-second reveal. Bot decisions resolve on an accepted Lock or a timed deadline, then wait in review for the human to choose Next. Default Practice is untimed; timed Practice and Quick bot games use ten seconds. Existing saved matches retain their stored timing policy.

Guest games, Practice, and Easy/Normal bots never affect RP. A signed-in player with a public handle can earn RP and complete both placement matches in a new timed Hard Quick Duel. The bot has a fixed **1000-RP opponent rating** for scoring; this is an initial benchmark, not a measured human Elo. Credit per account in a rolling 24 hours is 50% for the first three qualifying starts, 37.5% for the fourth, 25% for the fifth, then 0%. Voided games do not count. Credit is frozen at match creation. Reduced-credit bot games advance placements and rated-match count but do not change W-L-D or streak. A player cannot overlap a rated Hard duel with another rated game or Ranked matchmaking.

Bot controls remain tied to the browser session that started the game. If that session is lost, the owning account can resign its rated Hard duel from Ranked; the saved credit is used to settle the loss and release the rated-game lock. Settlement retries are idempotent.

## Authentication and deployment

Google sign-in uses Firebase Authentication. Enable Google in the Firebase project, add each deployed host to Firebase Authorized domains, and add `https://<workers-host>/__/auth/handler` to the Google OAuth client's authorized redirect URIs. Preserve existing production entries when adding staging. The Node and Worker runtimes verify Firebase ID tokens against public signing certificates; no Firebase Admin service-account key is needed.

`wrangler.jsonc` builds the client, serves static assets, and routes API and WebSocket traffic to the Durable Object. Staging has its own Worker and `GAME` namespace. Keep separate `INVITATION_ENCRYPTION_KEY` values for production and staging; staging recovery also requires `RECOVERY_CONTROL_TOKEN`. After the relevant checks pass, deploy staging with `npx wrangler deploy --env staging`, then deploy production from the reviewed `main` commit with `npm run deploy:worker`. Check `/api/health` and the served page in each environment. Follow [STAGING_VERIFICATION.md](STAGING_VERIFICATION.md) for cloud, account, recovery, and device checks.

Workers Paid usage beyond included allowances can incur charges; budget alerts and the app's admission estimates are not spending caps. The hosting decision is to keep Firebase on Spark; verify the current account plan before broader traffic. Do not use the local Node database as a Worker restore source.

## Local operations and recovery

`npm run report:metrics`, `npm run ops:status`, and `npm run backup:db` operate on the Node SQLite database selected by `DB_PATH`. The backup command creates a new integrity-checked file. Preserve the source database and WAL files during a local restore, and keep the same invitation-encryption key.

The Worker uses Cloudflare Durable Object point-in-time recovery through the operator-only `/__ops/recovery/bookmark` and `/__ops/recovery/restore` endpoints. Rehearse bookmark, restore, and undo only in the isolated staging namespace, as described in [STAGING_VERIFICATION.md](STAGING_VERIFICATION.md). Local Wrangler storage cannot verify cloud point-in-time recovery.

Human balance and comprehension evidence is collected with [PLAYTEST_PROTOCOL.md](PLAYTEST_PROTOCOL.md). Physical-device interruptions, mobile screen-reader behavior, and live Google/Ranked journeys require separate hands-on verification; automated checks do not establish those outcomes.

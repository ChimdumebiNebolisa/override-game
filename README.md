# OVERRIDE

A 5×5 simultaneous-turn territory game with Practice, Quick Duel, friend rooms, and human Ranked matches.

The product requirements are in [OVERRIDE_PRD_v0.3.docx](OVERRIDE_PRD_v0.3.docx). The [implementation plan](IMPLEMENTATION_PLAN.md) records the approved D1–D10 rule decisions and delivery gates.

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

For Ranked, set `GOOGLE_CLIENT_ID` to an OAuth web client ID authorized for the origin before starting the server. A Google identity token is verified against Google's signing keys, issuer, audience, and expiry on the server. The client does not send rating or game results. See [.env.example](.env.example) for the runtime variables. Google sign-in also needs HTTPS on a deployed public origin.

## Verify and build

```powershell
npm test
npm run build
npm start
```

`npm start` serves the built client and API from one process on `PORT`. The default SQLite file is `data/override.sqlite`; use a persistent disk in deployment. The server stores match deadlines, hidden actions, round results, queue ownership, and rating settlements in the database so a process restart can resume due work. Run a single server process against this SQLite file.

Room and bot match creation requests include a UUID `creationKey`. The client reuses it after an uncertain response, and the server returns the original room or match.

## Metrics and operations

```powershell
npm run report:metrics
npm run ops:status
npm run backup:db
```

`report:metrics` prints aggregate funnel, gameplay, rematch, and side results as JSON. It reads revealed rounds and finished matches; it never reads pending actions. Guest matches and telemetry are retained for 30 days, while Ranked matches and settlement records remain for rating integrity. `ops:status` lists overdue deadlines, stuck ready shells, expired searches, unsettled Ranked matches, failed settlement retries, and duplicate settlement attempts. `/api/health` returns 503 if the database check fails or server work is overdue. Match transitions and settlements also produce JSON log lines keyed by match ID, without hidden moves or provider tokens.

`backup:db` creates a timestamped, integrity-checked SQLite backup under ignored `data/backups/`. To rehearse a restore, stop the server, copy a backup to a **new** database path, set `DB_PATH` to that path, run `npm run ops:status` and `npm run report:metrics`, then start the server against it. Use the same procedure for a real restore after preserving the old database and its WAL files. Back up the persistent database regularly; an ephemeral filesystem will lose sessions, matches, and Ranked ratings.

The service caps new guest sessions by source address and bot match creation by session. Put the public service behind HTTPS and an edge rate limit as well. Set `PUBLIC_ORIGIN` to the exact public origin, configure Google OAuth for that origin, and keep credentials outside the repository. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for checks already run and release gates still open.

## Product boundaries

- Guest games and bot games never affect Ranked ratings.
- Ranked requires two distinct Google accounts and a public handle.
- Pending moves stay private until the fixed server deadline; the server alone resolves rounds and settles ratings.
- The human leaderboard includes only players who completed five qualifying placement matches. Static Rivals are benchmark labels, not human ranks.

The current implementation still needs the structured human playtest and production staging gates described in the implementation plan before a public launch.

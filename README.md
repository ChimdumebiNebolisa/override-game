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

## Product boundaries

- Guest games and bot games never affect Ranked ratings.
- Ranked requires two distinct Google accounts and a public handle.
- Pending moves stay private until the fixed server deadline; the server alone resolves rounds and settles ratings.
- The human leaderboard includes only players who completed five qualifying placement matches. Static Rivals are benchmark labels, not human ranks.

The current implementation still needs the structured human playtest and production staging gates described in the implementation plan before a public launch.

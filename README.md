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

For Ranked, configure Firebase Authentication with Google as an enabled provider and add the app origin to Firebase Authentication's authorized domains. Set `FIREBASE_WEB_CONFIG` to the Firebase web app config JSON and `FIREBASE_SERVICE_ACCOUNT_JSON` to a server-side Firebase Admin service account JSON. The browser gets a Firebase ID token after Google sign-in; the server verifies it with Firebase Admin and permits only the Google provider. The game continues to use its own opaque cookie session and SQLite profiles. Keep the service account private. See [.env.example](.env.example) for the runtime variables. Deployed sign-in requires HTTPS.

## Verify and build

```powershell
npm test
npm run build
```

For staging or production, set `PUBLIC_ORIGIN` to the actual HTTPS origin, the two Firebase variables described above, and a persistent `INVITATION_ENCRYPTION_KEY`, then run `npm start`. Production startup rejects missing required configuration. `npm start` serves the built client and API from one process on `PORT`. The default SQLite file is `data/override.sqlite`; use a persistent disk in deployment. The server stores match deadlines, hidden actions, round results, queue ownership, and rating settlements in the database so a process restart can resume due work. Run a single server process against this SQLite file.

The [Dockerfile](Dockerfile) packages that one-process server and built client. Mount a persistent writable disk at `/data`, configure `PUBLIC_ORIGIN`, Firebase web config, Firebase Admin credentials and a persistent `INVITATION_ENCRYPTION_KEY`, and run exactly one replica. The container uses `/data/override.sqlite`; its default backups go under `/data/backups/`. Put HTTPS termination and an edge rate limit in front of port 8787. `/api/health` is the container health check. Do not deploy without the persistent mount: a new container would lose sessions and Ranked ratings.

[`render.yaml`](render.yaml) provides a Render staging Blueprint for the Docker service, one persistent `/data` disk, one instance, health checks, and deployment after branch checks pass. Render supplies `PUBLIC_ORIGIN` from the service URL, generates a persistent invitation-encryption key, and prompts for Firebase web config and the server-side Firebase Admin service account. Keep the generated key stable and retain it with database backups; the server cannot decrypt invitation links or codes after key loss. Add the deployed origin to Firebase Authentication's authorized domains. Render persistent disks require a paid service, prevent multi-instance scaling, and cause a short interruption during deploys; see [Render disk limits](https://render.com/docs/disks). The Blueprint prepares the service but does not add the edge rate limit required before public launch.

Room and bot match creation requests include a UUID `creationKey`. The client reuses it after an uncertain response, and the server returns the original room or match.

## Metrics and operations

```powershell
npm run report:metrics
npm run ops:status
npm run backup:db
```

`report:metrics` prints aggregate funnel, gameplay, rematch, and side results as JSON. It reads revealed rounds and finished matches; it never reads pending actions. Guest matches, telemetry, and expired invitation tokens are removed after 30 days, while Ranked matches and settlement records remain for rating integrity. Transient Ranked settlement failures remain pending for retry; invalid settlement data voids the result after repeated failures without changing ratings. `ops:status` lists overdue deadlines, stuck ready shells, expired searches, unsettled Ranked matches, failed settlement retries, and duplicate settlement attempts. `/api/health` returns 503 if the database check fails or server work is overdue. Match transitions and settlements also produce JSON log lines keyed by match ID, without hidden moves or provider tokens.

`backup:db` creates a timestamped, integrity-checked SQLite backup in a `backups/` folder beside `DB_PATH` (by default, ignored `data/backups/`). Invitation tokens and codes are encrypted in the database; restore with the same `INVITATION_ENCRYPTION_KEY` used by the source database. To rehearse a restore, stop the server, copy a backup to a **new** database path, set `DB_PATH` to that path, run `npm run ops:status` and `npm run report:metrics`, then start the server against it. Use the same procedure for a real restore after preserving the old database and its WAL files. Back up the persistent database regularly; an ephemeral filesystem will lose sessions, matches, and Ranked ratings.

The service caps new guest sessions by source address and bot match creation by session. Put the public service behind HTTPS and an edge rate limit as well. Set `PUBLIC_ORIGIN` to the exact public origin, authorize it in Firebase Authentication, and keep the service account outside the repository. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for checks already run and release gates still open.

## Product boundaries

- Guest games and bot games never affect Ranked ratings.
- Ranked requires two distinct Google accounts signed in through Firebase Authentication and a public handle.
- Pending moves stay private until the fixed server deadline; the server alone resolves rounds and settles ratings.
- The human leaderboard includes only players who completed five qualifying placement matches. Static Rivals are benchmark labels, not human ranks.

The current implementation still needs the structured human playtest and production staging gates described in the implementation plan before a public launch.

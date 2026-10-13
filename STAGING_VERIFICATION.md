# Staging verification

Use the isolated [staging Worker](https://override-game-staging.cnebolisa.workers.dev/) for cloud and device checks. Record each run's commit, Worker version, date, accounts/devices, and results outside this evergreen procedure. A deployment or local test pass alone does not verify sign-in, live settlement, or Cloudflare recovery.

## Prepare and deploy

1. Confirm the intended commit passed CI. Run `npx wrangler whoami` and verify the account owns the `cnebolisa.workers.dev` subdomain. Inspect `wrangler.jsonc`: staging must use `override-game-staging`, its own `GAME` Durable Object namespace, and the matching `PUBLIC_ORIGIN`.
2. Confirm staging has its own `INVITATION_ENCRYPTION_KEY` and `RECOVERY_CONTROL_TOKEN`; never reuse production values. Use `npx wrangler secret list --env staging` to check names without displaying values. If a new secret is needed, set it with `npx wrangler secret put <NAME> --env staging`.
3. Deploy with `npx wrangler deploy --env staging`. Record the reported Worker version. Check `/`, `/api/health`, `/api/config`, the built asset URLs, and the bundled font. Health must return HTTP 200 with `{ "ok": true }`.
4. In Firebase Authentication, authorize the staging host and its same-origin Google callback, `https://override-game-staging.cnebolisa.workers.dev/__/auth/handler`. Keep production entries. Verify the browser returns to the staging app after sign-in.

Workers Paid usage beyond included allowances can incur charges. Budget alerts and in-app admission thresholds do not impose an account-level spending cap.

## Game and account checks

- In fresh guest sessions, finish Practice, Easy/Normal Quick, and Hard Quick games. None should change RP or placements. Verify a friend room from two browsers, reconnect, and rematch.
- With a signed-in account and public handle, start a timed Hard Quick Duel. Confirm the displayed credit and 1000-RP opponent rating match the server preview. Finish wins, losses or resignation, and a draw using isolated test accounts; check settlement once, placement progress, and that W-L-D and streak remain unchanged. Across sessions, confirm the rolling 24-hour 50% / 37.5% / 25% / 0% tiers, void exclusion, and the rated-game lock. From a second browser session on the same account, confirm account-authorized resignation releases an inaccessible rated duel without granting play controls.
- Use distinct accounts for human Ranked pairing, invitations, placements, rematches, and leaderboard order. Four accounts permit two pairs without confusing same-opponent credit limits. Verify the pre-ready credit notice, both player sides, one settlement per match, and the two-placement threshold.
- Check alarms, refresh, network interruption, and stale/retried requests. The result and rating ledger must converge without duplicate credit or revealing unrevealed actions.

Do not use production profiles or ratings as test fixtures. Keep test identities and tokens out of saved evidence.

## Restore and undo rehearsal

Run this only against the staging namespace and its `override-game-global` object, with no active players in the fixture. Local Wrangler storage cannot prove cloud point-in-time recovery.

1. Complete and settle a Ranked fixture. Record its rounds, result, settlement, and both profiles. Request an authenticated `POST /__ops/recovery/bookmark` using staging's `RECOVERY_CONTROL_TOKEN`; save the bookmark privately.
2. Complete and settle a second fixture. Record the same fields.
3. Call authenticated `POST /__ops/recovery/restore` with the first bookmark. Save the returned `undoBookmark`. Player APIs may briefly return 503 while the object restarts.
4. Wait for `/api/health` to return 200. The first fixture and profiles must match the first snapshot; the second fixture must be absent. `worker_recovery_control` must be empty. Repeated reads and settlement maintenance must not create another settlement.
5. Restore the undo bookmark. Both fixtures and profiles must match the second snapshot, with exactly one settlement per match and an empty recovery-control table. Confirm another bookmark request succeeds.

Use read-only SQL in Cloudflare Durable Objects Data Studio to inspect the **staging** object when needed. Do not export session cookies, provider tokens, invitation secrets, or personal account details. Keep production out of this procedure.

## Devices and human evidence

On two physical devices, test refresh and brief network loss during lock, deadline, reveal, review, and reconnect. On a mobile screen reader, check onboarding, action and target controls, Lock/Next feedback, result announcements, and Google sign-in return. Run [PLAYTEST_PROTOCOL.md](PLAYTEST_PROTOCOL.md) with real participants and record a go / tune / stop decision. These checks remain unverified until observations are recorded for the tested version.

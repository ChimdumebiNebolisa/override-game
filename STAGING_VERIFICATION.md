# OVERRIDE staging verification

Use this procedure after the nine fixes in `AUDIT_REPORT_2026-10-10.md` pass local verification. Record evidence in `IMPLEMENTATION_STATUS.md`. The original audit remains dated evidence.

## Prerequisites and deployment

1. Run `npx wrangler login`, then `npx wrangler whoami`. Confirm the account owns the `cnebolisa.workers.dev` subdomain. If it differs, correct staging's `PUBLIC_ORIGIN` before deploying.
2. Confirm the existing Workers **Paid** account in Cloudflare Billing and Firebase **Spark** in project `override-game`. The owner directed staging to use Workers Paid on 2026-10-10. Paid usage beyond included allowances can incur charges; budget notifications are not a spending cap. No subscription changes are part of this rehearsal.
3. Run `npm ci`, `npm test`, `npm run build`, `npm audit --omit=dev --audit-level=high`, and `npm audit --audit-level=high`. Run `npm run test:worker-runtime` on Linux and the container backup/restore check.
4. Dry-run both default and staging deployment into ignored scratch directories. Confirm staging binds `GAME` to its own `GameDurableObject` namespace. Its binding must not set `script_name` to the production Worker.
5. Use separate cryptographically random secrets of at least 32 bytes for staging's `INVITATION_ENCRYPTION_KEY` and `RECOVERY_CONTROL_TOKEN`. The current values are in ignored `.dev.vars.staging` and the deployed staging Worker; preserve them for the existing fixture. Generate fresh values only for a new isolated environment, and never reuse production secrets. Upload with `npx wrangler secret put <NAME> --env staging`.
6. Deploy only with `npx wrangler deploy --env staging`. Confirm the resulting hostname matches staging's `PUBLIC_ORIGIN`. Check `/`, `/api/health`, and `/api/config`.
7. Add the staging hostname to Firebase Authentication's Authorized domains and `https://<staging-host>/__/auth/handler` to the Google OAuth client's authorized redirect URIs. Preserve existing production entries. Both runtimes verify Firebase ID tokens against public signing certificates; no Admin private key is needed.

The configuration omits a custom CPU override and uses platform defaults for the selected Paid plan. Inspect actual staging errors and CPU metrics rather than treating a local build as evidence of runtime behavior. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [environment isolation](https://developers.cloudflare.com/durable-objects/reference/environments/).

## Identity, Ranked, and placement

1. On supported desktop and mobile browsers, sign in, reload, sign out, and sign in again. Test return to Profile, queue, and a challenge URL. Confirm both clients reach the same intended destination and can select a handle.
2. With two different real Google identities, create and redeem a challenge by link, then by code in a separate match. Verify queue pairing, both ready acknowledgments, a completed normal-timing match, one settlement, side-swapped rematch, and credit disclosure before readiness.
3. With four real identities A–D, play two completed, credited matches for each pair: AB, CD, AC, BD, AD, BC. Each player obtains six matches without exceeding two per pair. Check placement completes after two credited matches, public rank is absent before placement, and placed players appear in the shared global leaderboard alongside BOT-tagged practice bots. Keep scheduling these required tests separate from observations of voluntary rematches.
4. Record commit, browser/device, match IDs, credit, placement counts, profiles, and leaderboard observations using participant aliases. If accounts are unavailable, mark this gate unverified; synthetic profiles do not prove live sign-in.

## Restore and undo rehearsal

Use only the staging namespace and its `override-game-global` object. Keep active players out of the recovery fixture while recording snapshots.

1. Complete and settle the first Ranked match. Save its match ID, ordered actions/revealed rounds, settlement, and both profiles. Obtain a bookmark using authenticated `POST /__ops/recovery/bookmark` with staging's bearer recovery token.
2. Complete and settle a second rematch. Save the corresponding second snapshot and its side/credit details.
3. Request authenticated `POST /__ops/recovery/restore` with `{ "bookmark": "<first-bookmark>" }`. Save the 202 response and its `undoBookmark` in ignored local evidence before the reset. Player APIs temporarily return 503.
4. After reset, `/api/health` must return 200. The first match's rounds and settlement must match the first snapshot; the second match must be absent, and profiles must match the first snapshot. `worker_recovery_control` must be empty. Repeated reads and subsequent settlement maintenance must not change totals or create another settlement.
5. Restore the saved undo bookmark. After reset, both matches and profiles must match the second snapshot, each surviving match must have exactly one settlement, and the recovery-control table must remain empty. Perform another bookmark request to demonstrate recovery remains usable.
6. Inspect records with read-only SQL in Cloudflare [Durable Objects Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/). Select the **staging namespace**, then the object name above. Compare match, pending-action, round-result, rating-settlement, and intended public profile fields; do not export session cookies, provider tokens, encrypted invitation secrets, or personal account details.

Local mocked storage tests verify marker consumption, serialization, rejection paths, and restart ordering. Local workerd cannot prove actual PITR; only this cloud rehearsal closes that gate. Keep production out of this procedure. If staging needs a code rollback, redeploy the preceding staging build and preserve the recorded data/bookmarks.

## Runtime, devices, and human evidence

- Confirm staging game creation, rematches, alarms, reconnects, and settlement do not generate unexpected 500s or CPU-limit failures. Record representative cursor/ledger counts and platform metrics. App estimates retain safety multipliers and exclude external/account-wide work; they are not an account spend cap.
- On two physical devices, test refresh and brief network loss during lock, deadline, reveal, and grace. Both clients must converge on the same result without exposing hidden actions or extending fixed deadlines.
- On a mobile screen reader, check onboarding, board/action controls, lock feedback, reveal round/score announcements, result focus, and Ranked sign-in return. Save concrete observations and remaining issues.
- Run `PLAYTEST_PROTOCOL.md` with two competent pairs and one novice on a dedicated local Node database, so `npm run report:metrics` describes only those sessions. Use default timings, record voluntary rematches before prompting, and keep interruption tests separate. Record an evidence-based **go / tune / stop** decision; do not invent a numeric product threshold or tune balance without a separate decision.

## Evidence record

| Gate | Record |
| --- | --- |
| Tested commit and working-tree state | `b0b6d659a9ebb5eda645da985e8553621f195643`; clean working tree at deployment. The two-match placement update passed all 209 tests across 25 files and `npm run build`. |
| Workers Paid / Firebase Spark, date checked | 2026-10-10: Workers Paid selected for staging by owner; Firebase Spark confirmed. Wrangler login restored and whoami succeeded. |
| Staging Worker URL and namespace | Deployed `https://override-game-staging.cnebolisa.workers.dev`, version `f7e65226-b1d0-4792-bbd6-e5a4a27b09d2`; staging environment uses its own `GAME` Durable Object binding. |
| Staging secrets and smoke | Existing dedicated staging secrets retained. `/`, `/api/health`, `/api/config` returned 200; health was `ok: true`, config reported project `override-game` and staging auth domain. Served client asset contains the two-match placement copy and shared bot standings label. Firebase OAuth allowlists remain pending. |
| Local tests, audits, builds, dry-runs, Linux smoke, container | Windows/Linux: clean installs, 209 tests/25 files, builds passed. Both audits zero vulnerabilities; both dry-runs and Linux workerd smoke passed. Node backup/replay and the local container backup/restore job passed. Main CI passed after push. |
| Desktop/mobile identity and Ranked journey | Unverified in staging. |
| Four-account placement and leaderboard | Unverified; four real accounts required. |
| Restore and undo snapshots / healthy restart | Mock regressions passed; live PITR and Data Studio checks unverified. |
| CPU, SQL usage, and runtime errors | Local smoke ledger: 531 estimated reads / 354 estimated writes. Paid staging CPU and platform SQL metrics unverified. |
| Two-device interruption / mobile screen reader | Unverified; physical devices and human checks required. |
| Human playtest go / tune / stop | No human sessions or decision collected. Dedicated Node metrics command verified with a synthetic backup fixture. |
| Unverified checks and required access | Firebase Authorized domains and Google OAuth callback, real accounts/devices, and playtest participants. Secret values remain only in ignored local `.dev.vars.staging` and the staging Worker secret store. |

Missing external evidence remains unverified even when all local checks pass. Public rollout is a subsequent action.

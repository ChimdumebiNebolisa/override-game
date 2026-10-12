# OVERRIDE audit fixes — 2026-10-11

This implements the actionable findings in the engineering audit of `f839f550bdba8e82d38ceed453285547462c6dd1` and its product/visual extension. Game rules, Energy rewards, and manual bot-round acknowledgement remain unchanged.

| Finding | Repair | Verification |
|---|---|---|
| F01 — abandoned reviews block admission | Maintenance voids active bot matches whose owning session is expired or missing. Ended records follow the existing retention window and dependency ordering. Valid guest reviews and Ranked records are preserved. | Node retention regression; strict Worker adapter with 80 abandoned reviews, subsequent creation returns 201; repeated maintenance is idempotent. |
| F02 — guest ownership race | Establish one HttpOnly session before sending concurrent resume, telemetry, and creation requests. Failed initialization can retry. | Client API concurrency and failed-bootstrap tests; real guest play. |
| F03 — voided Rematch fails | Use the current authoritative snapshot when deciding whether a rematch can reference a finished parent. | Real local corruption/void fixture; Rematch creates a new untimed Practice match without a voided parent. |
| F04 — weak focus contrast | Use dark blue focus on light surfaces and white focus inside the dark demo. | Rendered keyboard focus measured 7.45:1 against the header; keyboard control regressions. |
| F05 — stale deployment documentation | Correct the README's deployed learning/pacing status and explain the actual retention policy. | Compared with the existing production rollout record and maintenance code. |
| PV01 — uncertain creation changes intent | Automatically retry the identical keyed creation once. If both responses are uncertain, freeze configuration and let Retry recover that same intent. Timer participates in the creation key's local intent identity. | Unit transport tests; real accepted-then-aborted responses followed by recovery of the same match. |
| PV02 — timed mobile scrolling | Put actions before the board and Lock immediately after selection; bound the shared board frame by available viewport height. Compact short-desktop controls. | 320×568 real Quick move: action, target, and Lock all at scroll position zero; desktop control visibility and keyboard checks. |
| PV03 — missing action explanations | Keep selected action guidance visible, show compact affordability/target reasons, and explain Ambush earnings beside Energy. Full rules remain expandable. | Browser checks confirm the Ambush explanation and successful commitment. |
| PV04 — inactive editor and buried handoff | Remove the action editor during review; group the learning completion message, Next round, and Start a duel inside the reveal panel. | Learning review/reload/completion checks; no Lock or action grid during review. |
| PV05 — inconsistent alignment | Size the board panel itself so labels and Energy use the same frame as the grid. | Rendered geometry and inspected desktop/mobile screenshots. |
| PV06 — broken friend divider | Place the divider elements on one row and the full-width Friend button on the next. | Browser geometry verifies button width and separation from the divider. |
| PV07 — footer overlap | Reserve sufficient bottom space, including the device safe area. | Last mode card clears the fixed bar by about 33 pixels at 320 and 390 widths. |

## Verification

- `npm test`: 308 tests passed across 31 files.
- `npm run build`: TypeScript and Vite passed.
- `npm run test:browser`: 33 checks passed (10 mocked transport/control fixtures and 23 real local entry/game/rules/recovery checks).
- Rendered matrix: 27 states across desktop, tablet, and mobile widths; no horizontal overflow or uncaught client errors. Targeted small-screen movement and footer checks passed after the final spacing corrections.
- Impeccable detector: existing accent-border and score-width-animation warnings remain; those incumbent styles were not rewritten as part of these fixes.
- `git diff --check`: passed.
- [Main CI run 38192055717](https://github.com/ChimdumebiNebolisa/override-game/actions/runs/38192055717): all three jobs passed on application commit `45e4cc2db2be24a998b427bbc699b240c6621485`, including Linux native Worker runtime, browser checks, dependency audits, and container backup/restore.

Raw screenshots, geometry, test fixtures, and logs remain local under `output/fixes-2026-10-11/`. The original audit reports are historical evidence, not a description of this repaired revision.

## Release

Application commit `45e4cc2db2be24a998b427bbc699b240c6621485` was pushed to `main` and deployed with `npm run deploy:worker` after CI passed. Cloudflare version `48c1629e-0969-4b46-a46c-f77239f010f5` receives 100% of production traffic at [the live game](https://override-game.cnebolisa.workers.dev/).

Production verification confirmed HTTP 200, healthy API status, matching HTML asset references, and byte-for-byte SHA-256 equality for the built files. Two real Chromium flows passed: 390-pixel learning with review persisted through reload and grouped completion choices; and 320×568 timed Quick with action, target, and Lock at scroll position zero, followed by stationary manual review. Both temporary guest matches were explicitly resigned, and active-match lookup returned null after cleanup. No uncaught browser errors occurred. The final release-record commit changes documentation only.

## Remaining limits

Real Google account sign-in, human comprehension/retention, and assistive-technology use were not newly verified. Untimed coaching and expanded help can still require ordinary scrolling. Native Linux workerd and container backup/restore are covered by the repository's CI jobs, not by the Windows local test run.

# OVERRIDE audit — current main

Historical baseline: remediation is recorded in [AUDIT_FIXES_2026-10-11.md](AUDIT_FIXES_2026-10-11.md).

**Conclusion:** Fix guest-session initialization and abandoned-review retention before expanding public traffic. The current build and normal play regressions pass, but isolated failure tests reproduced a persistent global admission block, guest match ownership loss, and a broken recovery action. Keyboard focus also has insufficient contrast. These are actionable defects, not evidence of a current production outage.

Audited on 2026-10-11, America/Chicago, at `main` revision `f839f550bdba8e82d38ceed453285547462c6dd1`. `main` matches the locally recorded `origin/main`; tracked files were unchanged. This was an audit-only assessment of the React client, shared rules, Node API, SQLite persistence, Cloudflare Worker/Durable Object adapter, release configuration, and documentation. Execution used disposable local fixtures. Production observation was restricted to public HTML, assets, and health.

## Verification

| Check | Observed result | Evidence / scope |
|---|---|---|
| `npm test` | Final independent run: **302 tests passed, 31 files**, exit 0 | `output/audit-main-2026-10-11/unit-recheck.log` |
| Initial unit run alongside build | **300 passed, 2 failed**, exit 1 | `unit.log`: one operations test exceeded 5 seconds; another child server missed its startup window. Timing contention is a hypothesis, not a proved diagnosis. |
| `npx vitest run server/ops.test.ts` | **2 passed**, exit 0, without source changes | `ops-recheck.log`; the subsequent full-suite run also passed. |
| `npm run build` | Type checking and Vite build passed, exit 0 | `build.log` |
| `npm audit --json` | **0 reported vulnerabilities**, exit 0 | `dependency-audit.json`; advisory snapshot, not a security certification. |
| `npm run test:browser` | **28 checks passed**, exit 0 | `browser.log`, `browser/browser-regressions.json`, `browser/learning-regressions.json` |
| `node --import tsx output/audit-main-2026-10-11/review-retention.mjs` | Admission defect reproduced; assertions passed, exit 0 | `review-retention.json`; real domain code and Worker adapter with isolated SQLite test storage. |
| `node --import tsx output/audit-main-2026-10-11/browser-probes.mjs` | Session race and voided Rematch defects reproduced; assertions passed, exit 0 | `browser-probes.json`, screenshots, redacted session-hash trace. |
| Same probe with `--focus-only` | Focus contrast measured **1.6558:1**, exit 0 | `focus-contrast.json`, `keyboard-focus-1440.png`; keyboard-driven Chromium focus and browser-resolved colors. |
| `node output/production-assets-check.mjs` | Public asset references and SHA-256 bytes match the fresh build; health 200 with `ok: true`, exit 0 | `production-assets.log`; [live game](https://override-game.cnebolisa.workers.dev/). This does not independently identify the deployed backend commit or verify authenticated production play. |
| Existing CI for the exact main SHA, queried during this audit | `verify`, `worker-runtime`, and `container` all succeeded | [GitHub run 38186849391](https://github.com/ChimdumebiNebolisa/override-game/actions/runs/38186849391), `ci.json`; Linux native Worker smoke and container backup/restore evidence, not new local executions. |

The browser suite combines ten mocked transport/control checks with eighteen isolated application checks. It covers welcome entry, keyboard focus trapping/restoration, learning, persisted review reload, lost accepted Lock/Next responses, optional storage failure, complete bot play, timed Practice/Quick, two human browser contexts, and terminal-round fixtures. Passing these cases did not cover the three failure paths below. One preliminary custom-probe run failed because the audit fixture's database encryption key did not match its child server; only the probe setup was corrected, then both cases passed their reproduction assertions.

## Ranked findings

| ID | Severity | Confidence | Finding | Fix priority / effort |
|---|---|---|---|---|
| F01 | High | Reproduced | Expired guests leave review games that permanently consume global admission reservations | P1 / Medium |
| F02 | Medium | Reproduced | Concurrent first-session responses can replace the cookie owning a newly created game | P1 / Small–Medium |
| F03 | Medium | Reproduced | Rematch after an open bot game is voided sends an invalid stale parent | P2 / Small |
| F04 | Medium | Reproduced | Amber keyboard focus outline fails contrast on the light background | P2 / Small |
| F05 | Low | Source-confirmed | README incorrectly says the deployed learning/pacing change is undeployed | P3 / Very small |

### F01 — abandoned review games permanently reserve new-game capacity

**Evidence:** `server/maintenance.ts:17` deletes only non-Ranked games already `finished` or `voided`; `server/maintenance.ts:31` deletes expired sessions without resolving their active games. `server/http.ts:103` rejects expired sessions. Non-Ranked ownership depends on that session identifier in `server/matches.ts:82`. `server/matches.ts:556` processes decision/transition/grace deadlines, excluding review. `server/worker.ts:464` counts every review as live work, and `server/worker.ts:485` reserves writes for those records. Requests share the `override-game-global` object (`server/worker.ts:147`).

**Reproduction:** The isolated probe created 80 untimed Practice games using actual creation and Lock resolution, each owned by a distinct guest session dated 45 days earlier. Pruning removed **80 sessions and zero games**; all 80 reviews remained, and deadline processing returned no work. After resetting the fixture's usage ledgers to zero, the real Worker handler rejected another bot game with **503**, while `/api/health` returned **200**. With the current constants, 81 allocations require 81,000 reserved writes against an 80,000 safety allowance. Resetting ledgers isolates the leak from actual usage; this number is an internal admission-model threshold, not a measured Cloudflare quota or bill.

**Impact / cause:** Normal visitors can close a review screen and eventually lose their expired guest identity. Those games have no owner capable of continuing or resigning them, no review timeout, and no cleanup path. Enough records block admission across visitors permanently under the current lifecycle. Calendar changes reset daily usage but do not remove these reservations. The health endpoint checks stalled scheduled work and settlement, so it does not expose this capacity condition.

**Fix:** Add bounded lifecycle cleanup for guest games whose owning session has expired or disappeared, and release their reservations. Preserve paused review for valid, resumable sessions. Handle dependent rows and rematch/restart ancestry transactionally; expose orphan counts/admission blockage in operations reporting. Align the retention statement in `README.md:56` with the implemented policy.

**Validation:** Advance a disposable clock beyond session expiry, run maintenance through Node and the Worker adapter, and confirm the orphan can no longer block new work. Also prove an unexpired review survives reload, genuine active games still reserve capacity, cleanup is idempotent, and Ranked records/settlements remain retained. Do not run cleanup experiments against production.

### F02 — delayed startup responses replace the owning guest session

**Evidence:** `src/client/App.tsx:1360` starts asynchronous resume without waiting before play becomes available; navigation and game creation send concurrent telemetry at `src/client/App.tsx:1403` and `src/client/App.tsx:1409`. Resume and telemetry both call `requireSession` (`server/api.ts:89`, `server/api.ts:83`). Every cookieless request creates a different identifier and sends `Set-Cookie` (`server/http.ts:108`, `server/http.ts:117`). Ownership checks correctly reject a different session (`server/matches.ts:92`); the defect is identity initialization.

**Reproduction:** An actual local Node server sat behind a fixture proxy that delayed delivery of cookieless resume responses by 1,500 ms and telemetry by 2,000 ms. A fresh Chromium visitor selected Quick Duel and Play Normal before those responses arrived. Creation succeeded with **201**. A late response then replaced the browser cookie; browser-originated GET and Lock requests for the just-created match returned **404**, resume returned no match, and the UI displayed “Match not found” with disabled play controls. The probe changed response timing only, not game rules or authorization. `session-race-trace.json` records short hashes, not raw tokens; `fresh-session-lost.png` shows the resulting state.

**Impact / cause:** A valid new guest can lose access to their own game under plausible network latency. Background requests compete to establish the same browser identity. This can also create the abandoned records implicated in F01. No account takeover was demonstrated.

**Fix:** Establish one stable guest session before session-dependent telemetry or mutations, and make concurrent callers await/reuse that initialization. Give initialization failure a recoverable UI path. Cover entry routes that skip ordinary resume, including invitation and authentication return paths.

**Validation:** Use separate fresh browser contexts with late resume and telemetry delivery. Confirm the created match remains readable, Lock succeeds, cookie identity remains stable, and reload resumes the match. Repeat for learning and human-room entry; include failed initialization without allowing competing creation requests.

### F03 — voided bot Rematch uses the initial parent state

**Evidence:** `Game.receiveSnapshot` updates its internal current state/status (`src/client/App.tsx:401`, `src/client/App.tsx:418`), and renders a result for a voided game (`src/client/App.tsx:551`). The parent's Rematch callback checks `botMatch.status` from the initial match stored in App (`src/client/App.tsx:1468`). `createBotMatch` accepts a parent only if it is `finished` (`server/matches.ts:190`).

**Reproduction:** Started a normal Quick bot game on the isolated server, then deliberately corrupted only that disposable game's stored state and made its deadline due. The server's real maintenance/recovery path voided it. At a 390 px viewport the client displayed “Match voided.” Clicking Rematch sent the voided game's ID as `parentMatchId`, received **404**, and displayed “Completed bot match not found.” Evidence: `browser-probes.json` and `voided-rematch-error-390.png`.

**Impact / cause:** Recovery reaches a safe terminal result, but its offered replay action fails because two components use different versions of the same match. Home/Start a duel provides a workaround. This is a client recovery defect, not a reason to weaken the backend's parent validation.

**Fix:** Base Rematch on the current authoritative snapshot, passing no parent for a voided game. Retain finished-match ancestry and side swapping.

**Validation:** Void a running game through the isolated recovery path, click Rematch, and assert a successful new game without the voided parent. Verify ordinary finished Rematch still swaps sides and remains idempotent.

### F04 — light-surface keyboard focus has insufficient contrast

**Evidence:** `src/client/styles.css:14` defines the amber color, and `src/client/styles.css:30` applies it as a 3 px outline with a 3 px offset to buttons and inputs. On the header's “How to play” button, actual keyboard navigation produced `:focus-visible`. Browser-resolved outline RGB was **239,184,63**, against light background **242,245,249**, yielding **1.6558:1**. The screenshot visually confirms an external amber outline. Evidence: `focus-contrast.json`, `keyboard-focus-1440.png`.

**Impact / cause:** Keyboard users with low vision can have difficulty locating focus. An external authored focus indicator must contrast at least 3:1 against its adjacent background under [WCAG 2.2 SC 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). A dark button interior does not establish contrast for an outline separated from the button by a light gap.

**Fix:** Use a sufficiently contrasting focus color on light surfaces, or a contrasting two-color treatment that also works on the dark demo/game surfaces. Changing focus styling does not require changing the amber action/energy palette.

**Validation:** Measure representative focused controls against their actual adjacent backgrounds and inspect keyboard navigation on light and dark surfaces, including dialogs and the board. Require at least 3:1. This finding is specific to authored focus contrast; it is not a complete accessibility or WCAG assessment.

### F05 — current deployment instructions contradict the live build

**Evidence:** `README.md:37` says the learning/pacing change “has not been deployed.” The current release verification document records deployment, and the fresh read-only production check found every built browser asset byte-identical to current main's build, including `index-CdL0ZJ2F.js` and `index-BAIMicxe.css`.

**Impact / cause:** A developer following the README can incorrectly treat this release as pending or unnecessarily repeat deployment. The release record and general README were updated inconsistently.

**Fix / validation:** Update the current status and link the dated canonical release evidence. Keep historical records clearly dated. Check README, implementation status, and release verification for agreement with the intended deployed revision. No deployment is needed merely to correct this documentation.

## Foundations and cross-cutting causes

The rules are centralized and tested, and resolution, persistence, idempotent creation/continuation, and Ranked settlement have useful automated coverage. Sampled API routes enforce origin checks and participant ownership; opaque guest bearer tokens are represented by keyed identifiers in storage. Invitation secrets are encrypted, pending actions are excluded from public snapshots, and storage uses bound SQL parameters. Current dependency checks report no advisories. Exact-main CI adds native Linux Worker and container evidence beyond SQLite test doubles.

The remaining failures cluster around **lifecycle ownership** and **state synchronization**. Review persistence is intentional but lacks an end-of-life policy for lost guests. Session initialization is treated as several independent background operations. Game snapshots update inside the game while a parent callback retains creation-time state. The existing suite has strong normal and retry coverage but lacks session-establishment races, guest expiry while paused, and void-to-replay integration.

The independent failure pass asked what happens when a guest's identity expires, legitimate first responses arrive out of order, and storage recovery changes a match after the screen opens. Those probes produced F01–F03.

## Coverage and product observations

| Domain | Coverage | Evidence / limits |
|---|---|---|
| Rules, bot progression, API lifecycle, persistence | Investigated | Source traces, 302-test recheck, real isolated play, expiry/race/corruption probes; sampled code, not every possible state. |
| Authentication, authorization, privacy | Partially investigated | JWT validation, ownership, origin/body bounds, cookie and invitation handling inspected; local tests. No real Google account or authenticated production Ranked journey. |
| UI, learning, accessibility, product fit | Partially investigated | Chromium normal/error states, keyboard and emulated touch, screenshots at 1440/720/390/320 widths, measured focus contrast. No assistive-technology session or human comprehension study. |
| Tests, repository, documentation | Investigated | Main/remote state, workflows, manifests, lockfile, key docs, suites and fresh adversarial probes. Initial operations timing failures preserved in evidence. |
| Dependencies and supply chain | Partially investigated | Lockfile/advisory audit, pinned CI actions, runtime/container configuration inspected; no complete transitive-code, license, or provenance review. |
| Delivery, recovery, observability | Partially investigated | Exact-main CI, adapter/alarms/recovery source, health and production assets. No real Cloudflare PITR rehearsal or production backend commit attestation. |
| Performance, capacity, account cost | Partially investigated | Global admission/reservation model reproduced locally; bundle sizes/build observed. No load test, Cloudflare account/usage measurement, or billing verification. |
| AI/model integration | Not applicable | Bots use local game logic; no model-service integration found in the audited application path. |

The untimed learning path has a coherent choose → Lock → review → Next round sequence. Review reload and lost accepted responses passed, while readable revealed action/territory/Energy details remained available at 320 px. Ownership uses labels and shapes as well as color. The 390 px voided-result screenshot shows that the recovery error is readable, but its central replay control is broken. These are observed interaction/layout qualities; beginner comprehension and real-device usability remain unmeasured.

The suite's 720×450 “zoom” case is **viewport-equivalent reflow**, not actual 200% browser zoom. Screenshots and keyboard checks do not establish a screen-reader pass. A focused manual accessibility session should verify: welcome dialog announcement/trapping/restoration; board coordinate and owner names with legal target feedback; selected action and Lock status; one comprehensible reveal announcement; Next round returning to a usable focus position; and void/error/result recovery. Repeat at actual 200% zoom and on a physical mobile device with a screen reader.

## Fix order and exit gates

1. **F01:** release reservations when guest review ownership is irrecoverable; prove expiry cleanup and valid-session review preservation in both storage paths. Existing production orphan counts and data handling require a separately reviewed operational plan.
2. **F02:** serialize stable session establishment; add the delayed-first-response browser regression before enabling broad guest traffic. This reduces another source of orphaned work but does not clean existing records.
3. **F03/F04:** repair current-snapshot Rematch and focus contrast; exercise voided/finished replay and keyboard paths.
4. **F05:** reconcile current deployment documentation.
5. Before making a broad authenticated/Ranked readiness claim, complete real Google redirect return and two-account play/settlement, isolated Cloudflare PITR, real-device interruption, human learning playtests, and assistive-technology/actual-zoom checks.

## Limits and audit-induced changes

No source, dependency, configuration, branch, CI, or deployment changes were made. Created this report and evidence/probe files under `output/audit-main-2026-10-11/`; preserved pre-existing untracked `output/` content. Build/check commands regenerated local ignored artifacts. Disposable fixture databases and child servers were cleaned up. No production game creation, data cleanup, recovery call, intrusive scan, or account-setting mutation was performed.

The installed Mitch skill contains its main instructions and UX synthesis reference, but the referenced core/security/supply-chain/repository/frontend/operations/adversarial/report-format files are absent. This report follows the available instructions and direct evidence, with coverage disclosed above; the missing supplemental checklists were not treated as completed.

Production backend state, orphan counts, actual plan/quota enforcement, Google OAuth client settings, and real recovery readiness remain uncertain. This audit does not prove a current outage or unauthorized disclosure. Fixes and regression tests are proposed here and have not been applied.

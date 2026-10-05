# OVERRIDE repository audit — 2026-10-05

**Audited commit:** `53454b7` (`origin/main` and the local `codex/full-product` checkout). This is an audit and planning record; no game code was changed. The two untracked items, `.wrangler-dry-run/` and `firebase-debug.log`, were not inspected or modified.

## Executive conclusion

OVERRIDE is a deployed prototype with a substantial, tested game and Ranked service. The strongest foundation is one deterministic rules implementation shared by solo and server matches, with transactional seat claims and Ranked settlement. It is not yet release-verified: a player reported that Google sign-in fails, real two-account Ranked play has not been demonstrated, and the deployed Durable Object has no rehearsed export or restore path. The original greenfield plan remains useful as the product contract, but its delivery status must be read as historical.

The next work should prove the deployed player journeys and data recovery before balance polish or new features. The [current remediation plan](IMPLEMENTATION_PLAN.md#16-current-remediation-plan--2026-10-05) supersedes earlier status language.

## Verified current state

- The public [GitHub repository](https://github.com/ChimdumebiNebolisa/override-game) lists `main`; local `HEAD`, `origin/main`, and `origin/codex/full-product` are at `53454b7` when inspected. The local checkout has only the two pre-existing untracked items noted above.
- `npm test`: 177 passing tests in 23 files. `npm run build`: TypeScript and Vite pass. `npm audit --omit=dev --audit-level=high`: zero reported vulnerabilities. `npx wrangler deploy --dry-run`: passes and packages five static assets. These checks exercise the repository, not a real Google account or a deployed Durable Object restore.
- Read-only live checks of `https://override-game.cnebolisa.workers.dev/`, `/api/health`, and `/api/config` returned HTTP 200. Health returned `{"ok":true}`; config included a Firebase project ID. The home page returned CSP and HSTS headers. These checks do not prove that sign-in, match completion, or rating settlement works live.
- A clean `npm ci` in this Windows checkout failed while unlinking a locked Rolldown native binary (`EPERM`). An attempted ordinary install then failed rebuilding `better-sqlite3` because the local Node header cache lacked `common.gypi`. `npm install --ignore-scripts --no-save` restored usable local dependencies; the test suite and build passed again. This is a local reproducibility limitation, not evidence that CI installation fails.

## Ranked findings

### High — Deployed Ranked sign-in is unverified after a player failure

**Status:** Strongly supported user report; root cause unverified. **Category:** Correctness / release.

**Evidence:** In the referenced “Create implementation plan” chat, the player reported sign-in failure and a Firebase `auth/internal-error`; the last response explicitly said a completed sign-in was not confirmed. The client uses `signInWithPopup` in `src/client/firebase-auth.ts:4-7`. The Ranked entry catches and displays the generic SDK message in `src/client/App.tsx:985-999`; the profile entry has different diagnostic handling at `src/client/App.tsx:1137-1152`. `/api/config` returning Firebase config only confirms that public configuration is served.

**Impact:** The PRD's competitive journey cannot be accepted while a player cannot authenticate. **Root cause:** Unknown until the popup/return step is reproduced in a supported browser with a real account. **Recommended fix:** Capture the SDK error code and underlying browser/network details at the deployed origin, verify authorized-domain/provider settings, then repair the observed failure. Run both entry points through account binding, handle creation, and Ranked return intent. **Validation:** Two distinct real accounts complete a deployed Ranked challenge, ready/bind, result, settlement, rematch, and leaderboard update on desktop and mobile. **Effort:** Medium, dependent on diagnosis. **Priority:** Immediate.

### High — Live Ranked state has no rehearsed recovery path

**Status:** Verified repository gap; deployed account recovery options unverified. **Category:** Reliability / operations.

**Evidence:** `server/backup.ts:1-25` backs up the local `DB_PATH` through `better-sqlite3`; the Docker restore workflow in `.github/workflows/verify.yml` tests that Node database. The deployed source of truth is the singleton SQLite Durable Object in `server/worker.ts:105-139`. No Worker export, bookmark-based restore command, or deployed recovery rehearsal exists in the repository. [Cloudflare documents a 30-day SQLite Durable Object point-in-time recovery API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), but the app has not exercised it.

**Impact:** A bad migration or data corruption affecting live ratings, sessions, and matches has no demonstrated recovery procedure. **Root cause:** The backup gate was validated for the former Node host and not carried through the Worker port. **Recommended fix:** Design a bounded, authenticated recovery procedure for the actual Durable Object, preserve the invitation key with recovery materials, and rehearse it against a disposable object with a settled Ranked fixture. Decide whether independent exports are needed beyond the provider's 30-day recovery window. **Validation:** Recover a dedicated Worker fixture and verify replay, profile totals, and exactly-once settlement without touching production data. **Effort:** Medium. **Priority:** Immediate before broad public play.

### High — The usage pause can strand active matches and cannot enforce zero overage

**Status:** Verified code behavior; account billing settings unverified. **Category:** Reliability / operations.

**Evidence:** `server/worker.ts:165-169` returns 503 after its application budget is consumed. `server/worker.ts:213-218` then defers alarms to next month, including match deadlines and settlement retries. The outer Worker sends static assets directly to `ASSETS` at `server/worker.ts:105-110`, and paused API requests still enter the Durable Object, query usage, and write usage at `server/worker.ts:353-371`. These counters are estimates rather than Cloudflare account meters. [Cloudflare's Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) describes billable paid-plan overages and free-plan operations that fail at the daily limit.

**Impact:** If the guard trips during play, users can be left without a result or rating until a later month; it also does not establish the approved no-out-of-pocket constraint. **Root cause:** One application-level budget controls both optional traffic and required game completion. **Recommended fix:** Exercise the cap boundary with an active match; keep already accepted deadlines and settlement recoverable, and reject new work before it consumes the reserve. Verify account-level billing controls and student coverage, or use the Workers Free fallback already recorded in D12 if a hard no-overage guarantee is required. **Validation:** At each cap boundary, new games stop, an existing match resolves or receives a clear safe outcome, and account-level charges are constrained by the selected plan. **Effort:** Medium. **Priority:** Immediate before broad public play.

### Medium — Worker-specific regression coverage is much narrower than Node coverage

**Status:** Verified. **Category:** Testing / deployment.

**Evidence:** `server/worker.test.ts` has two mocked-storage cases for API routing/session/room creation and reopening with session data. `.github/workflows/verify.yml` runs unit tests, Vite build, and a Node/Docker backup rehearsal; it has no deployed Worker journey. The referenced chat records successive live Worker failures involving SQLite pragmas, alarm SQL, and reopening after session data, despite local tests passing.

**Impact:** Adapter and platform differences can break the live game while CI remains green. **Root cause:** The production runtime became the Worker, but the release gate still mostly tests the Node server and a local storage mock. **Recommended fix:** Add a focused Worker runtime smoke gate for sessions, match deadline/restart, WebSocket presence, Ranked settlement, and migration using a disposable object; keep the existing Node tests. **Validation:** The gate fails for the documented Worker regressions and passes against the release candidate. **Effort:** Medium. **Priority:** Next.

### Medium — Worker requests are fully buffered before the 16 KiB JSON limit

**Status:** Verified. **Category:** Abuse resistance / performance.

**Evidence:** `server/worker.ts:63-76` calls `request.arrayBuffer()` and materializes the entire body. The downstream 16 KiB limit in `server/http.ts:45-52` runs afterward.

**Impact:** An oversized body can consume Worker memory and CPU before receiving 413. **Root cause:** The Node stream adapter does not preserve the server's early size limit. **Recommended fix:** Reject a too-large `Content-Length` and enforce a streaming byte limit before allocation, retaining the same 413 contract. **Validation:** An oversized request is rejected without reading its full body; a valid 16 KiB request still succeeds. **Effort:** Small. **Priority:** Next.

### Medium — Current release documentation contradicts the deployed state

**Status:** Verified. **Category:** Documentation / product.

**Evidence:** `IMPLEMENTATION_PLAN.md:5` still calls the repository greenfield; its dated `:217` note and `IMPLEMENTATION_STATUS.md:9,74-75` describe live deployment and authorized origin as future tasks. Read-only live checks confirm a deployed Worker, and the referenced chat records its deployment and player sign-in failure. The status document cites 169, 170, and 173 tests in different historical paragraphs, versus 177 now.

**Impact:** A maintainer may repeat completed setup steps or mistake a healthy API for release readiness. **Root cause:** Dated implementation evidence was appended without a current-state summary. **Recommended fix:** Keep past evidence dated; put the current live state and open gates at the top of the plan/status. **Validation:** A reader can distinguish deployed, locally verified, player-reported failure, and unverified release checks. **Effort:** Small. **Priority:** Next. This audit updates the plan and status summary.

### Low — Fresh checkout lacks the documented Worker development example

**Status:** Verified. **Category:** Build / documentation.

**Evidence:** `README.md:33` directs contributors to copy `.dev.vars.example`. The file exists only locally; `git check-ignore -v .dev.vars.example` matches `.gitignore:9` (`.dev.vars.*`), and `git ls-files .dev.vars.example` returns nothing.

**Impact:** A fresh checkout cannot follow the documented `dev:worker` setup. **Root cause:** The example is covered by the secret-file ignore glob. **Recommended fix:** Track only the placeholder example with an ignore exception or change the README to show the example contents. **Validation:** `git ls-files .dev.vars.example` lists the file in a fresh checkout. **Effort:** Small. **Priority:** Next.

## Cross-cutting causes and adversarial pass

The remaining risk is concentrated at the deployed boundary: the Worker and Firebase browser flow, live data recovery, and usage policy. The deterministic rules, server ownership checks, encrypted invitation storage, private pending actions, and transactional Ranked settlement are useful foundations; passing local tests do not verify their live integration.

The security and privacy review found no confirmed exploitable issue in the inspected authorization and settlement paths. The app limits public profile fields, keeps pending moves server-side, checks unsafe request origins, and stores invitation secrets encrypted. Dependency scanning covered production packages only; it is not a security proof. Accessibility has automated and browser keyboard evidence in `IMPLEMENTATION_STATUS.md`, but no human screen-reader verdict. The single global Durable Object is a reasonable prototype boundary; load and latency capacity have not been measured. The repository is public but has no `LICENSE`, so it should not be presented as licensed open source unless the owner chooses a license.

The adversarial pass found a distinct failure chain: a large anonymous body reaches full Worker buffering before rejection; repeated calls continue reaching the usage ledger after the application pause; once the pause is triggered, the same guard defers already owed match deadlines. These behaviors should be tested together with a real cap-boundary fixture. No remote exploit or actual overage was demonstrated.

No broad rewrite, microservice split, or dependency upgrade is justified by this evidence. The local Node server, Docker workflow, and old milestone text remain useful development or historical material. The ignored Wrangler dry-run directory and Firebase debug log are local artifacts to review separately; this audit makes no deletion recommendation without checking their contents or whether another process uses them.

## Proposed issue order

| Order | Issue | Acceptance gate | Dependency |
| --- | --- | --- | --- |
| 1 | Diagnose deployed Google sign-in | Two real accounts bind and finish the competitive journey | Authorized test accounts and browser diagnostics |
| 2 | Rehearse Durable Object recovery | Disposable Worker fixture restores replay and exactly-once settlement | Scoped recovery method and preserved key |
| 3 | Make quota behavior safe for active play | Boundary test preserves an accepted game's outcome and confirms billing policy | Usage policy / D12 fallback |
| 4 | Add production-runtime smoke gate | Worker restart, deadline, socket, migration, and settlement path passes | Disposable Worker environment |
| 5 | Bound request buffering | Oversize body returns 413 before full allocation | None |
| 6 | Restore documentation accuracy | Current state and historical evidence are visibly distinct; example setup works | None |
| 7 | Run human playtest and accessibility review | Dated go/tune/stop record and desktop/mobile screen-reader evidence | Stable deployed journeys |

## Scope and limitations

The audit read the PRD, plan, status, code, tests, CI, config, and public repository page. It traced the rules, guest, Ranked, Worker, auth, and recovery boundaries and ran the commands listed above. It did not authenticate to Firebase, inspect Cloudflare billing/settings or production storage, perform a human playtest or screen-reader pass, run `wrangler dev` on this Windows host, or mutate live game data. The sign-in root cause, account spending controls, production restore capability, and real two-device behavior remain unverified.

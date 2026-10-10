# OVERRIDE comprehensive audit — 2026-10-10

Audited commit: **e3c306fa22ee6c71df7bedecf4af7add238b7198**, local and remote main. Repository: [ChimdumebiNebolisa/override-game](https://github.com/ChimdumebiNebolisa/override-game). This is a new snapshot; the older AUDIT_REPORT.md is preserved.

Scope: product, rules, authentication and authorization, APIs, state and concurrency, persistence and migrations, Worker/Node adapters, dependencies, tests, UI/accessibility, performance, operations, deployment, documentation, repository hygiene, and release readiness. No application source, tests, configuration, lockfile, or remote settings were changed. Reproduction fixtures used disposable local databases.

Evidence labels distinguish **Verified**, **Strongly supported**, and **Requires external access**. A demonstrated local failure is not automatically a demonstrated failure on the currently deployed version.

## 1. Executive conclusion

**This is a substantial prototype with a sound game engine, but it is not ready for a public production launch.** The decisive defect is a mismatch between the production Worker SQLite adapter and its test double. All 185 tests pass, yet real workerd returns HTTP 500 when creating a friend room. The current commit's Linux CI fails at the same operation. A diagnostic runtime run identifies the unsupported binding call directly.

The strongest foundation is the authoritative, deterministic rules engine and transactional domain services. Input validation, ownership checks, hidden-action projection, fixed human deadlines, idempotent match creation, exactly-once Ranked settlement, replay preservation, and recovery-oriented tests receive meaningful coverage. A local backup/replay check also passed.

The highest operational risk is unrehearsed Cloudflare restore/undo combined with a persistent recovery marker that can restore the application into an unavailable state. The zero-out-of-pocket requirement also depends on account settings and complete admission controls; application estimates cannot establish it alone.

Readiness:

| Use | Assessment |
| --- | --- |
| Local prototype and engineering demonstration | Useful, with the Worker failure and external gates disclosed. |
| Public production launch | Blocked by F01 and outstanding authentication, recovery, billing, and human validation gates. |
| Portfolio presentation | Suitable as a prototype; claims of verified production Ranked play or successful Worker CI would be unsupported. |
| Open-source release | The GitHub repository is public but has no detected license. Choose intended licensing and contribution expectations before representing it as a maintained open-source project. |

## 2. Verified current state

| Check | Observed result |
| --- | --- |
| Repository | Public, main at e3c306f; main is not protected. No open issues or pull requests returned. |
| Windows installation | Initial npm ci failed against an incomplete existing Node header cache. Re-running with a disposable npm_config_devdir succeeded. This is an observed environment issue, not evidence that the lockfile is broken. |
| Clean Linux installation | Node 24.14.1 under Ubuntu/WSL installed the archived commit with npm ci successfully. |
| Tests | **185 passing tests in 24 files**, re-run after the successful Windows installation. |
| Type check / production client build | npm run build passed; it runs tsc --noEmit and Vite. Main JS bundle: 381.28 kB, 114.53 kB gzip. |
| Worker packaging | Wrangler deployment dry-run passed. This checks packaging, not domain operations. No deployment was performed. |
| Real Worker runtime | **Failed**: session creation works, POST /api/rooms returns 500. Diagnostic workerd output: “Wrong number of parameter bindings for SQL query,” at worker-sqlite.ts:59 and rooms.ts:90. |
| Current-commit CI | verify and container jobs passed; worker-runtime failed at room creation. [Run 37357226366](https://github.com/ChimdumebiNebolisa/override-game/actions/runs/37357226366). |
| Local Node/browser | Home, Practice start, legal target selection, lock, simultaneous reveal, next decision, timeout/forfeit, and resignation-dialog cancellation were exercised. A disposable fixture used a 60-second decision window for deliberate UI inspection; this does not validate usability at the normal five-second window. |
| Responsive/accessibility spot checks | At a 390 × 844 viewport, measured board and timer bounds fit. Ownership symbols, coordinates, legal-target labels, Energy labels, result scores, and focus styling exist. Escape closed the resignation dialog and returned focus to Leave match. Screen-reader usability remains untested. |
| Local backup and operations | A settled Ranked fixture survived SQLite backup and replay verification without another rating change. Operations output showed no overdue decisions or unsettled Ranked records in that fixture; duplicate settlement replay was recorded as expected. Metrics export completed. |
| Dependency audit | Production-only audit reported zero vulnerabilities. Full audit reported one high advisory propagated through three development packages; see F07. |
| Deployed endpoint spot check | Read-only GET /, /api/health, and /api/config returned 200 at [the deployed origin](https://override-game.cnebolisa.workers.dev/). Health returned ok. Deployment SHA, real sign-in, and complete live gameplay were not established. |

Architecture: one React/Vite application; shared rules/rating/bot modules; synchronous SQLite domain services; a Node development/container transport; a Cloudflare Worker with one globally named SQLite Durable Object, alarms, and hibernating WebSockets. Firebase supplies Google identity; game data stays in SQLite. Bots use public state and previously revealed actions. There are no LLM calls, retrieval pipelines, or paid AI integrations to audit.

The singleton Durable Object is a reasonable prototype tradeoff. It concentrates availability and throughput, so load and recovery evidence matter before scaling. There is no demonstrated need for a rewrite, microservices, or a new database.

## 3. Top findings

### F01 — High: Worker room creation fails because named bindings are passed through as positional values

**Status:** Verified. **Category:** Correctness / Testing / Deployment.<br>
**Evidence:** [server/worker-sqlite.ts:59](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/worker-sqlite.ts:59>) forwards bindings directly to sql.exec. [server/rooms.ts:89](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/rooms.ts:89>) uses a multi-parameter named INSERT with .run(row). The same pattern appears in [server/invitations.ts:124](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/invitations.ts:124>), [server/invitations.ts:279](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/invitations.ts:279>), and [server/quick-rematch.ts:146](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/quick-rematch.ts:146>). [server/worker-test-storage.ts:6](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/worker-test-storage.ts:6>) delegates to better-sqlite3, which accepts the object and hides this incompatibility.

The unchanged commit failed its real Linux runtime smoke locally and in CI. With informational logging and a brief diagnostic log-flush delay, workerd reported the binding-count error from the room INSERT. A strict positional-binding probe independently rejected the object and wrote zero rooms. See [.tmp-storage/audit-2026-10-10/worker-runtime-diagnostic.log](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/.tmp-storage/audit-2026-10-10/worker-runtime-diagnostic.log>) and [.tmp-storage/audit-2026-10-10/reproduce-results.json](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/.tmp-storage/audit-2026-10-10/reproduce-results.json>). Cloudflare specifies positional values for SQL execution. [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

**Impact:** Friend-room creation is a broken primary workflow on this commit's Worker. Ranked challenge/rematch and Quick rematch INSERTs have the same incompatible pattern; those downstream runtime journeys were not reached by the failing smoke.<br>
**Root cause:** A cast to the better-sqlite3 interface conceals an incomplete compatibility contract, while the mock implements the more permissive Node behavior.<br>
**Recommended fix:** Use explicit positional placeholders and values at the affected domain INSERTs, or implement and narrowly verify the required named-binding behavior in the adapter. Prefer the smallest consistent repair. Make test storage reject unsupported parameter shapes.<br>
**Validation:** Run the existing real Worker smoke to completion, then exercise Ranked challenge/rematch and Quick rematch creation in workerd. Keep Node domain tests passing.<br>
**Effort:** Small–Medium. **Priority:** Immediate.

### F02 — High: Undo recovery can restore the persistent “recovery pending” marker

**Status:** Strongly supported; startup from the problematic snapshot is verified, real PITR is untested. **Category:** Reliability / Operations.<br>
**Evidence:** [server/worker.ts:541](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/worker.ts:541>) schedules restore, then inserts worker_recovery_control. [server/worker.ts:247](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/worker.ts:247>) returns 503 for player APIs while that row exists; [server/worker.ts:295](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/worker.ts:295>) aborts on the alarm without clearing it. Another restore is rejected while pending at [server/worker.ts:525](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/worker.ts:525>).

Cloudflare describes the returned undo bookmark as the point immediately before the actual restore. That point includes the marker written after scheduling. Local PITR is unsupported. [SQLite recovery API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/). A modeled restart with that row present returned health 503, invoked abort again, and retained the row. See the recovery-undo-snapshot-model result in [.tmp-storage/audit-2026-10-10/reproduce-results.json](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/.tmp-storage/audit-2026-10-10/reproduce-results.json>).

**Impact:** Undoing a recovery can leave the singleton object rejecting player APIs and unable to accept another restore through the normal endpoint. This is an operator-triggered recovery risk, not a demonstrated public attack or a verified live outage.<br>
**Root cause:** One-shot restart intent is stored inside the database snapshot being restored, with no consumption or stale-intent handling.<br>
**Recommended fix:** Make restore intent one-shot and ensure undo cannot reinstate an active gate. Verify the durability and restart ordering of any marker deletion; do not rely solely on constructor mocks. Keep the operation bounded to a disposable staging object.<br>
**Validation:** Bookmark, change a settled Ranked fixture, restore, then undo on Cloudflare. Verify APIs recover after both restarts, the marker clears appropriately, replay/profile totals agree, and settlement remains exactly once.<br>
**Effort:** Medium. **Priority:** Immediate before relying on recovery or launching broadly.

### F03 — Medium: Invite-link Quick rematches bypass new-game admission

**Status:** Verified. **Category:** Reliability / Operations.<br>
**Evidence:** [server/api.ts:278](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/api.ts:278>) accepts /api/quick/rematches/accept without requireNewGameAdmission; [server/api.ts:290](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/api.ts:290>) checks admission on the match-scoped acceptance route. The link route is used by the client. With allowNewGame returning false, the same valid offer returned **503** on the guarded route and **200 with a new match** on the link route. See quota-rematch-link in [.tmp-storage/audit-2026-10-10/reproduce-results.json](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/.tmp-storage/audit-2026-10-10/reproduce-results.json>).

**Impact:** New matches can consume reserved capacity after the safety pause, weakening the promise to preserve headroom for accepted games. This does not demonstrate a charge or a breach of an account-level limit.<br>
**Root cause:** Admission policy is enforced on selected HTTP branches rather than every operation that allocates a match.<br>
**Recommended fix:** Apply the existing admission check to this acceptance path and inventory room/match/queue/invitation allocation paths for the same policy. Distinguish a new allocation from an idempotent return of an existing resource.<br>
**Validation:** At the cap boundary, both acceptance routes reject new allocations consistently; already accepted moves, settlement, and eligible idempotent responses continue.<br>
**Effort:** Small. **Priority:** Next, before zero-spend launch validation.

### F04 — Medium: Worker SQL read accounting drops reads made by write statements

**Status:** Verified adapter behavior; production undercount magnitude is unmeasured. **Category:** Operations / Performance.<br>
**Evidence:** [server/worker-sqlite.ts:59](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/worker-sqlite.ts:59>) records cursor.rowsWritten but ignores cursor.rowsRead for run. It counts only one read for SELECT changes. Generic exec/pragma calls also bypass the counters. [server/worker.ts:468](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/worker.ts:468>) feeds these counters into usage ledgers used for admission.

A controlled cursor reporting 100 reads and 10 writes yielded usage of **1 read and 10 writes**, rather than 101 reads including SELECT changes. See [.tmp-storage/audit-2026-10-10/usage-and-rank-results.json](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/.tmp-storage/audit-2026-10-10/usage-and-rank-results.json>). Write-side predicate scans and maintenance can therefore disappear from the estimate.

**Impact:** The SQL reservation guard can admit work using understated measurements. Existing multipliers/headroom may absorb some error, but they do not prove that omitted reads are covered.<br>
**Root cause:** Instrumentation does not account for every cursor operation; test storage reports result-row counts rather than actual scanned-row costs.<br>
**Recommended fix:** Account for reads and writes across the adapter operations used in steady-state traffic and maintenance. Keep conservative reserves and explain differences from platform meters.<br>
**Validation:** Adapter tests must cover write statements with nonzero reads; compare representative real-runtime cursor usage with the resulting ledger, including maintenance.<br>
**Effort:** Small–Medium. **Priority:** Next.

### F05 — Medium: A socket in another room suppresses the current match's disconnect

**Status:** Verified with actual Worker closure logic and simulated socket attachments. **Category:** Correctness / Reliability.<br>
**Evidence:** [server/worker.ts:382](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/worker.ts:382>) treats equal matchId values as a live match connection even when both are null. Room-channel attachments use null match IDs, so another room with the same participant key satisfies this branch.

The reproduction joined a friend match, opened another room for the same session, closed the first room socket, and ran its due closure. The closure row was consumed, but the participant remained marked connected. See worker-cross-room-presence in [.tmp-storage/audit-2026-10-10/reproduce-results.json](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/.tmp-storage/audit-2026-10-10/reproduce-results.json>).

**Impact:** An ordinary multi-room session can be treated as present in a game it left, bypassing the intended disconnect/grace handling and moving toward timeout/AFK outcomes instead.<br>
**Root cause:** Nullable identifiers are compared before confirming that they identify a particular match or room.<br>
**Recommended fix:** Require a non-null matching match ID, or the same non-null room ID, for the same participant. Retain support for multiple legitimate sockets to the same game.<br>
**Validation:** Cover unrelated room sockets, same-room replacement sockets, match-channel sockets, and closure debounce in Worker tests; confirm disconnect/grace transitions.<br>
**Effort:** Small. **Priority:** Next.

### F06 — Medium: Practice restart retention can fail and roll back all cleanup

**Status:** Verified. **Category:** Persistence / Reliability.<br>
**Evidence:** [server/maintenance.ts:15](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/maintenance.ts:15>) excludes incoming parent_match_id references but ignores restart_match_id references declared at [server/schema.ts:60](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/schema.ts:60>). A replacement Practice match points to the original through restart_match_id, set by [server/matches.ts:183](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/matches.ts:183>).

Create a Practice game, restart it, finish the replacement, and put the original's end just before the 30-day cutoff and the replacement's end just after it. Cleanup tries to delete the original, raises **FOREIGN KEY constraint failed**, and rolls back the telemetry deletion in the same transaction. Two matches and the old telemetry row remained. See practice-retention in [.tmp-storage/audit-2026-10-10/reproduce-results.json](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/.tmp-storage/audit-2026-10-10/reproduce-results.json>).

**Impact:** Retention fails at this boundary. Node startup calls cleanup before listening at [server/index.ts:23](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/index.ts:23>), so startup also fails when it hits this data shape. This is an edge case; the probe does not establish permanent failure for every restart chain.<br>
**Root cause:** The cleanup leaf definition is incomplete for the match reference graph.<br>
**Recommended fix:** Respect both incoming reference types when selecting deletable matches. Preserve non-expired replacements and Ranked audit records.<br>
**Validation:** Test cutoff-straddling restart chains, all-expired chains, mixed rematch/restart chains, repeated cleanup, and Ranked preservation.<br>
**Effort:** Small. **Priority:** Next.

### F07 — Medium: A high-severity advisory remains in the development toolchain

**Status:** Verified locked dependency/advisory match; exploitation in this project is not demonstrated. **Category:** Dependency Security.<br>
**Evidence:** Full npm audit reports sharp 0.35.4 via Miniflare/Wrangler. Its three high package entries represent **one advisory chain**, not three independent vulnerabilities. Production-only audit is clean. The [upstream advisory GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) describes a librsvg issue affecting specified glibc Linux conditions and identifies sharp 0.35.5 as patched.

**Impact:** Development/CI tooling has an affected dependency. No inspected player-upload-to-SVG processing path establishes remote exploitation through the deployed game, so an application Critical rating would be unsupported.<br>
**Root cause:** The pinned transitive toolchain is affected; CI's production-only audit does not inspect it.<br>
**Recommended fix:** Select the smallest compatible Wrangler/Miniflare update that brings a patched sharp. Avoid a blanket dependency upgrade or an unverified override.<br>
**Validation:** Confirm the resolved version and full audit outcome; rerun build, tests, dry-run, and real Worker smoke.<br>
**Effort:** Small. **Priority:** Next.

### F08 — Medium: Current-state documentation still asserts superseded runtime and authentication behavior

**Status:** Verified. **Category:** Documentation / Operations.<br>
**Evidence:** [IMPLEMENTATION_STATUS.md:7](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/IMPLEMENTATION_STATUS.md:7>) identifies HEAD as 53454b7, while main is e3c306f and its new Worker job has run and failed. [DECISION_LOG.md:16](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/DECISION_LOG.md:16>) and [IMPLEMENTATION_STATUS.md:44](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/IMPLEMENTATION_STATUS.md:44>) describe Node Firebase Admin/service-account verification, but current [server/auth.ts:1](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/auth.ts:1>) uses JOSE/public certificates in both runtimes. [IMPLEMENTATION_STATUS.md:87](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/IMPLEMENTATION_STATUS.md:87>) claims a session nonce challenge and wrong-nonce tests; current auth/client code has no such challenge path. Migration columns remain, and [IMPLEMENTATION_PLAN.md:97](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/IMPLEMENTATION_PLAN.md:97>) still asks for wrong-nonce rejection.

**Impact:** Maintainers can follow obsolete credential instructions or believe an authentication control and release check exist when they do not. This is a documentation defect; absence of an old custom nonce is not, by itself, proof of a Firebase authentication exploit.<br>
**Root cause:** Historical implementation notes, intended work, and verified current state are mixed without consistently marking superseded entries.<br>
**Recommended fix:** Refresh the dated current-state summary against the commit/CI; amend the provider decision to public-certificate verification; clearly mark the old custom nonce design as superseded or resolve the intended requirement. Remove unused CI service-account placeholders after confirming they serve no current path.<br>
**Validation:** Compare documented settings and auth contracts with config tests, token tests, client flow, and a real sign-in rehearsal.<br>
**Effort:** Small. **Priority:** Next.

### F09 — Low: Nonterminal round reveals display the next round's number

**Status:** Verified in browser and code. **Category:** UX / Correctness.<br>
**Evidence:** After locking the first Expand, the reveal says “Round 2 resolved.” [src/client/App.tsx:651](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/src/client/App.tsx:651>) displays result.state.round, but [src/shared/rules.ts:207](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/src/shared/rules.ts:207>) increments it to represent the next decision; terminal results retain the resolved round at line 222. The markup tests construct a result directly instead of checking a real resolver result.

**Impact:** Players and assistive announcements receive the wrong round identifier during ordinary reveals.<br>
**Root cause:** The presentation treats next-state metadata as the resolved round.<br>
**Recommended fix:** Derive the actual resolved round using the existing result semantics, or persist that identifier explicitly only if needed elsewhere.<br>
**Validation:** Render actual resolver results for the first, intermediate, standard terminal, and sudden-death terminal rounds.<br>
**Effort:** Small. **Priority:** Next.

Browser evidence below shows the first move's 5–5 result labeled Round 2. Its deliberately extended timer is a local inspection fixture.

![First-round reveal incorrectly labeled Round 2](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/.tmp-storage/audit-2026-10-10/browser-evidence.png>)

## 4. Cross-cutting root causes

1. **Runtime contract drift:** The domain code uses a Node SQLite contract; the Worker adapter and permissive mock accept that shape in TypeScript without enforcing Cloudflare behavior. Previous Worker-specific history and the new runtime failure show why bundling and mock tests are insufficient.
2. **Incomplete boundary cases:** Nullable socket IDs, a second match-reference edge, alternate rematch endpoints, and restoration of control rows are individually small omissions with consequential effects.
3. **State versus intent:** Round state describes the next round, while a recovery row describes a restart request. Both are reused as if their interpretation survived a transition unchanged.
4. **Verification records drift:** Historical progress is useful, but a green unit-test statement must be paired with the actual target-runtime result and dated account-dependent gates.

Incremental repair is sufficient. Preserve the pure rules layer and transactional domain services; strengthen their real-runtime boundaries without unrelated restructuring.

## 5. Independent adversarial pass

After tracing normal workflows, probes deliberately varied the assumptions around them:

| Probe | Outcome / implication |
| --- | --- |
| Substitute strict platform bindings for the permissive mock | Rejected named-object INSERT; real workerd reproduced the error (F01). |
| Restore the snapshot immediately preceding recovery | Persistent gate produced 503 and another abort; genuine restore/undo still requires Cloudflare (F02). |
| Accept the same offer through both HTTP entry points at the cap | Guarded path 503; link path allocated a match (F03). |
| Give a write statement substantial cursor reads | Meter discarded those reads (F04). |
| Keep another room socket open after leaving a match | Incorrectly suppressed disconnect (F05). |
| Straddle retention cutoff with a Practice restart | Foreign-key failure rolled back cleanup (F06). |
| Replay settlement after backup | Ratings and replay remained stable; exactly-once behavior held in the local fixture. |
| Treat a public Firebase web API key as a secret | Rejected this false positive: it is intended client configuration, not an Admin credential. |
| Infer mobile overflow from one full-page screenshot | Rejected this false positive after viewport capture and DOM bounds showed fit. |

Other reviewed defenses include mutation Origin/header checks, bounded streamed JSON, participant authorization for match/socket access, guest-session limits, invite token hashing/encryption, JWT signature/algorithm/project/provider checks, transactional queue ownership and handle uniqueness, and private pending-action projection. This audit found no demonstrated authentication bypass, SQL injection, XSS, or opponent pending-action exposure. That statement does not certify the application secure.

The absence of secret/private-token values in ordinary projections and logs is useful. A complete historical secret scan, account-permission review, and live penetration test were not performed.

## 6. Redundant and obsolete material

- **Firebase Admin CI placeholders and obsolete instructions:** Current code verifies certificates without a private service account. Consolidate this documentation and remove the unused placeholders after a focused dependency check; do not remove actual Firebase configuration.
- **Old custom-nonce schema fields and requirements:** No current path uses the fields. Mark the design's status first. A destructive schema migration merely to remove nullable fields is unnecessary for this audit's remediation.
- **Historical audits/status entries:** Preserve them as dated history; publish one concise current snapshot and stop presenting old results as current gates. The older audit's claims that recovery endpoints do not exist and that the cap blocks all player traffic are superseded by this commit.
- **Generated local artifacts:** Pre-existing .wrangler-dry-run/ and firebase-debug.log are untracked and not ignored. Give scratch outputs a consistent ignored location and avoid committing logs. Audit probes and databases already live under ignored .tmp-storage/.
- **Node container versus Worker:** Both currently reduce distinct risks: Node exercises local domain behavior and backup, while Worker is the deployment target. They are not redundant enough to delete either. Node backup must not be presented as proof of Durable Object recovery.
- **Tests:** Retain rules, domain, and transport layers. Repair the overly permissive storage double and add missing boundary regressions; overlap alone is not a reason to remove tests.
- **Infrastructure/features:** No evidence justifies archiving the project, migrating storage, adding a queue service, or replacing the bots with an LLM. Defer new Ranked/social infrastructure until primary workflow failures and the PRD's human fun/rematch gate are resolved.

## 7. Prioritized remediation plan

### Immediate blockers

1. Repair F01 and pass the existing Linux runtime smoke plus all affected invitation/rematch operations.
2. Make restore/undo one-shot, then rehearse it on a disposable Cloudflare object (F02).
3. Establish real Google sign-in and two-account Ranked completion, and verify the current zero-spend account plan before a public launch.

### High-value quick fixes

Apply F03, F04, F05, and F06 with narrow regressions. Correct the round label (F09), update the affected development toolchain (F07), and refresh current-state documentation (F08).

### Core structural work

Enforce the SQLite adapter's actual supported contract and keep a real workerd check required for releases. Main is currently unprotected; require the relevant CI jobs for merges/deployment if this repository is used for releases. Avoid widening the adapter or splitting the architecture without an observed need.

Measure the singleton's practical capacity. [server/progression.ts:26](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/server/progression.ts:26>) fetches and sorts every placed profile for a profile rank or leaderboard response. [src/client/App.tsx:724](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/src/client/App.tsx:724>) repeatedly requests settlement plus profile/rematch/queue once per second even after settlement. A synthetic 10,000-player fixture showed a full scan and temporary ORDER BY tree; profile plus leaderboard took about 45 ms on local Node. This establishes query shape, not a Worker load limit. If measured use warrants it, stop polling immutable settled fields and use bounded/indexed rank queries while preserving tied-rank behavior.

### Quality improvements

Complete mobile screen-reader and real-device interruption checks. Record performance and operational diagnostics against the actual Worker, including migration/restart and failure logs. The smoke's error-only logging can lose useful console output before shutdown; retain safe diagnostic context on failures.

Run the structured human playtest in [PLAYTEST_PROTOCOL.md](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/PLAYTEST_PROTOCOL.md>) and PRD sections 40–41. Record comprehension, voluntary rematches, action mix, side results, and a go/tune/stop decision. Synthetic traffic and bot outcomes cannot substitute for that evidence.

### Optional polish

Decide repository licensing and contributor/security reporting expectations if public collaboration is intended. Improve documentation navigation and scratch-output hygiene. No broad visual redesign is needed to address the verified defects.

## 8. Proposed issue backlog

These are proposals in this report; no remote issues were created. Order reflects launch impact, not severity alone.

| Order | Issue / priority | Rationale and bounded scope | Acceptance criteria | Dependencies |
| --- | --- | --- | --- | --- |
| 1 | Worker SQL binding compatibility — Immediate | Repair F01's affected INSERTs and enforce the mock contract. | Existing Linux smoke passes; real Worker creates friend rooms, Ranked challenges/rematches, and Quick rematches; Node tests remain green. | None. |
| 2 | Restore and undo cannot resurrect pending intent — Immediate | Repair F02 without changing production data. | Disposable Cloudflare restore and undo both return to healthy APIs; control intent consumed; replay/profile/settlement invariants hold. | Disposable staging access; item 1 for full game fixture. |
| 3 | Admission covers every new-match path — Next | Close F03's link path; inventory alternate entry points and idempotent returns. | Cap stops new allocations consistently and preserves accepted work. | Item 1 for Worker rematch fixtures. |
| 4 | Accurate adapter cursor accounting — Next | Record reads/writes for used statement types and compare ledger usage. | Nonzero reads on writes appear in usage; representative real-runtime accounting is documented. | None. |
| 5 | Worker presence respects room/match identity — Next | Repair F05 nullable identity comparison. | Unrelated-room socket does not suppress disconnect; same-game replacement socket does; grace outcomes remain correct. | Item 1 for real room smoke. |
| 6 | Retention respects restart dependencies — Next | Repair F06 and preserve unexpired replacements. | Cutoff-straddling and all-expired chains prune safely; repeat cleanup succeeds; Ranked records retained. | None. |
| 7 | Patch the affected development toolchain — Next | Resolve F07 with minimum compatible dependency change. | Patched sharp resolves; audit result recorded; tests/build/dry-run/runtime smoke pass. | Reverify item 1 after update. |
| 8 | Correct reveal round semantics — Next | Repair F09 presentation using real resolver results. | First/intermediate and terminal/sudden-death labels identify the round actually resolved. | None. |
| 9 | Refresh current verification and auth documentation — Next | Resolve F08 and clearly separate history from current evidence. | SHA, CI, credentials, nonce design, and external gates agree with current code and checks. | Update again after fixes and external rehearsals. |
| 10 | Prove identity and zero-spend release gates — Immediate before launch | Verify OAuth redirect, two-account Ranked completion, Workers Free/current billing, Firebase Spark, and actual platform limits/configuration. | Supported desktop/mobile sign-in and full Ranked journey; account-plan evidence; cap checks against that plan; no assumption that notifications cap charges. | Owner/account access; items 1, 3, 4. |
| 11 | Human, interruption, and assistive-technology validation — Before launch | Run existing playtest protocol and real-device checks. | Written go/tune/stop evidence; two-device recovery behavior; mobile screen-reader observations and fixes. | Working staging build and real identities for Ranked coverage. |
| 12 | Measure ranking/polling capacity — Later, earlier if load warrants | Quantify scan/poll costs before choosing query/poll changes. | Worker row costs and latency measured; bounded queries preserve rank ties; settled fields stop unnecessary polling if justified. | Items 1, 4. |

## 9. Commands and checks performed

| Command or check | Result |
| --- | --- |
| git status --short; git rev-parse HEAD; git log; git ls-remote origin | Established main/remote SHA and preserved pre-existing untracked artifacts. |
| npm ci | Initial Windows native install failed due to incomplete existing node-gyp headers. |
| npm_config_devdir set to disposable audit cache, then npm ci | Succeeded; lockfile unchanged. No global cache/settings repair performed. |
| npm test | 185/185 tests, 24 files, passed after installation. |
| npm run build | TypeScript and Vite passed. |
| npm audit --json | One high advisory chain in sharp/Miniflare/Wrangler. |
| npm audit --omit=dev --audit-level=high | Zero reported vulnerabilities. |
| npx wrangler deploy --dry-run --outdir .tmp-storage/audit-2026-10-10/worker-bundle | Passed; no deployment. |
| npm run test:worker-runtime on Windows | Explicit Linux-only guard prevented execution. Direct local Windows workerd startup also crashed before serving; this did not prove an app defect. |
| Clean archived HEAD in Ubuntu/WSL, official Node 24.14.1, npm ci, npm run test:worker-runtime | Installation passed; real Worker smoke failed with room creation 500. |
| Diagnostic copy of smoke with informational logs and a one-second failure log-flush delay | Same app failure; exposed binding-count error and source stack. App code in the archived checkout was unchanged. |
| node --import tsx .tmp-storage/audit-2026-10-10/reproduce.mjs | Five isolated probes verified named-binding mismatch, retention rollback, admission bypass, cross-room presence, and startup gating from a modeled undo snapshot. |
| node --import tsx .tmp-storage/audit-2026-10-10/usage-and-rank.mjs | Verified write-read counter omission; measured synthetic 10,000-profile query shape. |
| Disposable DB: backup-fixture.ts; backup.ts; verify-backup.ts; ops.ts; report.ts | Backup integrity/replay/settlement check passed; operations and metrics JSON generated. |
| Local Node server on port 8791 and browser interaction | Practice workflow and accessibility spot checks described above; no real-account login. |
| gh run list/view; gh issue list; gh pr list; gh api repo/main | Read-only CI/repository evidence; current Worker job failed, no open issues/PRs, public repo/no license, unprotected main. |
| GET deployed /, /api/health, /api/config | All 200; only anonymous read-only endpoints exercised. |
| PRD DOCX XML extraction plus documentation/schema/config/workflow review | Compared implemented flows, historical claims, and remaining validation gates. |
| git diff --check | Passed before report creation; final report/source-change check recorded at completion. |

Local evidence artifacts are ignored scratch files under [.tmp-storage/audit-2026-10-10/reproduce.mjs](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/.tmp-storage/audit-2026-10-10/reproduce.mjs>). They contain audit-only credentials and synthetic records, not production database exports. They are available in this workspace but will not accompany a clone unless deliberately packaged later.

## 10. Limitations

- The deployed version was not correlated to this SHA. Its healthy anonymous endpoints do not prove room creation, authentication, or Ranked completion works.
- No real Google accounts were used. Firebase/Google provider settings, OAuth callback configuration, redirect privacy behavior, and two-account Ranked settlement remain unverified end to end. The documented historical auth error is not asserted to still occur today. See [Firebase redirect guidance](https://firebase.google.com/docs/auth/web/redirect-best-practices).
- No Cloudflare account or Firebase billing settings were changed or independently rechecked. Repository notes report a prior Workers Paid account and informational alerts. Confirm the current plan before using the zero-spend claim; see [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
- Actual Durable Object PITR is unavailable locally. F02 combines the official undo semantics, source inspection, and a snapshot-state model; only a disposable Cloudflare rehearsal can complete its platform validation.
- Docker's local daemon was unavailable. The current-commit remote container job passed; local Node backup/replay was independently verified.
- Browser work used one local session and synthetic timing. No two-physical-device network disruption, full normal-timing human match, structured human study, screen-reader session, or cross-browser Google redirect was completed.
- Ranking timing came from synthetic local Node data. No production-scale load test or actual platform billing-meter reconciliation was run.
- Dependency licensing/attribution was not exhaustively reviewed, and repository license absence was checked rather than resolved. There is no configured standalone lint/format script; TypeScript/build checks are the available static gate.
- No complete Git-history secret scan, production-data review, provider IAM audit, or full external penetration test was performed.

The audit's source-backed findings are concrete and incrementally repairable. Public-launch evidence should follow the fixes and external rehearsals, with the human playtest deciding whether further product scope is worthwhile.

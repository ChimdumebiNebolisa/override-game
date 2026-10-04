# OVERRIDE implementation plan

**Source:** `OVERRIDE_PRD_v0.3.docx` (frozen prototype PRD, supplied 2026-10-04)

**Planning baseline:** greenfield repository; no existing application or infrastructure

**Goal:** deliver the PRD's solo, guest friend, and human Ranked journeys while proving the game loop before investing in competitive infrastructure.

This is a delivery plan, not a change to the PRD. Statements labeled **Recommendation** are implementation choices. Items labeled **Decision needed** are unresolved product rules; decide them before the affected milestone. Prototype balance values are deliberately measurable and adjustable under PRD §54.

## 1. Delivery strategy and gates

Build in vertical slices. Each slice must produce a usable path and pass its narrow gate before dependent work starts. Keep a single deterministic rules implementation and use it in local, bot, and server-hosted matches. Do not build the full Ranked system into the first playable prototype (§52).

| Milestone | Deliverable | Gate to continue | PRD basis |
| --- | --- | --- | --- |
| M0 — rule contract | Executable rules examples, decisions below resolved for the prototype, repository skeleton | Every listed action pair has an agreed outcome; sample games replay deterministically | §§4–10, 45, 54 |
| M1 — core prototype | Local two-person pass-and-play and simple bot; complete match, result, immediate restart, lightweight metrics | Deterministic resolver tests pass; two informed humans can finish and explain matches; playtest decision recorded | §§4–11, 40–42, 52–53 |
| M2 — guest human multiplayer | Create/join friend room on two devices, secure invite, synchronized fixed-deadline rounds, basic recovery | Quick Duel acceptance tests pass on desktop and mobile with network interruption | §§22, 26, 28–29, 32, 44 |
| M3 — solo quality | Practice coaching, tutorial, Easy/Normal/Hard bots, unranked bot duel | A new visitor can play alone without creator explanation; bots use public information only | §§3, 11, 37, 50 |
| M4 — Ranked integrity | Google sign-in, handle, challenge, queue, ready handshake, placement, Elo, anti-farming, reconnect/forfeit, exactly-once settlement | Ranked acceptance tests and concurrent-request/failure tests pass | §§12–16, 20–34, 43 |
| M5 — progression | Human leaderboard, profile stats, tiers, Peak RP, labeled Rivals | Ranks and ties match database truth; Rivals never count as humans | §§17–19, 35, 50 |
| M6 — release polish | Mobile and accessibility pass, clear transitions/results, telemetry review, deployment/operations | Solo, friend, and Ranked end-to-end journeys pass in production-like staging | §§35–40, 50–51 |

**Dependency rule:** M1 must answer whether the core loop is worth continuing. If playtests show weak Ambush decisions, runaway early leads, or poor human rematch interest, change only the allowed balance variables and retest before M4–M6. This is a product gate, not a demand for a particular metric threshold that the PRD does not provide.

## 2. Reference architecture

**Recommendation:** a TypeScript responsive web client, a TypeScript authoritative application service, a relational transactional database (PostgreSQL is a reasonable candidate), and a server-pushed real-time channel. Use HTTP or equivalent request/response calls for commands and the real-time channel for server events. A deployment choice remains an M0/M2 spike: verify that the selected host can maintain real-time connections and run durable deadline processing. The PRD requires capabilities, not a vendor (§49).

| Component | Owns | Must never own |
| --- | --- | --- |
| Pure rules package | board representation, legal targets, simultaneous resolution, energy accounting, terminal-state evaluation, deterministic result/replay format | identity, sockets, database, wall-clock time |
| Web client | responsive board and controls, local selection/lock display, server-clock presentation, animation, reconnection UI | match outcomes, opponent pending action, RP, authoritative timer |
| Match service | authenticated membership, command validation, immutable round snapshot, fixed deadlines, resolver invocation, event publication | trusting a client-declared board/result |
| Durable store | rooms, player identity, match state, private pending actions, deadline and settlement state, rating ledger | client-writable competitive fields |
| Deadline worker | find due rounds/ready windows/grace windows, acquire work atomically, resolve or expire idempotently | correctness based only on an in-memory timeout |
| Identity/rating service | guest sessions, Google UID binding, handles, queue ownership, Elo/credit, once-only settlement | exposing provider email or secrets in public views |

Use one service process at first if practical; these are responsibility boundaries, not a requirement for microservices. The database is the recovery source of truth. A process restart must be able to resume outstanding deadlines and unsettled matches. Real-time messages carry a monotonically increasing match revision so a reconnecting client can fetch a snapshot and ignore stale events.

### Minimal domain contracts

- **Board:** 25 cells, each `neutral | A | B`. The opening is the PRD's opposite 2×2 corners. Ownership is independent of connectivity after capture.
- **Match configuration:** starting board, standard-round count (initially 12), sudden-death maximum (3), decision duration (initially 5 s), energy cap (3). Values are selected at match creation and stored with the match so a later balance adjustment cannot change an active game.
- **Round snapshot:** board, energy, round number, phase, side assignment, server start/deadline, and revision. All action legality is checked against this snapshot.
- **Action:** `Expand(target)`, `Ambush(target)`, `Surge(target)`, `Override(target)`, or `Pass`; an action is bound to one match, player, and round. A successful lock is immutable for that round.
- **Resolution:** both validated actions, board and energy deltas, collision/interception explanation, ending reason, next-round state. It is computed once from the same snapshot and stored before publication.
- **Public/private split:** unresolved actions, receipt times, and opponent lock state stay in player-private/server data. Public energy remains at its pre-round value until reveal; a paid action's energy is reserved privately at lock and deducted in the revealed result, so energy changes cannot expose a hidden action.

### State machines and command boundary

1. Room: `open → full → readying → active → finished`; `expired/cancelled` exits are possible before active. Seat assignment uses an atomic compare-and-claim operation.
2. Ranked queue: one active lease per UID; `searching → claimed → match_shell` or `expired/cancelled`. Match creation and queue claim share one transaction or equivalent atomic operation.
3. Match: `shell → readying → active_round → resolving → (next_round | reconnect_grace | finished | voided)`. Ranked becomes binding only when both distinct authenticated players acknowledge ready and the server creates Round 1 (§25).
4. Round: `open → deadline_reached → resolved`. In human matches, due time is fixed even if both lock early. The service validates `matchId`, membership, round, revision, target, energy, and deadline. A duplicate command returns the original receipt or a clear conflict; it cannot change the locked move.
5. Result: `terminal_unsettled → settled` or `voided`. Settlement has one immutable match ID and one database transaction for both players' rating/stat changes and ledger entry.

Recommended command surface: create/join/leave room; ready; lock action; fetch match snapshot; reconnect; resign; request/accept rematch; enter/leave Ranked queue; claim handle; fetch leaderboard/profile. Server events: room state, round opened, personal lock receipt, round revealed, reconnect grace, result, rematch state. Authorization is checked on every command and subscription. Public events never contain a pending action or opponent lock receipt.

## 3. M0 — settle the core contract and create the project

1. **Create a compact rule decision record** for the open items in §9 below. Confirm action legality, result reasons, Energy timing, terminal ordering, and automatic Pass semantics. -> **Verify:** each decision can be expressed as a deterministic example with input board, two actions, and expected output.
2. **Set up the repository** with a client, pure rules package, server, database migrations, and focused test runners. Add a local two-browser development path and one-command checks. -> **Verify:** fresh checkout starts the client/server and runs an empty smoke test; no secrets are committed.
3. **Spike the deployment capabilities** needed by §49: Google identity, private per-player data, transactions, server deadlines, live updates, and reconnect. -> **Verify:** demonstrate a private round receipt, a durable due job, and atomic claim/unique constraint in a disposable environment before committing to a host.
4. **Fix event and snapshot schemas** with a version field. Keep replay data sufficient to reproduce every resolved round. -> **Verify:** deserialize a saved match fixture and reproduce the same final board/energy/result.

## 4. M1 — prove the game locally

1. **Implement pure legality functions** for all five actions on a pre-round board: orthogonal Expand, opponent-legal neutral Ambush target, Manhattan-distance-2 Surge, adjacent-enemy Override, always-legal Pass; enforce Energy costs and cap. -> **Verify:** table tests cover legal/illegal edges, disconnected territory, insufficient Energy, and no mutable shared state.
2. **Implement a two-action simultaneous resolver.** Validate both against one snapshot; apply committed costs; handle neutral-node collisions and Ambush interception; apply Ambush reward only after territorial changes; give newly captured nodes no same-round reach. Produce a reason for every success/failure. -> **Verify:** every matrix item in §9.2 and every core acceptance case in §45 has a deterministic test. Reversing network receipt order yields identical output.
3. **Implement match progression.** Count 12 standard rounds, score, enter at most three sudden-death rounds with no automatic Energy regeneration, and end when there are no neutral cells and neither player has a legal territory-changing action. -> **Verify:** fixtures cover regular win, tied final round, all sudden-death outcomes, board exhaustion, and a legal Override keeping a full board active.
4. **Build a responsive local board** with action selection, target highlighting, explicit lock, a privacy handoff screen between local players, visible local timer, revealed result explanation, score/Energy, and result/restart. Add a simple bot based only on public state and legal actions; do not build advanced bot tuning yet. -> **Verify:** complete a match by hand on mobile viewport and laptop without revealing the first player's selection during handoff; no hover is required and ownership is readable without color.
5. **Instrument prototype rounds** (action selected, action succeeded, score lead, round reached, game end, rematch) without storing private moves before reveal in client-visible analytics. -> **Verify:** a completed local game produces an intelligible replay/summary and no hidden move leaks.
6. **Run structured playtests** with competent human pairs and at least one first-time player. Record ambiguity, action mix, Ambush hit rate, board exhaustion, side advantage, match length, and voluntary rematches. Test 10/12/15 rounds and other §41 variables only when evidence calls for them. -> **Verify:** write a short go/tune/stop decision with observations and any changed balance values.

## 5. M2 — guest friend matches and real-time authority

1. **Create guest sessions** with opaque, expiring IDs; add optional match display names. Build room creation with random human code and separate high-entropy URL token, expiry, room/guess limits, and atomic seat claim. -> **Verify:** two devices can join by code and URL; simultaneous joins give exactly one claimant per seat; invalid-code attempts throttle.
2. **Persist matches/rounds and enforce command authorization.** The server creates the opening state, side assignment, deadlines, and accepted actions. Reject invalid or late actions with a reason; never silently convert one to another. -> **Verify:** forged membership, board, result, Energy, and opponent-action payloads cannot mutate authoritative state.
3. **Implement private lock and fixed reveal.** Store one pending action per player in private server storage; send only the submitting player a neutral receipt. Resolve at the fixed server deadline with automatic Pass for connected non-submitters. -> **Verify:** both early locks do not reveal early; a second client cannot read either pending move or opponent lock status; differing arrival order has no effect.
4. **Build durable deadline processing and sync.** Due jobs use persisted timestamps and an atomic claim; result writes precede broadcasts. Reconnect fetches an authoritative snapshot plus event revision. -> **Verify:** killing the worker just before/after a deadline and retrying produces one result and no stuck round.
5. **Handle inactivity, disconnect, and refresh.** Track connected missed deadlines separately from actual disconnections. The current round continues on disconnect; a post-resolution grace waits before another round; repeated-grace policy follows §26.3. Quick Duel ends without rating impact. -> **Verify:** §44 and the applicable §26 tests pass, including refresh and lost network at lock/deadline boundaries.
6. **Add rematch invitation with 30-second target expiry and swapped sides.** -> **Verify:** both accept in time to start a new match with opposite sides; an expired invitation cannot start one.

## 6. M3 — solo quality and onboarding

1. **Build Practice** with contextual teaching, legal target cues, optional hints, outcome explanations, and instant restart. Keep its records outside Ranked statistics. -> **Verify:** first-time user completes a match and can explain that Ambush blocks only Expand.
2. **Build Quick Duel vs Bot** without coaching. Use the same rules and result flow as human matches, with permitted early reveal after both independently committed moves. -> **Verify:** signed-out visitor selects a difficulty, finishes, and rematches; no RP fields change.
3. **Implement three bounded bot policies.** Easy favors Expand; Normal considers territory, contested targets, Energy, and action opportunity; Hard scores board position and the last ~3 *revealed* player actions. Give every bot only public pre-round state, Energy, legal options, and permitted history. -> **Verify:** bot API cannot receive pending human action; seeded runs are reproducible; each difficulty completes games without illegal moves.
4. **Add concise interactive tutorial and How to Play.** Explain objective, simultaneous moves, five actions, Energy, and outcome reasons in play order. -> **Verify:** a first-time player can start and complete a solo match without outside explanation.

## 7. M4 — Ranked identity, pairing, and settlement

1. **Add Google sign-in and persistent internal UID.** Preserve the intended Ranked destination through the auth round trip (challenge URL, room, or queue), then require a public handle before Ranked. Keep provider email/tokens out of public game data. -> **Verify:** signed-out desktop and mobile invite flows return to the same challenge; wrong/expired auth state is rejected; handle case-insensitive uniqueness survives concurrent claims.
2. **Build Ranked challenge and matchmaking.** Require two distinct authenticated UIDs. Use one active Ranked ownership/lease per UID across queue, shell, binding match, and terminal settlement; expire stale pre-binding leases, but release a binding match's ownership only after settlement or voiding. Search at approximate ±150 RP (0–5 s), ±300 (5–10 s), then any eligible player (10–15 s), preferring full-credit opponents. Hide opponent handle/RP/tier until binding. -> **Verify:** concurrent requests/workers/tabs cannot put a UID in two active Ranked matches; a second tab returns to the existing match; an unsettled result blocks a new pairing.
3. **Implement the ready handshake.** Create a shell, wait for both authenticated clients to connect and acknowledge ready, then atomically set `startedAt` and create Round 1. Cancel an unready shell at the 15-second target without competitive effect. -> **Verify:** pre-binding crash/auth/load failure gives no loss, rating, placement, or anti-farming consumption; post-binding exit follows match rules.
4. **Implement placement and repeated-opponent credit.** Track qualifying placement progress separately from match history. Within rolling 24 hours, at most two matches against the same opponent count for a placement player. For established pairs: matches 1–3 full credit; 4th 75% RP only; 5th 50% RP only; 6th+ zero. Compute and disclose credit when the shell is created, before players ready, and store that assessment with the match; a cancelled shell consumes no credit. -> **Verify:** boundaries 2/3 and 3/4/5/6, the 24-hour edge, and asymmetric placement/established scenarios follow the decision in §9.
5. **Implement exact Elo settlement** from pre-match ratings, per-player K (placement 64, post-placement through rated match 20: 32, match 21 onward: 24), multiplier after raw delta, deterministic rounding, RP floor at zero, and Peak RP. Update `ratedMatchCount` only for nonzero credit. -> **Verify:** independent worked examples cover win/draw/loss, unequal K, fractional deltas, RP floor, placement transition, and all multipliers.
6. **Make settlement atomic and idempotent.** One transaction claims the terminal match ID, reads both profile versions, writes both rating/stat updates and a unique ledger record, then marks settled. A retry reads the stored settlement. Failed authoritative computation leads to a voided result, not a player loss. -> **Verify:** repeated and concurrent settlement calls change balances/stats once; injected failures before/after commit recover correctly.
7. **Implement Ranked forfeit and resignation** with explicit confirmation, current-round continuation on disconnect, post-round grace of 20/10/0 seconds by disconnect count, connected AFK strikes, and stat/credit rules. -> **Verify:** §43 disconnect and §27 outcomes, including already-locked action, automatic Pass, grace expiry, streak, and zero-credit matches.

## 8. M5 — truthful progression

1. **Expose a public profile view** containing only handle and intended competitive fields. Support unique handle reservation, validation (3–16 alphanumeric/underscore), basic profanity filter, and a defined rename cooldown. -> **Verify:** case-insensitive collisions fail atomically; public responses contain no email/provider secret.
2. **Implement tier derivation** from current RP: Bronze 0–899, Silver 900–1099, Gold 1100–1299, Platinum 1300–1499, Diamond 1500–1699, Master 1700+. Track Peak RP separately. -> **Verify:** every boundary has a test; promotion/demotion has no artificial floor.
3. **Implement Top Players and Around You** from placed human accounts only. Rank is `1 + count(eligible players with strictly greater RP)`, so ties share rank even if display order is stable. -> **Verify:** unplaced accounts and Rivals are absent; 1400/1400/1380 displays ranks 1/1/3; Around You shows approximately two neighbors each way.
4. **Add clearly labeled Rivals** as static benchmark milestones, outside human ranking and W/L/D. Add result/profile views including credit explanation, placement progress, RP delta, rank, and next Rival. -> **Verify:** users cannot mistake a Rival for a human competitor; reduced/zero credit and void outcomes are explicit.

## 9. Rules and product decisions to resolve

These are not instructions from the attached document; they are gaps or tensions found while turning its requirements into an executable contract. Resolve them at the indicated gate and record examples, without broadening scope.

| Decision needed | Why it matters | Proposed default / gate |
| --- | --- | --- |
| **Placement versus established-player credit** when one player's placement repeat limit is exhausted | §15 states the placement player's RP/progress stays unchanged; §20 says the established-pair multiplier is symmetric but placement takes precedence when either placement is affected. The other player's RP/stat treatment is not explicit. | **M4:** conservatively give **zero competitive credit to both** for that match, disclose it before ready, and test it. Confirm this rule before Ranked code. |
| **Elo rounding at exact half points** | §16 requires one deterministic rule but does not name it. Language/runtime defaults differ for negative halves. | **M4:** use round half away from zero for signed deltas, then clamp RP at zero. Freeze as settlement contract and test ±0.5 cases. |
| **Invalid lock at/near deadline** | §9 rejects invalid actions without silently transforming them; §7/§10 assign automatic Pass on no valid committed action. | **M0:** reject the invalid command immediately; if no valid lock exists at deadline, record an automatic Pass and the appropriate connected-AFK strike. Return explicit rejection before deadline whenever possible. |
| **AFK third miss timing** | §10 says third consecutive missed action terminates the match, while rounds normally resolve at the deadline. | **M2:** resolve the deadline round with Pass, then terminate/forfeit before opening another round; test this ordering. |
| **Reconnect detection and repeat count** | Network presence can lag or flap, and §26 distinguishes disconnect from connected inactivity. | **M2:** define a bounded heartbeat/presence timeout and count distinct disconnect episodes; make the transition visible in logs and deterministic tests. |
| **Repeat-match 24-hour timestamp** | Credit must be disclosed before starting and remain stable through settlement. | **M4:** at shell creation, count prior binding Ranked matches whose `startedAt` is in the previous 24 hours relative to `creditAssessedAt`, excluding void/pre-binding cancellations; store the assessment then. Test the exact boundary and shell cancellation. |
| **Both players disconnected at grace expiry** | §26 specifies a forfeiting disconnected player but does not define a simultaneous absence outcome. | **M2/M4:** define and test a neutral terminal outcome (recommended: void for Ranked, no rating/stat changes) so worker order cannot decide a winner. |
| **Handle rename cooldown and profanity list** | §13 requires both without a duration/list. | **M4/M5:** choose a small explicit initial policy and document enforcement before exposing rename; neither blocks the first core prototype. |
| **Override versus an action on the same cell** | Under current legality, Override targets an enemy-owned cell; Expand/Surge/Ambush target neutral cells; opposite players' Overrides target different owners. §9.2's generic same-cell case is therefore unreachable today. | **M0:** encode the current action domains and a test proving no legal same-cell pair exists. Reopen only if action definitions change. |

The opening-board diagram in the source document is formatted as text. Encode it explicitly as rows `AA... / AA... / ..... / ...BB / ...BB` and confirm it against the intended opposite 2×2 corners before M1. If that differs from the author's intended layout, adjust the fixture rather than the resolver.

## 10. Data model and integrity constraints

Design migrations only as each milestone needs them. The following is the target model, not an instruction to create every table on day one.

| Record | Key fields / constraints | Introduced |
| --- | --- | --- |
| `guest_session` | opaque ID, expiry, active room limit | M2 |
| `account` / `ranked_profile` | internal UID, normalized unique handle, RP, peak RP, placement progress, rated match count, W/L/D, streak, version | M4 |
| `room` / `room_seat` | random code, hashed or safely stored invite token, host, two distinct seats, expiry, status | M2 |
| `ranked_ownership` | UID primary key, one current queue/shell/active-match reference, lease expiry; released atomically | M4 |
| `match` / `match_player` | immutable ID, mode, frozen config, side, status, started/ended times, result/void reason, binding and settlement state | M2/M4 |
| `round` / `pending_action` / `round_result` | round number and snapshot/revision, deadline, one private action per player per round, revealed result, uniqueness on `(match_id, round, player)` | M2 |
| `rating_settlement` / `rating_ledger` | unique match ID, both before/after values, multiplier, K, reason, committed timestamp | M4 |
| `rematch_invitation` | pair, parent match, expiry, acceptance states | M2 |
| `telemetry_event` or aggregate | event name, mode, match/round reference where necessary, no provider secrets or pre-reveal opponent action | M1 onward |

Use unique constraints and transactional state transitions for seat claiming, normalized handles, queue ownership, one action lock per round, match creation, and rating settlement. A uniqueness check in application code alone is insufficient for these races. Apply strict row/API permissions: clients can submit commands and read authorized views but cannot directly write board ownership, private opponent action, competitive totals, or result.

## 11. Verification matrix

| Layer | Narrow checks | Failure cases to inject |
| --- | --- | --- |
| Rules unit tests | all §45 pairs, Energy, legality, disconnected nodes, board exhaustion, sudden death, invariant and replay tests | same target, insufficient Energy, duplicate action, reversed receipt order |
| Server integration | command authorization, deadline, fixed reveal, private data, room/queue uniqueness, snapshot/revision recovery | late/duplicate commands, two workers, two tabs, crash before/after result commit |
| Rating integration | exact Elo/K/multiplier/placement/streak, tied ranks, exactly-once ledger | concurrent settlement, transaction retry, zero credit, half-point rounding, RP floor |
| Browser E2E | solo; guest room on two devices; Google invite return; Ranked ready/binding; rematch; desktop/mobile | refresh, disconnect/reconnect, auth cancellation, ready timeout, stale invite |
| Playtest | comprehension, action mix, game length, rematch behavior, side balance separated by human/bot mode | record observations; change only §54 balance variables with before/after evidence |

Maintain a fake-clock match harness so a 5-second human round, ready timeout, 24-hour repeat window, and reconnect grace can be tested without real waits. Run the narrow checks for a milestone before adding broader end-to-end gates. Before release, execute the full §43–45 acceptance checklist against a production-like build and review logs for private-action leakage.

## 12. Release and operations

1. Configure separate development/staging/production environments; store Google credentials, session keys, and invite-token secrets outside the repository. Use HTTPS and authenticated real-time connections. -> **Verify:** staging can complete all three §50 journeys with production-like identity and timing.
2. Add migrations, backup/restore procedure, health checks, and structured logs keyed by match ID. Log state transitions and settlement IDs, not unresolved actions or provider secrets. -> **Verify:** restore a staging backup and replay/inspect a finished match without altering rating.
3. Add alerts or at least operational queries for overdue rounds, expired but unreleased queue leases, stuck shells, unsettled terminal matches, duplicate settlement attempts, and void rate. -> **Verify:** injected stuck/failed jobs appear in the query or alert and can be safely retried.
4. Review privacy and retention for guest sessions, room invites, match history, and telemetry; define deletion/expiry jobs before public launch. -> **Verify:** expired rooms/tokens cease working and cleanup preserves settlement audit data needed for integrity.
5. Run the contest-demo script: alone → bot match → create/join guest match on another device → synchronized reveal → result/rematch → explain Ranked and truthful human leaderboard. -> **Verify:** an unfamiliar reviewer can complete it without creator intervention (§51).

## 13. Definition of complete

The MVP is complete only when all three PRD §50 journeys work end to end, the §43–45 acceptance tests pass, Ranked settlement cannot duplicate or be client-controlled, pending actions and lock timing remain private, the leaderboard contains only eligible humans, and mobile/accessible play is usable. Record any deliberate balance changes separately from the frozen product invariants. If a required backend capability cannot be demonstrated, stop that milestone and replace the design rather than weakening the PRD silently.

## Technical references for the recommended stack

- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/sql-set-transaction.html) and [row-locking queries](https://www.postgresql.org/docs/current/sql-select.html) inform the atomic-claim/retry design; exact schema and isolation level must be validated in the M0 spike.
- [Google OpenID Connect documentation](https://developers.google.com/identity/openid-connect/openid-connect) informs the server-side identity validation and auth-return-state design.

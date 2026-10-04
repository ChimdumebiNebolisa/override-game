# OVERRIDE implementation plan

**Source:** [OVERRIDE_PRD_v0.3.docx](OVERRIDE_PRD_v0.3.docx) (frozen prototype PRD, supplied 2026-10-04)

**Planning baseline:** greenfield repository; no existing application or infrastructure

**Goal:** deliver the PRD's solo, guest friend, and human Ranked journeys while proving the game loop before investing in competitive infrastructure.

This is a delivery plan, not a change to the PRD. Statements labeled **Recommendation** are implementation choices. The rule clarifications in plan §10 were approved by the product owner on 2026-10-04. Prototype balance values are deliberately measurable and adjustable under PRD §54.

## 1. Delivery strategy and gates

Build in vertical slices. Each slice must produce a usable path and pass its narrow gate before dependent work starts. Keep a single deterministic rules implementation and use it in local, bot, and server-hosted matches. Do not build the full Ranked system into the first playable prototype (§52).

Treat the exclusions in PRD §47 as MVP scope limits. In particular, do not add chat, spectators, monetization, extra board sizes, seasons, or LLM turn decisions while delivering these milestones.

| Milestone | Deliverable | Gate to continue | PRD basis |
| --- | --- | --- | --- |
| M0 — rule contract | Executable rules examples and a minimal rules/client test harness | Every listed action pair has an agreed outcome; opening and sample games replay deterministically | §§4–10, 45, 52, 54 |
| M1 — core prototype | Local two-person pass-and-play and simple bot; complete match, result, immediate restart, lightweight metrics | Deterministic resolver tests pass; two informed humans can finish and explain matches; playtest decision recorded | §§4–11, 40–42, 52–53 |
| M2 — guest human multiplayer | Create/join friend room on two devices, secure invite, synchronized fixed-deadline rounds, basic recovery | Friend-specific §44 tests pass on desktop and mobile with network interruption | §§22, 26, 28–29, 32, 44 |
| M3 — solo quality | Practice coaching, tutorial, Easy/Normal/Hard bots, unranked bot duel | A new visitor can play alone without creator explanation; bots use public information only; remaining bot-specific §44 tests pass | §§3, 11, 37, 44, 50 |
| M4 — Ranked integrity | Google sign-in, handle, challenge, queue, ready handshake, placement, Elo, anti-farming, reconnect/forfeit, exactly-once settlement | Ranked integrity/concurrency tests pass; leaderboard display cases are deferred to M5 | §§12–16, 20–34, 43 |
| M5 — progression | Human leaderboard, profile stats, tiers, Peak RP, labeled Rivals | Ranks and ties match database truth; Rivals never count as humans; remaining §43 display tests pass | §§17–19, 35, 43, 50 |
| M6 — release polish | Mobile and accessibility pass, clear transitions/results, telemetry review, deployment/operations | Solo, friend, and Ranked end-to-end journeys pass in production-like staging | §§35–40, 50–51 |

**Dependency rule:** M1 must answer whether the core loop is worth continuing. If playtests show weak Ambush decisions, runaway early leads, or poor human rematch interest, change only the allowed balance variables and retest before M4–M6. This is a product gate, not a demand for a particular metric threshold that the PRD does not provide.

## 2. Reference architecture

**Recommendation for live matches:** a TypeScript responsive web client, a TypeScript authoritative application service, a relational transactional database (PostgreSQL is a reasonable candidate), and a server-pushed real-time channel. Use HTTP or equivalent request/response calls for commands and the real-time channel for server events. Choose and validate the backend in M2, after the local prototype gate; verify that the selected host can maintain real-time connections and run durable deadline processing. The PRD requires capabilities, not a vendor (§49). The M1 local prototype is deliberately non-authoritative; no released human match or Ranked result may rely on client-owned state.

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

1. **Turn the approved rules in plan §10 into executable examples.** Cover action legality, result reasons, Energy timing, terminal ordering, automatic Pass, and the unreachable same-cell Override case. -> **Verify:** each rule has a deterministic input board, two actions, and expected output.
2. **Set up only the prototype harness:** a pure rules package, local web client, and focused rules/UI checks. Defer the server, database, matchmaking, and deployment work until the M1 playtest gate. -> **Verify:** a fresh checkout runs the rules tests and local game without credentials or infrastructure.
3. **Encode the exact opening fixture** from §4.1 as `AA... / AA... / ..... / ...BB / ...BB`; record side assignment and match configuration in replay fixtures. -> **Verify:** both sides start with four cells in opposite 2×2 corners, and the same input produces the same replay.

## 4. M1 — prove the game locally

1. **Implement pure legality functions** for all five actions on a pre-round board: orthogonal Expand, opponent-legal neutral Ambush target, Manhattan-distance-2 Surge, adjacent-enemy Override, always-legal Pass; enforce Energy costs and cap. -> **Verify:** table tests cover legal/illegal edges, disconnected territory, insufficient Energy, and no mutable shared state.
2. **Implement a two-action simultaneous resolver.** Validate both against one snapshot; apply committed costs; handle neutral-node collisions and Ambush interception; apply Ambush reward only after territorial changes; give newly captured nodes no same-round reach. Produce a reason for every success/failure. -> **Verify:** every matrix item in §9.2 and every core acceptance case in §45 has a deterministic test. Reversing network receipt order yields identical output.
3. **Implement match progression.** Count 12 standard rounds, score, enter at most three sudden-death rounds with no automatic Energy regeneration, and end when there are no neutral cells and neither player has a legal territory-changing action. -> **Verify:** fixtures cover regular win, tied final round, all sudden-death outcomes, board exhaustion, and a legal Override keeping a full board active.
4. **Build a responsive local board** with action selection, target highlighting, explicit lock, a privacy handoff screen between local players, visible local timer, revealed result explanation, score/Energy, and result/restart. Add a simple bot based only on public state and legal actions; do not build advanced bot tuning yet. -> **Verify:** complete a match by hand on mobile viewport and laptop without revealing the first player's selection during handoff; no hover is required and ownership is readable without color.
5. **Instrument prototype rounds** (action selected, action succeeded, score lead, round reached, game end, rematch) without storing private moves before reveal in client-visible analytics. -> **Verify:** a completed local game produces an intelligible replay/summary and no hidden move leaks.
6. **Run structured playtests** with competent human pairs and at least one first-time player. Record ambiguity, action mix, Ambush hit rate, board exhaustion, side advantage, match length, and voluntary rematches. Test 10/12/15 rounds and other §41 variables only when evidence calls for them. -> **Verify:** write a short go/tune/stop decision with observations and any changed balance values.

## 5. M2 — guest friend matches and real-time authority

1. **Validate the backend capabilities in §49** with a disposable spike: private per-player data, real-time updates, transactional seat claim, durable server deadline, presence/recovery, and a path to Google identity. Keep the spike outside the game path until it passes. -> **Verify:** demonstrate a private round receipt, a due job that survives restart, and one winner of a concurrent seat claim before committing to the host.
2. **Create the live service and guest sessions** with opaque, expiring IDs and optional match display names. Build room creation with random human code and separate high-entropy URL token, expiry, room/guess limits, and atomic seat claim. -> **Verify:** two devices can join by code and URL; simultaneous joins give exactly one claimant per seat; invalid-code attempts throttle.
3. **Persist matches/rounds and enforce command authorization.** The server creates the opening state, randomly assigns sides for a first match, and owns deadlines and accepted actions. Define versioned snapshot/event schemas and store replay data for each resolved round. Reject invalid or late actions with a reason; never silently convert one to another. -> **Verify:** forged membership, board, result, Energy, and opponent-action payloads cannot mutate authoritative state; initial sides are server-assigned; a saved fixture replays to the same result.
4. **Implement private lock and fixed reveal.** Store one pending action per player in private server storage; send only the submitting player a neutral receipt. Resolve at the fixed server deadline with automatic Pass for any player without a valid lock, whether connected or disconnected; only connected misses accrue AFK strikes. -> **Verify:** both early locks do not reveal early; a second client cannot read either pending move or opponent lock status; differing arrival order has no effect.
5. **Build durable deadline processing and sync.** Due jobs use persisted timestamps and an atomic claim; result writes precede broadcasts. Reconnect fetches an authoritative snapshot plus event revision. -> **Verify:** killing the worker just before/after a deadline and retrying produces one result and no stuck round; client clock skew and network delay do not alter the server deadline.
6. **Handle inactivity, disconnect, and refresh.** Track connected missed deadlines separately from actual disconnections; show an AFK warning after the second consecutive connected miss and apply the approved third-miss ordering in plan §10. Confirm offline state after a short server-side debounce and count one episode until reconnection. The current round continues on disconnect; a post-resolution grace waits before another round; repeated-grace policy follows §26.3. Quick Duel ends without rating impact. -> **Verify:** friend-specific §44 and applicable §26 tests pass, including warning/reset behavior, refresh, and lost network at lock/deadline boundaries.
7. **Add rematch invitation with 30-second target expiry and swapped sides.** -> **Verify:** both accept in time to start a new match with opposite sides; an expired invitation cannot start one.

## 6. M3 — solo quality and onboarding

1. **Build Practice** with contextual teaching, legal target cues, optional hints, outcome explanations, and instant restart. Keep its records outside Ranked statistics. -> **Verify:** first-time user completes a match and can explain that Ambush blocks only Expand.
2. **Implement three bounded bot policies.** Easy favors Expand; Normal considers territory, contested targets, Energy, and action opportunity; Hard scores board position and the last ~3 *revealed* player actions. Give every bot only public pre-round state, Energy, legal options, and permitted history. -> **Verify:** bot API cannot receive pending human action; seeded runs are reproducible; each difficulty completes games without illegal moves.
3. **Complete Quick Duel vs Bot** without coaching, extending the simple M1 bot path to all three difficulties. Run released bot matches through the authoritative match service, with permitted early reveal after both independently committed moves. -> **Verify:** signed-out visitor selects a difficulty, finishes, and rematches; no RP fields change and the bot cannot observe the pending human move.
4. **Add concise interactive tutorial and How to Play.** Explain objective, simultaneous moves, five actions, Energy, and outcome reasons in play order. -> **Verify:** a first-time player can start and complete a solo match without outside explanation.

## 7. M4 — Ranked identity, pairing, and settlement

1. **Add Google sign-in and persistent internal UID.** Use the minimum sign-in scope; validate the returned identity on the server and verify the auth state. Preserve the intended Ranked destination through the auth round trip (challenge URL, room, or queue), then require a public handle before Ranked. Guest history stays separate; no guest-to-Google merge is needed. Keep provider email/tokens out of public game data. -> **Verify:** signed-out desktop and mobile invite flows return to the same challenge; wrong/expired auth state and invalid identity assertions are rejected; handle case-insensitive uniqueness survives concurrent claims.
2. **Build Ranked challenge and matchmaking.** Require two distinct authenticated UIDs. Use one active Ranked ownership/lease per UID across queue, shell, binding match, and terminal settlement; expire stale pre-binding leases, but release a binding match's ownership only after settlement or voiding. Search at approximate ±150 RP (0–5 s), ±300 (5–10 s), then any eligible player (10–15 s), preferring full-credit opponents. Hide opponent handle/RP/tier until binding. -> **Verify:** concurrent requests/workers/tabs cannot put a UID in two active Ranked matches; a second tab returns to the existing match; an unsettled result blocks a new pairing.
3. **Implement the ready handshake.** Create a shell, wait for both authenticated clients to connect and acknowledge ready, then atomically set `startedAt` and create Round 1. Cancel an unready shell at the 15-second target without competitive effect. -> **Verify:** pre-binding crash/auth/load failure gives no loss, rating, placement, or anti-farming consumption; post-binding exit follows match rules.
4. **Implement placement and repeated-opponent credit.** Track qualifying placement progress separately from match history; hide official global rank before exactly five qualifying matches. Within rolling 24 hours, at most two matches against the same opponent count for a placement player; an ineligible placement repeat gives zero competitive credit to both players. For established pairs: matches 1–3 affect RP, `ratedMatchCount`, W/L/D, and streak; the 4th gives 75% RP and the 5th 50% RP, and both increment `ratedMatchCount` but leave W/L/D and streak unchanged; the 6th and later give zero competitive credit. Compute and disclose credit when the shell is created, before players ready, and store that assessment with the match; a cancelled shell consumes no credit. For public matchmaking, disclose the modifier without revealing opponent identity before binding. -> **Verify:** exactly five qualifying matches complete placement; boundaries 2/3 and 3/4/5/6, the 24-hour edge, queue privacy, and the approved mixed placement/established rule in plan §10.
5. **Implement exact Elo settlement** from both pre-match ratings. For each player independently, compute `expected = 1 / (1 + 10 ^ ((opponentRP - ownRP) / 400))`, `rawDelta = K × (actual - expected)`, `adjustedDelta = rawDelta × competitiveMultiplier`, `delta = round(adjustedDelta)` using approved D2 half-away-from-zero rounding, and `newRP = max(0, oldRP + delta)`. Use actual scores 1/0.5/0 for win/draw/loss and per-player K (placement 64, post-placement through rated match 20: 32, match 21 onward: 24). Track Peak RP; increment `ratedMatchCount` only for nonzero credit. Full-credit wins increment streak; qualifying losses and draws reset it, while reduced/zero-credit matches leave it unchanged. -> **Verify:** independent worked examples cover win/draw/loss, unequal K, fractional deltas, RP floor, placement transition, streak, and all multipliers.
6. **Make settlement atomic and idempotent.** One transaction claims the terminal match ID, reads both profile versions, writes both rating/stat updates and a unique ledger record, then marks settled. A retry reads the stored settlement. Retry transient infrastructure failures; if authoritative computation or settlement cannot be trusted after recovery, void the match rather than assign a player loss. -> **Verify:** repeated and concurrent settlement calls change balances/stats once; injected failures before/after commit recover correctly; unrecoverable failure changes no competitive totals.
7. **Implement Ranked forfeit and resignation** with explicit confirmation, current-round continuation on disconnect, post-round grace of 20/10/0 seconds by disconnect count, connected AFK strikes, mutual no-contest handling and repeat-incident cooldown under approved D7, and stat/credit rules. Reduced-credit matches still settle RP but do not alter W/L/D or streak; zero-credit matches alter neither. A qualifying resignation/forfeit resets streak under §21. -> **Verify:** §43 disconnect and §27 outcomes, including already-locked action, automatic Pass, grace expiry, mutual absence, streak, and zero-credit matches.
8. **Add Ranked rematches** using the existing invitation flow: retain Ranked mode, swap sides, recalculate/disclose competitive credit before both players commit, and expire requests after the bounded window. -> **Verify:** immediate rematch swaps sides, reduced/zero credit is visible before ready, and expiration cannot create a stale Ranked match.

## 8. M5 — truthful progression

1. **Expose a public profile view** containing only handle and intended competitive fields. The initial handle is reserved atomically in M4; enforce the approved 30-day cooldown after each successful rename and the same validation (3–16 alphanumeric/underscore), case-insensitive uniqueness, and basic maintained profanity list on rename. -> **Verify:** concurrent case-insensitive claims/renames cannot collide; rename before day 30 fails; public responses contain no email/provider secret.
2. **Implement tier derivation** from current RP: Bronze 0–899, Silver 900–1099, Gold 1100–1299, Platinum 1300–1499, Diamond 1500–1699, Master 1700+. Track Peak RP separately. -> **Verify:** every boundary has a test; promotion/demotion has no artificial floor.
3. **Implement Top Players and Around You** from placed human accounts only; reveal eligible rank after the fifth qualifying placement match. Rank is `1 + count(eligible players with strictly greater RP)`, so ties share rank even if display order is stable. -> **Verify:** unplaced accounts and Rivals are absent; 1400/1400/1380 displays ranks 1/1/3; Around You shows approximately two neighbors each way.
4. **Add clearly labeled Rivals** as static benchmark milestones, outside human ranking and W/L/D. Add result/profile views including credit explanation, placement progress, RP delta, rank, and next Rival. -> **Verify:** users cannot mistake a Rival for a human competitor; reduced/zero credit and void outcomes are explicit.

## 9. M6 — contest polish, accessibility, and telemetry

1. **Finish the phone and laptop layouts** for home, board, lobby, result, profile, leaderboard, and auth return states. Keep the board, timer, selected action/target, and local lock state visible without horizontal scrolling or hover-only controls. -> **Verify:** complete all three §50 journeys on mobile portrait and laptop; touch targets and outcome text remain usable through resolution animation.
2. **Complete the accessibility pass:** ownership uses symbols or patterns as well as color; controls have keyboard operation, visible focus, readable labels, and sufficient contrast; reduced-motion preference removes nonessential animation without hiding outcomes. -> **Verify:** keyboard-only and reduced-motion play can finish a match, and ownership/outcomes remain understandable without color or animation.
3. **Add restrained sound and visual transitions** only where they clarify lock, reveal, collision, interception, result, or reconnect state. Include empty, loading, expired-invite, auth-failure, queue-timeout, and voided-match states. -> **Verify:** first-time players can explain why their action succeeded or failed, and every failure state offers a clear next action.
4. **Complete privacy-conscious telemetry** for the §40 funnel and gameplay measures. Separate voluntary Pass from timeout Pass, each mode's rematch rate, and human side-balance from Easy/Normal/Hard bot side-balance. Never publish unresolved move or opponent lock timing. -> **Verify:** staging events reconstruct the funnel, completion and action rates, board-exhaustion frequency, distinct rematch rates, and side win rates without exposing private data.
5. **Run the final playtest and release gate.** Review human rematch behavior and §41 balance hypotheses before cosmetic tuning. Execute §43–45 acceptance tests and the contest-demo script, then record known limitations. -> **Verify:** an unfamiliar reviewer completes solo and two-device play without creator intervention; the Ranked journey settles once and displays a truthful human rank.

## 10. Approved rule clarifications

The product owner explicitly signed off on all ten recommendations (D1–D10) in the project conversation on 2026-10-04 and reaffirmed that approval for the complete decision set. This approval is recorded here as the decision log. These clarify gaps or tensions in the frozen PRD; they do not add game modes or change its product invariants. Implement and test the rules below at their listed milestones.

| ID | Approved rule | Implementation and verification |
| --- | --- | --- |
| D1 — placement repeat | If a placement player's same-opponent limit is exhausted, the match remains playable but **both players receive zero competitive credit**: no RP, `ratedMatchCount`, placement, W/L/D, or streak change. Show this before ready. | M4: test a placement player against an established player at the third same-opponent match within 24 hours; neither profile changes. |
| D2 — Elo half points | Round a signed `adjustedDelta` to the nearest integer, with exact halves **away from zero**; then clamp RP at zero. | M4: test `+0.5 → +1` and `-0.5 → -1`, including a player at the RP floor. |
| D3 — invalid lock | Reject an invalid action with an explicit reason. It consumes no lock; the player may retry until the server deadline. With no valid lock at the deadline, record automatic Pass. Only a connected player receives the applicable AFK strike. | M0/M2: test retry before deadline, rejection after deadline, automatic Pass, and connected versus disconnected strike behavior. |
| D4 — third connected miss | At the third consecutive connected missed deadline, resolve that round with automatic Pass, then end the match as a forfeit before another round opens. The forfeit takes precedence over an ordinary score ending from that round. A valid player action resets the miss count. | M2/M4: test resolution is published once, the opponent's locked action resolves, no next round opens, and Ranked settlement occurs once. |
| D5 — disconnect episode | Server presence must confirm an offline state after a short debounce; a transient socket close alone is insufficient. Count one disconnect episode from confirmed offline until reconnection, not every transport flap. | M2: choose the exact debounce using two-device network tests, then test flaps, refresh, and reconnect. |
| D6 — repeat-match window | Set `creditAssessedAt` when a match shell is created. Count prior binding Ranked matches with `startedAt` in the preceding rolling 24 hours, excluding voided and pre-binding-cancelled matches. Disclose and freeze the resulting credit for that shell; a cancelled shell consumes none. | M4: test the exact 24-hour boundary, cancellation, and unchanged credit between ready and settlement. |
| D7 — mutual disconnect | If both players remain disconnected when the applicable grace expires, end the match as **no contest**. Neither receives a win, loss, draw, RP, placement, `ratedMatchCount`, streak, or anti-farming credit. Record a disconnect incident for each account. Repeated mutual incidents trigger a short Ranked queue cooldown; determine its count and duration in M4 abuse tests. A prior completed resignation or forfeit is settled normally. | M2/M4: test simultaneous and staggered disconnects from persisted presence/deadlines so worker order cannot choose a winner; test repeated-incident cooldown. |
| D8 — credit notice privacy | Show the competitive-credit modifier before ready, without the opponent's handle, RP, or tier. Reveal opponent identity only after binding. | M4: test that notice appears before commitment and that repeated queue cancellation cannot reliably reveal or select an opponent. |
| D9 — handle rename | Allow one successful rename per **30 days** after the initial handle selection. Enforce 3–16 alphanumeric/underscore characters, case-insensitive uniqueness, and a basic maintained profanity list on both selection and rename. | M4/M5: test first-handle exemption, day-30 boundary, concurrent claims, and filtering. |
| D10 — same-cell Override | Under the current action domains, Override targets an enemy-owned cell, while Expand/Surge/Ambush target neutral cells; opposing Overrides target different owners. Therefore no legal same-cell Override pairing exists. Keep the action definitions unchanged. | M0: test that the purported case is unreachable for every legal action pair; reopen only if action definitions change. |

Implementation tuning selected for the local service: D5 confirms offline after 1.5 seconds without an active replacement connection; D7 starts a 15-minute Ranked queue cooldown after three mutual-disconnect no-contests for an account within the previous rolling 24 hours. The D7 threshold and cooldown have service tests; D5 debounce and both values still need the M4 two-device abuse and network tests before that milestone passes. Their approved behavior and outcomes are not pending product decisions.

The opening-board diagram in the source document uses line breaks within one paragraph. Its five rows are `AA... / AA... / ..... / ...BB / ...BB`; encode that exact fixture in M0 rather than inferring rows from flattened text.

## 11. Data model and integrity constraints

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

## 12. Verification matrix

| Layer | Narrow checks | Failure cases to inject |
| --- | --- | --- |
| Rules unit tests | all §45 pairs, Energy, legality, disconnected nodes, board exhaustion, sudden death, invariant and replay tests | same target, insufficient Energy, duplicate action, reversed receipt order |
| Server integration | command authorization, deadline, fixed reveal, private data, room/queue uniqueness, snapshot/revision recovery | late/duplicate commands, two workers, two tabs, crash before/after result commit |
| Rating integration | exact Elo/K/multiplier/placement/streak, tied ranks, exactly-once ledger | concurrent settlement, transaction retry, zero credit, half-point rounding, RP floor |
| Browser E2E | solo; guest room on two devices; Google invite return; Ranked ready/binding; rematch; desktop/mobile | refresh, disconnect/reconnect, auth cancellation, ready timeout, stale invite |
| Playtest | comprehension, action mix, game length, rematch behavior, side balance separated by human/bot mode | record observations; change only §54 balance variables with before/after evidence |

Maintain a fake-clock match harness so a 5-second human round, ready timeout, 24-hour repeat window, and reconnect grace can be tested without real waits. Run the narrow checks for a milestone before adding broader end-to-end gates. Before release, execute the full §43–45 acceptance checklist against a production-like build and review logs for private-action leakage.

## 13. Release and operations

1. Configure separate development/staging/production environments; store Google credentials, session keys, and invite-token secrets outside the repository. Use HTTPS and authenticated real-time connections. -> **Verify:** staging can complete all three §50 journeys with production-like identity and timing.
2. Add migrations, backup/restore procedure, health checks, and structured logs keyed by match ID. Log state transitions and settlement IDs, not unresolved actions or provider secrets. -> **Verify:** restore a staging backup and replay/inspect a finished match without altering rating.
3. Add alerts or at least operational queries for overdue rounds, expired but unreleased queue leases, stuck shells, unsettled terminal matches, duplicate settlement attempts, and void rate. -> **Verify:** injected stuck/failed jobs appear in the query or alert and can be safely retried.
4. Review privacy and retention for guest sessions, room invites, match history, and telemetry; define deletion/expiry jobs before public launch. -> **Verify:** expired rooms/tokens cease working and cleanup preserves settlement audit data needed for integrity.
5. Run the contest-demo script: alone → bot match → create/join guest match on another device → synchronized reveal → result/rematch → explain Ranked and truthful human leaderboard. -> **Verify:** an unfamiliar reviewer can complete it without creator intervention (§51).

## 14. Definition of complete

The MVP is complete only when all three PRD §50 journeys work end to end, the §43–45 acceptance tests pass, Ranked settlement cannot duplicate or be client-controlled, pending actions and lock timing remain private, the leaderboard contains only eligible humans, and mobile/accessible play is usable. Record any deliberate balance changes separately from the frozen product invariants. If a required backend capability cannot be demonstrated, stop that milestone and replace the design rather than weakening the PRD silently.

## 15. Implementation audit addendum — 2026-10-04

The implementation audit found gaps between the plan and the current code. The following corrections are recorded as implementation requirements; the approved D1–D10 product decisions in §10 remain the source of truth.

| Audit finding | Remediation | Verification |
| --- | --- | --- |
| Solo bot matches always placed the human on side A, and rematches did not consistently swap sides. | Randomize the first human side server-side; swap it on each rematch and support either side across bot turns, deadlines, presence, metrics, and request idempotency. | Test both initial sides, repeated side swaps, bot history, creation-key uniqueness, and metrics. |
| Restarting an active Practice match could leave the old match active. | Create or reuse the replacement and terminally void the source match in one transaction. | Retry the same request and verify one replacement and no active source match. |
| One corrupt or transiently failing due match could stop the worker from processing other matches; retry count alone could misclassify a transient failure. | Isolate each due match. Void only explicitly untrustworthy saved state/actions without competitive effects; retry database failures. | Inject corrupt JSON, invalid state/actions, failed writes, and a healthy neighboring match. |
| Ranked placement responses exposed provisional competitive fields, settlement responses exposed both players, and leaderboard rows omitted required record fields. | Enforce placement privacy in server projections, return only the requesting player's settlement, and include W-L-D and streak in leaderboard entries. | Test pre-placement, fifth-match, post-placement responses and rendered UI; confirm opponent settlement fields are absent. |
| Profile and leaderboard request failures could look like confirmed empty data. | Show loading and error states separately from empty states. | Verify the production build and rendered Ranked component cases. |
| A round reveal stayed modal after the server opened the next timed decision, blocking moves; stale responses could also roll back newer match state. | Keep reveal as an informational panel while play continues, and reject older revisions at the shared snapshot boundary. | Client regressions cover actions during a reveal and monotonic snapshot acceptance; full client and server suites pass. |
| Resolved and terminal matches retained private pending actions and lock timestamps. | Delete resolved-round actions in the result transaction and clear actions on resignation, disconnect expiry, and corrupt-match void. | Server tests confirm round history remains available while pending rows are removed after resolution and resignation. |
| Mobile scrolling could hide the decision timer; Energy results lacked numeric spend/earn feedback and the rival's total. | Keep the match header sticky, show both totals, and report actual energy changes including capped Ambush gains. | Production build passes; CSS and component regressions cover the new display. Browser scroll and human accessibility checks remain open. |
| Malformed percent-encoded invitation paths could throw during render; local SQLite scratch data was not ignored. | Fail closed to the normal route on invalid encoding and ignore `.tmp-storage/`. | Build passes; `git check-ignore .tmp-storage/reveal-repro.sqlite` confirms the local database is excluded. |
| Cookie-authenticated mutations accepted requests with no Origin header. | Require the configured same-origin plus an application request marker on every unsafe HTTP method. | Server regressions reject missing/wrong origins and missing markers; the client regression verifies it sends the marker. |
| SQLite column upgrades had no migration record or transaction boundary. | Record the legacy upgrade as schema migration 1 and apply its conditional column/index changes atomically. | File-backed tests prove existing data survives, repeated opens do not replay the migration, and a failed marker write rolls back and can be retried. |
| Responses lacked a Content Security Policy and a Permissions Policy. | Apply restrictive browser headers to API responses and static files while allowing the Google Identity endpoints used by sign-in. | Header regression verifies the policy, deny-frame header, and disabled device permissions; actual OAuth remains an external release check. |

Local remediation verification on this date: `npm test` passed 159 tests across 21 files, `npm run build` passed, and `git diff --check` passed. Commits `c33bb36`, `2469cd5`, and `3d7e88a` passed both GitHub verify jobs, both container jobs, and GitGuardian. The updated response-header change is awaiting CI. Real OAuth, persistent-host staging and backup restoration, the full two-device acceptance run, human playtest, human screen-reader review, and edge rate limiting remain release gates in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## Technical references for the recommended stack

- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/sql-set-transaction.html) and [row-locking queries](https://www.postgresql.org/docs/current/sql-select.html) inform the atomic-claim/retry design; exact schema and isolation level must be validated in the M0 spike.
- [Google OpenID Connect documentation](https://developers.google.com/identity/openid-connect/openid-connect) informs the server-side identity validation and auth-return-state design.

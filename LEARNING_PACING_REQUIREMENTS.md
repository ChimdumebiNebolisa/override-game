# Learning and round pacing — requirements addendum, 2026-10-11

The owner's implementation brief supersedes the frozen `OVERRIDE_PRD_v0.3.docx` and earlier implementation-plan statements about staged tutorials, five-second new decisions, one-second new transitions, and fixed-deadline privacy. The original PRD is retained as historical input. All other mechanics, authentication, rating, presence, retention and branding requirements continue to apply.

## Persisted policy

| New record | Decision | Resolution | Nonfinal phase |
| --- | --- | --- | --- |
| Explicit learning / default Practice | Untimed | Accepted human Lock | Human-controlled review |
| Timed Practice / Quick bot | 10 seconds | Accepted human Lock or deadline | Human-controlled review |
| Friend / Ranked human PvP | Shared 10 seconds | Both accepted locks or deadline | Shared 3-second reveal |

Policy 2 is assigned explicitly by every production creation path, including fresh restarts and rematches. Selection never commits. Only legal, participant-authorized locks strictly before a timed deadline count. Missing moves become automatic Pass at deadline; manual Pass remains distinct. Pending rival contents, readiness and timestamps are private. Early human reveal necessarily tells both players that both committed.

Bot choices use the immutable public board, revealed history, existing difficulty and seed; current human commitments never enter bot reasoning. The shared rules remain the only mechanics authority: normal opposing four-cell corners, zero starting Energy, cap three, free Expand/Ambush/Pass, two-Energy Override, three-Energy one/two-target Surge, simultaneous collisions, no refunds, 12 standard and up to three sudden-death rounds, board exhaustion and existing terminal outcomes.

Review is active and resumable but has no deadline, automatic advancement, review AFK/disconnect strike or grace expiry. `POST /api/matches/:id/next` is authorized for the bot's human participant and bound to reviewed round, revision and acknowledgement identity. Retries return current state without advancing a later review. New decisions start at actual server time plus the stored duration (or null for untimed). Terminal states never open another round. Human reveal starts at resolution plus three seconds; a late alarm starts a full next decision at processing time. Existing eligible decision/grace rules continue.

Migration 7 adds policy metadata with legacy-safe defaults: policy 1, five-second decision duration, one-second automatic transition. It changes no old state, deadline, pending action or readying-shell policy. Existing rows keep their behavior for their lifetime. Schema defaults intentionally describe legacy; production creation explicitly opts into policy 2. Node and Worker run the same initializer/migration. The acknowledgement table has one identity per match/round and a unique key per match.

## Learning and entry

How to play has exactly Read the rules and Learn with a bot plus normal navigation. Rules remain independently available with diagrams and expandable exceptions. The old six staged lessons and playable scenario sequence are removed; pure static-diagram helpers still call shared validation/resolution.

Home and How to play launch the same ordinary Easy untimed Practice match, with randomized side and normal opening, Energy, bot behavior and length. Direct mode selection remains available. The first generic Start a game click, only without a resume/invitation/readiness flow, shows a compact native modal. Recommended learning, Jump into a duel, Close and Escape handle its versioned browser flag without earning completion. Modal focus is contained and cancellation restores the trigger. No match runs behind the welcome. Active matches require the existing resignation/replace flow before learning or replay.

Inline coaching never disables a normally legal alternative. It distinguishes editable selection, accepted Lock, real outcome and genuine server Next. After a locked Expand and its acknowledged review, the next decision has no tactical hints or target recommendation. Core-loop completion requires that Expand review, a later manual legal move (including Pass), then an explicit acknowledgement of that result with Next or Start a duel. Existing terminal exit/start actions can acknowledge the final result without opening a round. Intercepted/collided legal Expand counts; timeout Pass does not. Skip freezes incomplete progress while keeping the same match. Replay creates a fresh normal match and preserves previously earned completion.

Welcome, core completion and per-match learning run are separate versioned storage records. Refresh, repeated snapshots and lost responses reconcile from authoritative state. Storage failure falls back within the tab; progress cannot survive reload if the browser refuses storage. Power-ups and Energy/collisions have sparse contextual tips and reopenable action details; the static rules cover powers even when a short Easy match does not encounter them.

## Presentation and acceptance

Keep the existing visual identity. Native modal only for entry; gameplay coaching/help is non-modal, works without hover, and never pauses a timed decision. Selected action, Energy/cost/unavailable reason, legal board targets and Lock/Next remain reachable. Results use authoritative actions, cells, territory/Energy totals and deltas, and real success/failure reasons. Review labels the resolved round separately from the next round. Human recap becomes compact when decision opens and cannot block it. Terminal explanation appears directly in the existing result screen.

Verification must use isolated local databases for migration, timeout, races and Ranked fixtures. Check every creation/activation/rematch path and legacy phases; lock/deadline ordering, duplicate snapshots and requests; privacy; durable bot review and authenticated round-bound Next; late alarms; exact learning sequence and flags; fresh/returning entry, static rules, keyboard, narrow/reflow screens, reduced motion and terminal cases. Required commands and evidence are recorded in [LEARNING_PACING_VERIFICATION.md](LEARNING_PACING_VERIFICATION.md). Automated checks do not establish human usability or screen-reader usability. Ten seconds and contextual teaching remain product decisions for future evaluation. Production deployment requires separate owner authorization.

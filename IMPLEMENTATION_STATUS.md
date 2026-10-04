# OVERRIDE implementation status — 2026-10-04

The product requirements are in `OVERRIDE_PRD_v0.3.docx`; `IMPLEMENTATION_PLAN.md` records the approved D1–D10 decisions and the complete acceptance criteria. This status tracks evidence without changing those requirements.

## Verified locally

- Pure 5×5 rules, Energy, simultaneous resolution, bots, match persistence, guest room authorization, Ranked queue/ready/settlement, rematches, and leaderboard service behavior have automated coverage. `npm test` passes 108 tests across 12 files, including deadline ordering and a two-connection action-lock race.
- Room and bot match creation use persisted request IDs so a retried request returns the original resource. A copy of the existing local SQLite database migrated to the new columns and indexes successfully.
- TypeScript and the production Vite build pass with `npm run build`.
- Two independent browser sessions joined a Quick Duel room. Reloading the host restored the open room with the original code; reloading during a newly joined match returned to the match screen. A solo Practice match and responsive views were exercised earlier in the local browser.
- A local two-session HTTP check completed all 15 Quick Duel rounds with fixed-deadline Pass actions, reached a draw, and started a rematch with swapped sides. This used synthetic guest sessions and is not human playtest evidence.
- A synthetic two-account browser check created a Ranked challenge, showed the creator's Ready prompt when the invitee accepted, and opened the same bound game for both players. This bypassed Google only for the local fixture; it does not verify real OAuth.
- In the production build, the same synthetic two-account flow ended by immediate resignation. Both browsers reached the correct result screens and showed complementary RP changes from one settlement. This check also exercised the race where settlement releases queue ownership before one client polls the active state.
- Refreshing the challenge creator before invite acceptance restored the same invitation link; acceptance then showed Ready on both browsers and proceeded to a bound match.
- The human leaderboard and Around You section were opened at 390 px and 320 px. The mobile navigation kept the Leaderboard link visible, and the document width matched the viewport without horizontal overflow.
- A file-backed restart test leaves a terminal Ranked match unsettled, reopens the database, and verifies one settlement and released ownership. Startup also reconciles lost WebSocket presence before overdue rounds resolve.
- `npm run report:metrics`, `npm run ops:status`, and `npm run backup:db` run against the local database. The backup command checks SQLite integrity, and a copy was opened successfully at a fresh restore path. Local metrics contain test traffic and are not playtest conclusions.

## Implementation follow-ups

- Confirm socket presence when a human match starts and when a player switches between room and match channels, so an absent player receives disconnect grace rather than a connected AFK strike.
- Finish keyboard focus handling for the reveal and resignation overlays, and check the board's announced structure with a screen reader.

## Release gates still open

1. Run the [structured human playtest](PLAYTEST_PROTOCOL.md) in plan M1/PRD §40–41 with competent pairs and a first-time player. Record comprehension, action choices, Ambush success, game length, side results, voluntary rematches, and a go/tune/stop decision.
2. Configure a Google OAuth Web client ID for the real public origin. Verify two distinct real accounts, sign-in return to a challenge, ready/binding, settlement, rematch, and leaderboard placement on desktop and mobile.
3. Deploy one server process with HTTPS and persistent SQLite storage to a production-like staging environment. Rehearse backup restoration there, then run the complete PRD §43–45 checks and an unfamiliar-reviewer demo across two devices.
4. Review traffic limits and the 30-day guest retention policy against the chosen host and expected launch volume. Add an edge rate limit before public access.

No public-launch or human-playtest claim is made by the local checks above.

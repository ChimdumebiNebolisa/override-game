# Product decisions

This records owner-approved behavior and its rationale. It is a decision record, not a release status page; the current implementation and tests determine runtime behavior. Superseded plans and audit snapshots remain in Git history.

## Ranked and game rules — approved 2026-10-04

| ID | Decision |
| --- | --- |
| D1 | When a placement player's same-opponent limit is exhausted, both players can finish the match but receive zero competitive credit. |
| D2 | Round signed, adjusted Elo half-points away from zero, then clamp RP at zero. |
| D3 | Reject an invalid Lock without consuming it. A player may retry until the deadline; an omitted move becomes automatic Pass. |
| D4 | A third consecutive connected missed deadline resolves that round as automatic Pass, then ends the match as a forfeit. |
| D5 | Confirm disconnect after a 1.5-second debounce; count one episode until reconnection rather than every socket flap. |
| D6 | Freeze repeat-match credit when the Ranked shell is created, using prior binding matches started in the preceding rolling 24 hours; exclude voided and cancelled shells. |
| D7 | Mutual disconnect at grace expiry is no contest and awards no competitive credit. Three such incidents in 24 hours start a 15-minute Ranked queue cooldown. |
| D8 | Show competitive credit before Ready without revealing the opponent's identity or rating. |
| D9 | Allow one successful handle rename per 30 days after initial selection. Handles are 3–16 alphanumeric/underscore characters, case-insensitively unique, and screened for profanity. |
| D10 | Same-cell opposing Overrides are unreachable under the current legal target rules; keep those action domains unchanged. |

## Authentication — approved 2026-10-04, updated 2026-10-10

Use Firebase Authentication for Google sign-in. Node and Worker verify Firebase ID tokens against public signing certificates and allow only the Google provider. Keep opaque game sessions, authoritative services, WebSockets, and SQLite profiles. Do not move game state to Firestore. Deployed hosts and same-origin callbacks require Firebase/Google allowlisting; real-account sign-in still needs hands-on verification.

## Hosting — updated 2026-10-10

Keep Firebase on Spark and use the existing Workers Paid account for the isolated staging Worker and Durable Object. Do not add a custom domain or another paid host. Usage above included allowances may incur charges; budget notifications and application admission estimates are not account-level spending caps.

## Learning and round pacing — approved 2026-10-11

Teach the core loop in an ordinary Easy untimed Practice match, with an optional first-start welcome and a static rules reference. New timed decisions last ten seconds. Bot review waits for human Next; human rounds resolve after both accepted locks or the deadline and share a three-second reveal. Existing matches retain their stored timing policy. The learning and pacing implementation was subsequently authorized for production deployment; the original implementation-only authorization is historical.

## Rated Hard bot — approved 2026-10-12

A signed-in player with a public handle may earn RP and placement credit in new timed Hard Quick Duels. Score against a fixed 1000-RP bot at 50% credit for the first three qualifying starts per rolling 24 hours, 37.5% for the fourth, 25% for the fifth, and 0% thereafter; voided starts do not count. Freeze credit at creation. Reduced-credit bot games advance placements and rated-match count without changing W-L-D or streak. The 1000-RP value is a conservative scoring benchmark, not measured human Elo.

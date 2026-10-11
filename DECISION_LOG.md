# OVERRIDE Product Decision Approval

**Recorded:** 2026-10-04
**Approver:** Product owner  
**Status:** Approved

The product owner reviewed the recommendations presented for decisions D1–D10 and gave explicit sign-off on the complete set. Record all ten as approved product decisions and implement them as specified in [IMPLEMENTATION_PLAN.md, §10](IMPLEMENTATION_PLAN.md#10-approved-rule-clarifications).

This approval covers the ten decisions in that section: placement repeat credit, Elo rounding, invalid locks, third connected missed deadline, disconnect episodes, repeat-match assessment timing, mutual disconnect outcomes, pre-ready credit notice privacy, handle rename rules, and same-cell Override legality. The implementation tuning recorded immediately after the table (including the disconnect debounce and Ranked cooldown) is included in the approved behavior.

The implementation plan remains the detailed source for exact behavior, milestone placement, and verification criteria. Any change to an approved decision should be recorded there with a new product-owner decision.

## D11 — Authentication provider

**Recorded:** 2026-10-04
**Decision (updated 2026-10-10):** Use Firebase Authentication for Google sign-in. The web SDK obtains Firebase ID tokens; both Node and Worker verify them with JOSE against Firebase Secure Token public signing certificates while allowing only the Google provider. Keep the existing opaque game sessions, authoritative game services, WebSocket transport, and SQLite profiles; this decision does not migrate game data to Firestore or Firebase Realtime Database.
**Approval:** The product owner directed the implementation to proceed with this switch after reviewing Firebase Auth as the alternative to direct Google OAuth integration.
**Operational requirements:** Enable Google as a Firebase Authentication provider, authorize deployed origins and their same-origin OAuth callback URIs, and provide public web-app config. No Firebase Admin service-account credential is required. The earlier custom game-session nonce design is superseded by the Firebase SDK redirect flow and server verification of the signed token; its unused nullable migration columns remain for compatibility. Verify real sign-in with two distinct accounts in staging before release. Use four real Google accounts, playing two matches per pair, for complete placement/leaderboard verification.

## D12 — Hosting plan

**Recorded:** 2026-10-04; staging tier updated 2026-10-10
**Decision:** Keep Firebase on Spark. Use the existing Workers Paid account for the isolated staging Worker and its SQLite-backed Durable Object. The owner selected Paid rather than Free for staging. Do not provision Render, add paid products, or configure a custom domain.
**Reason:** Workers Paid is the selected staging tier. Usage beyond included allowances may be billed; budget alerts and application guardrails do not impose an account-level spend cap. This staging decision does not guarantee zero spend. Production cost requirements remain subject to review before launch.
**Implementation consequence:** Worker assets/API, SQLite storage, WebSockets, alarms, and Firebase public-certificate token verification are implemented. The isolated staging environment is deployed. Complete Firebase/Google allowlisting, real-account journeys, cloud recovery, device checks, and the human playtest before public release.

## D13 — Learning and round pacing

**Recorded:** 2026-10-11
**Authorization:** The owner directed implementation and isolated verification in the supplied learning/pacing brief. Production deployment was not authorized.
**Decision:** Teach the core loop inside an ordinary Easy untimed Practice match; use one optional first-start welcome and a static rules reference. New timed decisions last ten seconds. Bot results wait for participant-authorized Next; human rounds resolve after both accepted locks or the deadline and share a three-second reveal. Early human reveal communicates both commitments; pending contents and rival readiness remain private.
**Compatibility:** Migration 7 preserves all existing records as policy 1 (five-second decisions, one-second automatic transition and fixed-deadline human resolution). Fresh records, restarts and rematches explicitly select policy 2. Existing Ranked shells activate using their stored policy.
**Evidence limit:** Ten seconds and contextual coaching are product choices to evaluate in a future novice test, not proven improvements. See [requirements](LEARNING_PACING_REQUIREMENTS.md) and [verification/handoff](LEARNING_PACING_VERIFICATION.md).

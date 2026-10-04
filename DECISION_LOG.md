# OVERRIDE Product Decision Approval

**Recorded:** 2026-10-04  
**Approver:** Product owner  
**Status:** Approved

The product owner reviewed the recommendations presented for decisions D1–D10 and gave explicit sign-off on the complete set. Record all ten as approved product decisions and implement them as specified in [IMPLEMENTATION_PLAN.md, §10](IMPLEMENTATION_PLAN.md#10-approved-rule-clarifications).

This approval covers the ten decisions in that section: placement repeat credit, Elo rounding, invalid locks, third connected missed deadline, disconnect episodes, repeat-match assessment timing, mutual disconnect outcomes, pre-ready credit notice privacy, handle rename rules, and same-cell Override legality. The implementation tuning recorded immediately after the table (including the disconnect debounce and Ranked cooldown) is included in the approved behavior.

The implementation plan remains the detailed source for exact behavior, milestone placement, and verification criteria. Any change to an approved decision should be recorded there with a new product-owner decision.

## D11 — Authentication provider

**Recorded:** 2026-10-04
**Decision:** Use Firebase Authentication for Google sign-in. The web SDK obtains Firebase ID tokens, and the Node server verifies them with Firebase Admin while allowing only the Google provider. Keep the existing opaque game sessions, authoritative game services, WebSocket transport, and SQLite profiles; this decision does not migrate game data to Firestore or Firebase Realtime Database.
**Approval:** The product owner directed the implementation to proceed with this switch after reviewing Firebase Auth as the alternative to direct Google OAuth integration.
**Operational requirements:** Enable Google as a Firebase Authentication provider, authorize deployed origins, provide public web-app config, and keep Firebase Admin credentials server-side. Verify real sign-in with two distinct accounts in staging before release.

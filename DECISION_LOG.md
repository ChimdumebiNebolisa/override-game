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

## D12 — Zero-spend hosting

**Recorded:** 2026-10-04
**Decision:** Keep Firebase on the Spark plan and use the Cloudflare Workers $5 monthly plan that the owner says is covered by their student account. Use Worker assets/API plus one SQLite-backed Durable Object for authoritative state, WebSockets, and deadline alarms. Do not provision Render or enable other paid products, add-ons, domains, or billing accounts.
**Reason:** Render's Blueprint requires a paid service and persistent disk. The owner's existing student benefit covers the base Workers plan, but Cloudflare documents usage charges beyond included monthly allowances. Application guardrails cannot guarantee a hard account-level spending cap under every traffic pattern.
**Implementation consequence:** The Worker entry point, static asset routing, SQLite Durable Object adapter, WebSocket handling, alarms, and Firebase public-certificate token verification are implemented. Keep game rules and user-visible behavior unchanged. App-level usage guardrails reduce usage. Verify the owner's student coverage and billing controls before public deployment; if a hard no-overage requirement cannot be met, use Workers Free.

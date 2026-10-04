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

## D12 — Zero-spend hosting

**Recorded:** 2026-10-04
**Decision:** Keep Firebase on the Spark plan and use the Cloudflare Workers $5 monthly plan that the owner says is covered by their student account. Use Worker assets/API plus one SQLite-backed Durable Object for authoritative state, WebSockets, and deadline alarms. Do not provision Render or enable other paid products, add-ons, domains, or billing accounts.
**Reason:** Render's Blueprint requires a paid service and persistent disk. The owner's existing student benefit covers the base Workers plan, but Cloudflare documents usage charges beyond included monthly allowances. A deployment must stay within the covered allowance and stop before any overage.
**Implementation consequence:** This is a hosting target, not a claim that the current Node server is already ported. Replace Node-only HTTP/WebSocket/SQLite adapters with Worker routing and a Durable Object SQL adapter. Verify Firebase ID tokens against Google's public Firebase token signing certificates in the Worker so deployment does not need a persistent Firebase Admin private key. Keep game rules and user-visible behavior unchanged. Add a conservative, fail-closed usage ceiling below the plan's included request, compute, and storage quotas. Verify the owner's student coverage is active before provisioning; if a no-overage ceiling cannot be enforced, use Workers Free instead.

# OVERRIDE audit and remediation — current main

**Conclusion:** The audit confirmed two product-recovery defects and an outdated requirements paragraph. The corrections preserve the confirmed gameplay rules and existing visual identity. This assessment does not certify competitive balance, every source line, or every browser/device.

Audited on 2026-10-11, America/Chicago, from `main` revision `b905005d7f49f90e5b95751022aa342e229f5cbe`. The tracked tree was initially clean; the existing untracked `output/` directory was preserved. The user explicitly authorized implementation, pushing to main, and deployment. Local failure probes used disposable databases and isolated Chromium contexts.

## Confirmed findings and fixes

### MA01 — Medium: lost friend-room responses allow the request to change

**Confidence: Reproduced.** At the baseline, `src/client/App.tsx:1017` (`RoomScreen.submit`) retained a creation key, but `:1022` generated another key when the display name changed. Name, code, and Create/Join controls remained editable after the server accepted a request whose response was lost. Both create and join regressions reproduced this condition.

**Impact:** A retry can represent a different room rather than recovering the accepted operation. Creation can leave additional open rooms behind; changing the join code can strand an already accepted match. The server's idempotent creation handling (`server/rooms.ts:72`) protects identical retries, not changed requests.

**Correction:** Freeze the original name, room code, and tab while submitting or reconciling an uncertain response. Keep the original creation identity and show “Retry to recover this same room.” Definite failures permit editing again. No server or schema changes were needed.

**Acceptance:** After an accepted response is dropped, retry recovers the original room/name, with exactly one record for the creation identity. A dropped join response recovers the same match for both participants. Both cases have dedicated browser regressions. Effort: small, independent client change.

### MA02 — Medium: invite copying fails without recovery or confirmation

**Confidence: Reproduced.** Baseline `src/client/App.tsx:1047` called `navigator.clipboard.writeText` without handling rejection. The same pattern appeared in Ranked challenge link/code controls (`:1254`) and Ranked rematches (`:973`). Denial probes at 1440, 390, and 320px produced uncaught browser errors and no fallback. A successful-copy probe found no status announcement.

**Impact:** A visitor can be unable to share an invite when clipboard access is denied. A successful copy has no visible or assistive-technology confirmation.

**Correction:** A small shared CopyButton handles pending, successful, and failed copying at every callsite. Success announces the copied item. Failure exposes the original link/code in a labelled read-only field that selects its contents on focus. The fallback wraps within the existing layout and does not change invite generation or authorization.

**Acceptance:** Denied clipboard writes show the correct selectable link, create no uncaught errors, and cause no horizontal overflow at the three tested widths. Successful copying writes the correct link and announces completion. Effort: small shared interaction change; no dependency added.

### MA03 — Low: current requirements still specify superseded Energy rules

**Confidence: Source-confirmed.** Baseline `LEARNING_PACING_REQUIREMENTS.md:15` stated zero starting Energy, cap three, and free Ambush without the new miss penalty. The paragraph presented itself as the current mechanics authority, despite the owner's implemented replacement rules.

**Impact:** A future implementation or review could restore obsolete mechanics or judge the deployed product against the wrong contract.

**Correction:** Update that paragraph and README's product boundaries with full 5/5 starts, Expand +0.5, Ambush's minimum/reward/drain/penalty, unchanged Surge/Override costs, half-unit balances, and saved-game compatibility. Clarify that legacy timing policy remains stored while subsequent rounds use the revised Energy rules. Historical reports and the frozen PRD remain historical inputs.

**Acceptance:** Current requirements agree with `src/shared/rules.ts`, `server/matches.ts`, and the guide. Effort: small documentation correction.

## Verification

| Check | Observed result | Scope |
|---|---|---|
| Baseline `npm test` | 344 passed in 32 files; exit 0 | Existing rules, authentication, privacy, persistence, timing, recovery, and Worker-adapter regressions |
| `npm audit --json` | Zero reported vulnerabilities; exit 0 | Current npm advisory snapshot, including development dependencies; not a security certification |
| Baseline `npm run test:browser` with six new probes | Existing 39 checks passed; all six new recovery/copy checks failed; exit 1 | Reproduces MA01 and MA02 against the unchanged baseline client assets |
| Post-fix `npm test` | 344 passed in 32 files; exit 0 | Fresh complete run after the source corrections |
| Post-fix `npm run build` | Type checking and Vite build passed; exit 0 | Client and server types; production client assets |
| Post-fix `npm run test:browser` | All 45 checks passed; exit 0 | Six audit regressions now pass; the original 39 gameplay, privacy, recovery, keyboard, and responsive checks remain green. Fallback screenshots inspected at 1440 and 320px. |

Browser evidence is saved under `output/mitch-recovery-audit-2026-10-11/`. That existing local evidence directory is not committed. The audit report, source changes, requirements, and regression additions are committed together after verification. Main synchronization, CI, Cloudflare deployment, and live checks are recorded in the delivery response.

## Coverage and remaining limits

| Area | Coverage | Evidence and limits |
|---|---|---|
| Gameplay and product logic | Investigated | Shared opening, affordability, exact Ambush targeting, simultaneous resolution, capped fractional rewards, drains, terminal results, guide, and existing rules tests. No rule changes were justified by this pass. Human competitive balance is unmeasured. |
| UX and responsive layout | Investigated on selected journeys | Entry, learning, action selection, review, completion, friend creation/joining, retry, and copy recovery; desktop, mobile, and breakpoint regressions. Actual screen-reader output and physical-device use were not tested. |
| Authentication and authorization | Partially investigated | Firebase signature/issuer/audience/provider verification; opaque session handling; participant checks; mutation origin checks; private pending actions; corresponding automated tests. Real Google-account redirect/sign-in was not exercised. |
| Data integrity and architecture | Partially investigated | Shared Node/Worker services, SQLite transactions, idempotent creation/locks, retained saved caps, half-unit validation, migration and Worker-adapter tests. No production database writes were used to reproduce failures. No whole-repository architectural rewrite was warranted. |
| Operations and delivery | Partially investigated | Existing Cloudflare deployment, CI, health, retention, admission, and protected recovery paths inspected. Actual platform point-in-time restore and large-scale load were not exercised. |
| Dependencies and exposed data | Partially investigated | npm advisory audit; tracked environment/private-key filename checks; unsafe HTML/eval search; selected auth and data-access source review. Firebase web configuration is public client configuration, not an exposed server credential. Full Git-history secret scanning was not performed. |
| Documentation and tests | Investigated on current contracts | MA03 corrected; historical documents retained. Six new browser checks were proven to fail before the client fix. |
| Payments, LLM integration, native mobile | Not applicable | These are not implemented product paths. |

The installed mitch-audit skill contains its main workflow and UX-synthesis reference, but the other referenced domain/adversarial/report-format files are absent. The audit followed the available workflow, direct source/runtime checks, and relevant vibe-security references; missing checklists were not fabricated. StyleSeed-specific artifacts were not present, so accessibility was assessed directly rather than claiming a StyleSeed or screen-reader pass.

The adversarial pass tested accepted-but-lost create/join responses and clipboard rejection, then revisited stale/duplicate locks, reload reconciliation, no-contest/void recovery, automatic human progression, half-unit persistence, and participant authorization through source and existing regressions. No new confirmed Critical or High finding emerged in the inspected paths; that conclusion is bounded by the coverage above.

Remaining work needs external evidence rather than speculative code changes: real-account Google sign-in, physical mobile interruption, screen-reader navigation, and human playtesting of the new Energy economy and bot difficulty.

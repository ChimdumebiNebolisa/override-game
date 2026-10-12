# OVERRIDE — product logic and visual arrangement audit

Historical baseline: remediation is recorded in [AUDIT_FIXES_2026-10-11.md](AUDIT_FIXES_2026-10-11.md).

**Verdict:** The game rules and core learning loop are coherent. The interface has a distinct tactical identity, but its arrangement does not consistently support the current task. Timed mobile play requires repeated scrolling, the learning handoff is buried, and desktop board information uses inconsistent alignment frames. Fix those flows and the newly reproduced creation-retry defect before spending effort on decoration or changing the rules.

This audit extends the [engineering audit](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/AUDIT_REPORT_2026-10-11_MAIN.md>) at the same `main` revision, `f839f550bdba8e82d38ceed453285547462c6dd1`. It is audit-only: no application code, styles, dependencies, branches, or deployment were changed. Source review, rendered measurements, and design judgment are distinguished below. Findings describe verified interface conditions; human comprehension, enjoyment, retention, and abandonment were not measured.

## Product logic

The player's job is to finish with more territory while predicting a hidden opposing move. The core decisions have meaningful tradeoffs:

| Action | Implemented rule | Product implication |
|---|---|---|
| Expand | Free; claims one adjacent empty space | The straightforward way to increase territory. |
| Ambush | Free; predicts a rival Expand's exact empty target, blocks it, and earns 1 Energy up to 3; captures nothing | The player gives up immediate expansion to deny a rival claim and build future options. A miss earns nothing. |
| Override | Costs 2; steals one adjacent rival space | One steal changes the territory margin by two: yours +1, rival −1. |
| Surge | Costs 3 total; claims or steals one or two distinct targets within two grid steps of pre-round territory | Two steals can change the margin by four. Each target resolves separately; collisions do not refund the cost. |
| Pass | Free; no target; takes no territory | A deliberate commitment. An absent timed commitment becomes an automatic Pass and has different AFK/learning consequences. |

Evidence: `src/shared/rules.ts:86`, `src/shared/rules.ts:122`, `src/shared/rules.ts:181`, `src/shared/rules.ts:210`. Rules copy in `src/client/HowTo.tsx` and `ActionDetails` in `src/client/App.tsx:129` matches these mechanics in the reviewed cases. **Only a successful Ambush generates Energy.** Expand, Override, Surge, and Pass do not generate it.

Both players choose from the same pre-round board. The resolver does not let the first resolved capture extend the other target's reach. It distinguishes collisions, intercepted Expands, successful steals, and Energy spent/earned. The opening gives each side four spaces and zero Energy. Standard play lasts 12 rounds; a tie can extend through three sudden-death rounds, ending when a lead appears or at a draw. Board exhaustion and forfeits are separate terminal paths (`src/shared/rules.ts:172`, `src/shared/rules.ts:238`).

The bot's selection function receives public board state, revealed history, difficulty, and a seed (`src/shared/bots.ts:23`). The server invokes it after the human locks, but its inspected selection path does not read that pending human action (`server/matches.ts:223`). The UI's claim that the bot uses public pre-round information is supported by this source path. The difficulty labels describe heuristics; their calibration against human skill is unverified.

Learning intentionally teaches the commitment/review loop rather than every strategy: manually lock an Expand, acknowledge the result, independently lock a later legal action, then acknowledge that review. A manual Pass qualifies for the independent step; an automatic Pass does not (`src/client/learning.ts:53`, `src/client/learning.ts:70`). That is consistent with the implemented core-loop objective and is not a rules bug. It also means completing this introduction does **not** establish that a player understands Energy, Ambush prediction, or two-target Surge.

New Practice is untimed unless selected otherwise. Quick bot is timed, but both bot modes persist in review until Next round. Human matches use a shared reveal and automatic next round. `server/match-policy.ts:2` defines the new ten-second decision and three-second human reveal policy. These differences need to remain visible in the interface; a layout improvement should preserve them.

No scoring or action-cost contradiction was found in the source paths and 88 focused tests exercised in this pass. This is not proof of competitive balance. The value of Ambush, energy saving, first-side advantage, and difficulty calibration needs human playtesting and outcome data before changing mechanics.

## Journey assessment

| Stage | What works | Main concern |
|---|---|---|
| Entry | Start a game is clear; learning and guest play are available without an account | The advanced final-round demo precedes mode selection, and the full-height desktop hero creates substantial empty space. |
| Mode selection | Difficulty and optional Practice timer are explicit | Creation failures can leave options editable while the retry key belongs to a different intent (PV01). The friend divider is malformed (PV06). |
| Learning decision | Legal targets, selection versus Lock, untimed mode, and skip control are explicit | Coaching is below the board on mobile. Action meanings and unavailable reasons disappear (PV03). |
| Timed decision | Deadline and accepted Lock state are visible; server validates actions | Action → target → Lock crosses multiple scroll positions on a small phone (PV02). |
| Review | Both moves, territorial changes, and Energy changes are available; Next does not race an invisible bot timer | The inactive move editor remains present with “Choose an action” and disabled Lock (PV04). |
| Learning handoff | Continue Practice and Start a duel exist | Start a duel is inside coaching below the review and board, rather than beside the acknowledgment choice (PV04). |
| Result / recovery | Results and replay actions exist; safe voiding prevents untrusted state continuing | The previous audit reproduced voided Rematch failure and guest ownership loss. These still take priority over visual polish. |

The experience is strongest at explaining a resolved move. It is weaker at explaining an unavailable action and moving the player from one phase to the next. An expert can work around the layout by scrolling and using rules help; a first-time or distracted mobile player has to remember information across separate screen regions. That cognitive burden is a design inference supported by the measured arrangement, not an observed user-study result.

## Verification and coverage

| Method | Result | Limits |
|---|---|---|
| Fresh isolated local server and Chromium inspection | **27 rendered states** captured; no horizontal overflow in those states; no uncaught client errors | Local fixtures, Windows fonts, Chromium, reduced-motion preference; not physical mobile hardware or every browser. |
| Viewport/breakpoint sampling | Home at 1440×900, 1280×720, 1101×720, 1100×720, 901×640, 900×640, 768×1024, 390×844, 320×568; learning at five sizes; Quick selection/decision at three sizes | Width/height sampling, not actual browser zoom. |
| Targeted second pass | Confirmed fixed-CTA overlap at maximum scroll on 390/320 widths; completed timed Ambush → target → Lock while recording scroll changes | Fast automated interaction proves reachability, not comfortable human performance within ten seconds. |
| Actual API creation-response loss | First creation persisted with 201; changing Practice timer and retrying produced 409 | Response was deliberately dropped only in the disposable fixture. |
| Focused Vitest command | **88 tests passed across six files**, exit 0 | Rules, bots, hero demo, learning, guide scenarios, and HowTo. Does not cover every API/Ranked path. |
| Impeccable context and deterministic detector | Context loaded; scan of App, HowTo, GameBoard, HeroDemo returned `[]`, exit 0 | Mechanical detector did not identify the measured layout and flow failures. No browser overlay was injected. |
| Previous audit at this exact revision | 302-test full-suite recheck, 28 browser regressions, build and dependency audit passed; production asset comparison passed | Earlier checks in this session, not rerun or broadened here. See the engineering report for the initial test timing failures and production limits. |

Evidence is under `output/audit-product-visual-2026-10-11/`: `geometry-and-flows.json`, `targeted-checks.json`, `product-logic-tests.log`, `detector.json`, probe scripts/logs, and screenshots. Temporary fixture databases and servers were cleaned up. Main commands:

```text
node --import tsx output/audit-product-visual-2026-10-11/product-visual-probes.mjs
node --import tsx output/audit-product-visual-2026-10-11/product-visual-probes.mjs --targeted
npx vitest run src/shared/rules.test.ts src/shared/bots.test.ts src/client/hero-demo.test.tsx src/client/learning.test.ts src/client/guide-scenarios.test.ts src/client/HowTo.test.tsx
```

## Findings

| ID | Severity | Confidence | Priority / effort |
|---|---|---|---|
| PV01 — creation retry reuses a key after the timer intent changes | Medium | Reproduced | P1 / Small–Medium |
| PV02 — timed decision controls require repeated mobile scrolling; breakpoint change is abrupt | Medium | Reproduced | P1 / Medium |
| PV03 — mobile hides action meaning and unavailability reasons | Medium | Reproduced | P2 / Small |
| PV04 — review retains an inactive editor and buries the learning handoff | Medium | Reproduced | P2 / Medium |
| PV05 — board labels and Energy bar do not share the board's alignment frame | Low | Reproduced | P2 / Small |
| PV06 — friend divider wraps its trailing rule onto another row | Low | Reproduced | P3 / Small |
| PV07 — fixed mobile CTA obscures the last mode card at maximum scroll | Low | Reproduced | P2 / Small |

### PV01 — Practice creation retry conflicts with changed timer selection

`ModeSelect` retains a creation key based only on difficulty (`src/client/App.tsx:269`, `src/client/App.tsx:273`), while `timedPractice` is a separately editable option (`src/client/App.tsx:295`). The backend correctly treats the timed flag as part of the idempotent request's identity (`server/matches.ts:173`).

**Observed:** The fixture allowed an untimed Practice creation to persist, then dropped its response. The UI stayed on selection with an error. Checking the timer and clicking Play again sent the same key with `timed: true`, received **409**, and displayed “Creation key was used for another bot match.” The existing game remained untimed. Changing the visible selection did not produce the requested mode.

**Impact:** A realistic network failure turns a reasonable retry into an internal-key error with no reconciliation guidance. Options also remain editable while creation is pending, which can make the visible selection diverge from the submitted request.

**Fix / validation:** Reconcile an uncertain accepted creation before allowing its intent to change. Associate the retry key with the complete submitted configuration; preserve it for identical retries. Prevent pending option edits from implying that the in-flight game has changed. Test lost accepted response → identical retry, timer change, difficulty change, and reload/resume. Do not weaken the server's key-consistency check or merely create duplicate games to suppress the error.

Screenshot: `practice-retry-timer-conflict-390x844.png`; reproduction record: `practice-retry-intent-conflict` in `geometry-and-flows.json`.

### PV02 — action, target, and Lock are separated during timed play

The board precedes the move panel (`src/client/App.tsx:611`, `src/client/App.tsx:627`). Below 901 px, `.game-layout` becomes one column (`src/client/styles.css:632`). The controls have no compact task frame that keeps action selection, board selection, and commitment together.

**Observed:** At **320×568**, Quick Duel's action grid starts at **y=620** and Lock ends at **y=984**. Both are below the initial screen while a ten-second timer runs. Actual clicking changed scroll offsets **0 → 369** for Ambush, **369 → 0** for its target, and **0 → 488** for Lock. The request succeeded with 200 and reached review, proving the controls are reachable; the finding is avoidable scrolling under time pressure.

The breakpoint adds a second problem: at **901×640**, the learning board is **260 px** wide and the page **892 px** tall. At **900×640**, it becomes **580 px** wide and the page **1,695 px** tall; Lock moves from ending at **y=765** to **y=1,535**. One pixel of width changes the composition substantially. Sources: height-limited desktop grid at `src/client/styles.css:449` versus stacked board frame at `src/client/styles.css:633`.

**Fix / validation:** Design a compact decision layout around the complete action → target → Lock task. Keep current action, deadline, and commitment reachable near the board; use available width and height when sizing the board. Preserve all five actions, editability before Lock, and the server timer. Verify at 320×568, 390×844, 900/901×640, and short landscape sizes that switching actions and committing a target does not require the measured back-and-forth. Sticky controls must not cover targets or focus.

![Timed Quick Duel at 320×568: the action grid and Lock are below the first screen.](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/output/audit-product-visual-2026-10-11/quick-decision-320x568.png>)

### PV03 — narrow action cards remove the explanation precisely when it is needed

The UI generates useful copy such as “Predict their Expand,” “Need 3 more Energy,” and “No legal target” (`src/client/App.tsx:649`). At widths up to 600 px, `.action-grid button small { display:none; }` removes every one of these explanations (`src/client/styles.css:680`).

**Observed:** On 390 and 320 px screens, all five action subtitles had computed `display: none`. At zero Energy, Surge and Override appear gray with only their small cost badges. Ambush appears available without explaining its predictive purpose or Energy reward. The earning rule exists in the collapsed “Action costs and rules” disclosure; on 320×568 timed Quick, that disclosure starts around **y=896** and explicitly does not pause the clock.

**Impact:** The UI communicates that paid actions are unavailable but omits the generated reason and the route to earning Energy. A player must recall rules or open help away from the board while timed play continues. This is a verified information-removal condition and a product-comprehension risk; no human failure rate was measured.

**Fix / validation:** Keep a short visible reason for unavailable actions and explain “Earn Energy with a successful Ambush” near the Energy display or action choice. Give the selected action a concise visible explanation on mobile. Keep full rules available without turning a compact decision into a long reference page. Validate zero Energy, sufficient Energy/no legal target, available Surge, and independent learning on 320/390 widths; ensure explanations remain in the accessible name or description where appropriate.

### PV04 — review uses decision-stage arrangement and hides the learning transition

The reveal is rendered above `.game-layout`, but the same move editor remains below it with the unconditional “Choose an action” heading and disabled Lock (`src/client/App.tsx:602`, `src/client/App.tsx:635`, `src/client/App.tsx:663`). The qualifying learning-to-duel choice is inside `.learning-coach` in that lower move panel (`src/client/App.tsx:575`, `src/client/App.tsx:632`).

**Observed:** At **390×844**, a first learning review is **1,882 px** tall. Five disabled action buttons remain beneath the result and board. During the later qualifying core-loop review, Next is at **y=559**, but the coaching container offering Start a duel begins at **y=1,109**. The transition choice is separated from the result acknowledgment by the full board. At 320×568, the first review's Next button begins at **y=596** with expanded result details. Details can be collapsed; this is a workaround, not a missing continuation API.

**Impact:** Review says “Choose an action” when choosing is unavailable, uses space for inactive inputs, and gives continuation greater visibility than the promised learning-to-duel choice. The player can continue, but the phase and next decision require unnecessary interpretation and scrolling.

**Fix / validation:** Give review its own hierarchy: revealed moves and concise score/Energy changes, inspectable board, and the current continuation choice. Collapse or replace the inactive editor. Put Continue Practice and Start a duel with the qualifying review acknowledgment, keeping any required resignation confirmation and authoritative completion tracking. Inspect ordinary review, qualifying learning review, next pending/error, automatic human reveal, and terminal result at 320/390 widths. Do not add automatic bot progression as a visual fix.

Evidence: `learning-review-390x844.png` and `learning-core-loop-completed-390x844.png`. The latter filename denotes the qualifying review; the implementation's completion flag is finalized only after its acknowledgment. It was captured at a nonzero scroll position, so the full-page screenshot includes the sticky header at that viewport position; that capture behavior is not a separate layout defect.

### PV05 — desktop board information uses a wider alignment frame

The panel can remain 650 px wide (`src/client/styles.css:228`), while the board alone is constrained by window height and centered (`src/client/styles.css:420`). Labels and Energy retain margins relative to the wider panel (`src/client/styles.css:229`, `src/client/styles.css:260`).

**Observed:** At **1440×900**, the outer board grid is **490 px**, but the panel is **650 px** and Energy bar **620 px**. The first playable cell begins at **x=259**; the Energy bar begins at **x=179**. The bar extends **80 px** beyond the playable cell field on each side. At 901×640, the overhang grows to approximately **119 px** per side. This comparison excludes the grid's row-axis gutter.

**Impact:** The board title, status, and resource strip appear detached from the game surface, while large side gaps emphasize the mismatch. This is alignment quality, not incorrect resource values.

**Fix / validation:** Size the board information frame once so the title/status, grid, and Energy strip share deliberate edges, accounting explicitly for the axis gutter. Avoid correcting each item with additional hard-coded offsets. Verify those edges at tall, short, and breakpoint desktop sizes and retain adequate resource-label space.

![At 901×640, the small board is centered inside a much wider label and Energy frame; the control panel also exceeds the viewport height.](<C:/Users/Chimdumebi/Documents/ChatGPT/override game/output/audit-product-visual-2026-10-11/learning-decision-901x640.png>)

### PV06 — the friend separator has four items in a three-column grid

`.friend-entry` defines three columns (`src/client/styles.css:191`) but contains `::before`, “or,” the friend button, and `::after` (`src/client/styles.css:192`, `src/client/App.tsx:301`).

**Observed:** The browser computes rows of **52 px and 1 px**. The friend button occupies the right column, while the trailing rule wraps into a separate left-hand row. At 390 px, the button starts at **x=217** rather than aligning with the main Play button; a detached line appears below the left separator. The same arrangement occurs on desktop.

**Fix / validation:** Use a deliberate divider row with line / “or” / line, then a full-width friend action, or deliberately compose a single secondary-action row without the orphan rule. Inspect both 390 px and desktop selection screens. Preserve the friend action's secondary priority and keyboard order. Evidence: `quick-selection-390x844.png`.

### PV07 — fixed homepage CTA overlaps the final mode card

The fixed `.hero-entry` needs bottom clearance (`src/client/styles.css:626`). The 900 px rule supplies 110 px, but the 600 px rule overrides `.home-shell` padding to **54 px** (`src/client/styles.css:649`). The actual fixed bar is **77 px** tall in the captured cases.

**Observed:** At maximum scroll on both **390×844** and **320×568**, the fixed bar covers **22.9 px** of the final Ranked mode card. On the 390 px screenshot its last description line is partly obscured. The large card remains partly visible and clickable; this is not a completely blocked action.

**Fix / validation:** Reserve clearance based on the actual persistent CTA size and safe-area inset in every matching mobile rule. At maximum scroll, require the last mode card, description, and keyboard focus outline to remain clear of the bar. Test text wrapping, actual zoom, and safe-area devices. Evidence: `targeted-checks.json`, `home-bottom-390x844.png`, `home-bottom-320x568.png`.

## Visual assessment beyond individual defects

Keep the blue/coral ownership system, circles/diamonds, coordinate grid, territorial labels, and strong action/result hierarchy. They communicate a tactical game rather than an unrelated dashboard. Ownership is not conveyed only by hue. The light paper/grid surface and dark resource strip provide a coherent identity; a redesign is not required to resolve these findings.

The spacing system is less coherent than the palette. Board sizing is driven by height, other board information by column width, the hero by a viewport-sized region, and mobile content by a long source-order stack. Each rule works locally but their combinations create detached edges, abrupt density changes, and unnecessary travel between related controls. Prioritize relationships—action with target, resource with action cost, result with next choice—before adjusting isolated margins.

A separate **design opportunity**, not an additional confirmed defect: at 1440×900, hero copy ends at about **y=417**, the demo at **y=721**, and mode selection begins at **y=950**. At 390×844, modes begin near **y=1,147**, after the 683 px-tall final-round demo. The primary Start action remains prominent, so below-fold modes do not prevent entry. Reducing the hero's unused vertical space and showing a clearer preview of modes could improve scanning. The advanced 15th-round, 3-Energy demo is mechanically valid, but it should read as a sample tactical situation rather than the normal opening. Validate any change with beginner/power-user playtests rather than assuming fewer pixels guarantees better conversion.

## Priorities and acceptance gates

1. Address the engineering audit's global review-retention leak and guest-session race, then **PV01**. A guest must retain ownership and recover an uncertain creation before layout polish can reliably improve their journey.
2. **PV02/PV04:** arrange decision, waiting, review, and learning handoff as distinct tasks. Acceptance: no measured mobile action → board → Lock scrolling loop; review does not instruct unavailable editing; qualifying continuation choices are together.
3. **PV03:** retain compact rule/availability information. Acceptance: a player can see how to earn Energy and why an action is unavailable without opening a long reference during a timed decision.
4. **PV05–PV07:** align the board information frame, repair friend-divider composition, and clear the fixed CTA. Verify desktop edges, maximum mobile scroll, and focus visibility.
5. Retain the previous audit's focus-contrast fix and verify accessibility alongside these changes. Actual screen-reader, browser zoom, Google/Ranked production, physical-device interruptions, and human playtest gates remain open.

## Limits and changes

This is a single-agent evidence-based audit using Mitch's product/UX synthesis and supporting Impeccable technical checks; it is not a separately invoked formal dual-agent Impeccable critique. No design score is presented because measured defects are more useful here than a composite rating. Impeccable loaded the incumbent code as context; missing PRODUCT.md/DESIGN.md did not justify inventing or changing the product brief. No StyleSeed artifacts were configured or fabricated.

This pass created this report and the local product/visual probe artifacts. Existing work and the engineering audit were preserved. No production mutations were made. The installed Mitch supplemental-reference gaps disclosed in the engineering audit still apply. Physical device ergonomics, real screen-reader output, actual 200% zoom, cross-engine/font behavior, competitive balance, human comprehension, and authenticated production journeys remain unverified.

**Recommended next action:** implement creation recovery and phase-specific responsive layout first, then validate with the measured viewport cases and a short real-player learning session. The findings above are proposals; fixes have not been applied.
